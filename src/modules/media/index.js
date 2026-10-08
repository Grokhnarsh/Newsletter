import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import { slugify } from '../../core/content.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/render.js';
import { now } from '../../lib/time.js';
import { pagination, parseId, validate } from '../../lib/validate.js';
import { isAuthor, requireEditor } from '../../middleware/auth.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MAX_SIZE = 20 * 1024 * 1024;
const MAX_DIMENSION = 2560;
export const VARIANT_WIDTHS = [480, 960, 1600];
const OPTIMIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

// sharp ist optional: ohne das Paket werden Bilder unverändert gespeichert.
let sharpModule;
export async function loadSharp() {
  if (sharpModule === undefined) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

/** Erkennt den Dateityp anhand der Signatur (nicht der Endung) und liest Bildmaße. */
export function sniff(buf) {
  const ascii = (start, end) => buf.subarray(start, end).toString('latin1');
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', ext: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { mime: 'image/gif', ext: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const dims = jpegSize(buf);
    return { mime: 'image/jpeg', ext: 'jpg', ...dims };
  }
  if (buf.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const kind = ascii(12, 16);
    let width = null;
    let height = null;
    if (kind === 'VP8X') {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    } else if (kind === 'VP8 ') {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    return { mime: 'image/webp', ext: 'webp', width, height };
  }
  if (buf.length >= 5 && ascii(0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.length >= 12 && ascii(4, 8) === 'ftyp') return { mime: 'video/mp4', ext: 'mp4' };
  if (buf.length >= 3 && (ascii(0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return { mime: 'audio/mpeg', ext: 'mp3' };
  return null;
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    // SOF0–SOF15 außer DHT (C4), JPG (C8), DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: null, height: null };
}

function shape(row) {
  if (!row) return row;
  const variants = JSON.parse(row.variants || '[]').map((v) => ({ ...v, url: `/uploads/${v.path}` }));
  return { ...row, variants, url: `/uploads/${row.path}`, is_image: row.mime.startsWith('image/') };
}

/** srcset-Attribut aus den Varianten (plus Original als größte Stufe). */
export function srcsetFor(media) {
  if (!media.variants?.length) return '';
  const entries = media.variants.map((v) => `${v.url} ${v.width}w`);
  if (media.width) entries.push(`${media.url} ${media.width}w`);
  return entries.join(', ');
}

export class MediaService {
  constructor(db, uploadsDir) {
    this.db = db;
    this.uploadsDir = uploadsDir;
  }

  list({ q, type }, { page, perPage, offset }) {
    const where = [];
    const params = [];
    if (q) {
      where.push('(original_name LIKE ? OR alt LIKE ? OR title LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (type === 'image') where.push("mime LIKE 'image/%'");
    else if (type === 'document') where.push("mime NOT LIKE 'image/%'");
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get(`SELECT COUNT(*) AS n FROM media ${sql}`, ...params).n;
    const items = this.db.all(`SELECT * FROM media ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, perPage, offset).map(shape);
    return { items, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  find(id) {
    const row = this.db.get('SELECT * FROM media WHERE id = ?', id);
    if (!row) throw notFound('Datei nicht gefunden');
    return shape(row);
  }

  /**
   * Speichert eine Datei. Bilder werden – wenn sharp verfügbar ist – gedreht (EXIF),
   * von Metadaten wie GPS-Koordinaten befreit, auf max. 2560 px verkleinert und
   * zusätzlich als WebP in mehreren Breiten für responsive Bilder abgelegt.
   */
  async create(buffer, originalName, userId) {
    if (!buffer?.length) throw badRequest('Leere Datei');
    if (buffer.length > MAX_SIZE) throw badRequest('Datei zu groß (max. 20 MB)');
    const type = sniff(buffer);
    if (!type) throw badRequest('Dateityp nicht erlaubt (erlaubt: JPG, PNG, GIF, WebP, PDF, MP4, MP3)');
    const date = new Date();
    const folder = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const base = `${slugify(path.parse(originalName || 'datei').name) || 'datei'}-${crypto.randomBytes(4).toString('hex')}`;
    const rel = `${folder}/${base}.${type.ext}`;
    fs.mkdirSync(path.join(this.uploadsDir, folder), { recursive: true });

    let data = buffer;
    let { width = null, height = null } = type;
    let variants = [];
    const sharp = OPTIMIZABLE.has(type.mime) ? await loadSharp() : null;
    if (sharp) {
      try {
        const optimized = await this.optimize(sharp, buffer, type);
        data = optimized.data;
        width = optimized.width;
        height = optimized.height;
        variants = await this.writeVariants(sharp, data, folder, base, width);
      } catch (err) {
        throw badRequest(`Bild konnte nicht verarbeitet werden: ${err.message}`);
      }
    }
    fs.writeFileSync(path.join(this.uploadsDir, rel), data);
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO media (path, original_name, mime, size, width, height, alt, title, variants, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, ?)`,
      rel,
      String(originalName || `${base}.${type.ext}`).slice(0, 255),
      type.mime,
      data.length,
      width ?? null,
      height ?? null,
      JSON.stringify(variants),
      userId ?? null,
      now(),
    );
    return this.find(lastInsertRowid);
  }

  async optimize(sharp, buffer, type) {
    let img = sharp(buffer, { limitInputPixels: 100_000_000 }).rotate();
    img = img.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true });
    if (type.mime === 'image/jpeg') img = img.jpeg({ quality: 82, mozjpeg: true });
    else if (type.mime === 'image/png') img = img.png({ compressionLevel: 9, palette: false });
    else img = img.webp({ quality: 80 });
    // Immer die neu kodierte Fassung verwenden: sie enthält keine Metadaten (z. B. GPS) mehr.
    const { data, info } = await img.toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }

  async writeVariants(sharp, data, folder, base, width) {
    const variants = [];
    for (const w of VARIANT_WIDTHS) {
      if (!width || w >= width) continue;
      const { data: out, info } = await sharp(data).resize({ width: w }).webp({ quality: 78 }).toBuffer({ resolveWithObject: true });
      const rel = `${folder}/${base}-w${w}.webp`;
      fs.writeFileSync(path.join(this.uploadsDir, rel), out);
      variants.push({ width: info.width, height: info.height, path: rel, size: out.length });
    }
    return variants;
  }

  /** Erzeugt Varianten für bereits vorhandene Bilder nach. */
  async optimizeExisting(id) {
    const media = this.find(id);
    const sharp = OPTIMIZABLE.has(media.mime) ? await loadSharp() : null;
    if (!sharp || media.variants.length) return media;
    const file = path.join(this.uploadsDir, media.path);
    const buffer = fs.readFileSync(file);
    const optimized = await this.optimize(sharp, buffer, { mime: media.mime });
    const { dir: folder, name } = path.posix.parse(media.path);
    const variants = await this.writeVariants(sharp, optimized.data, folder, name, optimized.width);
    fs.writeFileSync(file, optimized.data);
    this.db.run('UPDATE media SET size = ?, width = ?, height = ?, variants = ? WHERE id = ?', optimized.data.length, optimized.width, optimized.height, JSON.stringify(variants), id);
    return this.find(id);
  }

  /** Ordnet Bild-URLs ihren Datensätzen zu (für responsive Bilder in der Ausgabe). */
  byUrls(urls) {
    const paths = [...new Set(urls.map((u) => u.replace(/^\/uploads\//, '')))].slice(0, 200);
    if (!paths.length) return new Map();
    const rows = this.db.all(`SELECT * FROM media WHERE path IN (${paths.map(() => '?').join(',')})`, ...paths).map(shape);
    return new Map(rows.map((m) => [m.url, m]));
  }

  update(id, { alt, title }) {
    this.find(id);
    this.db.run('UPDATE media SET alt = COALESCE(?, alt), title = COALESCE(?, title) WHERE id = ?', alt ?? null, title ?? null, id);
    return this.find(id);
  }

  remove(id) {
    const media = this.find(id);
    this.db.run('DELETE FROM media WHERE id = ?', id);
    for (const p of [media.path, ...media.variants.map((v) => v.path)]) fs.rmSync(path.join(this.uploadsDir, p), { force: true });
  }

  stats() {
    return this.db.get('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM media');
  }
}

export default {
  name: 'media',
  label: 'Medien',
  description: 'Medienbibliothek für Bilder, PDFs, Audio und Video mit Upload und Auswahldialog.',
  version: '1.0.0',
  adminDir: path.join(dir, 'admin'),
  // Autoren dürfen hochladen und eigene Dateien bearbeiten
  authors: true,
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE media (
          id INTEGER PRIMARY KEY,
          path TEXT NOT NULL UNIQUE,
          original_name TEXT NOT NULL,
          mime TEXT NOT NULL,
          size INTEGER NOT NULL,
          width INTEGER,
          height INTEGER,
          alt TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        );
      `,
    },
    {
      version: 2,
      sql: "ALTER TABLE media ADD COLUMN variants TEXT NOT NULL DEFAULT '[]';",
    },
  ],

  setup(ctx) {
    ctx.media = new MediaService(ctx.db, ctx.config.uploadsDir);
    // Responsive Bilder: <img> mit Upload-Pfad erhält srcset, sizes, Maße und Lazy Loading
    ctx.hooks.on(
      'site.content',
      (html) => {
        const urls = [...html.matchAll(/<img\b[^>]*?\ssrc="(\/uploads\/[^"]+)"/gi)].map((m) => m[1]);
        if (!urls.length) return html;
        const media = ctx.media.byUrls(urls);
        return html.replace(/<img\b([^>]*?)\ssrc="(\/uploads\/[^"]+)"([^>]*)>/gi, (tag, before, src, after) => {
          const m = media.get(src);
          if (!m) return tag;
          const attrs = `${before} ${after}`;
          let extra = '';
          const srcset = srcsetFor(m);
          if (srcset && !/\ssrcset=/i.test(attrs)) extra += ` srcset="${srcset}" sizes="(max-width: 800px) 100vw, 800px"`;
          if (m.width && !/\swidth=/i.test(attrs)) extra += ` width="${m.width}" height="${m.height}"`;
          if (!/\sloading=/i.test(attrs)) extra += ' loading="lazy" decoding="async"';
          if (!/\salt=/i.test(attrs)) extra += ` alt="${escapeHtml(m.alt)}"`;
          return `<img${before} src="${src}"${extra}${after}>`;
        });
      },
      { module: 'media' },
    );
    ctx.hooks.on('admin.dashboard', () => ({ media: ctx.media.stats() }), { module: 'media' });
  },

  api(router, ctx) {
    const r = Router();
    r.get('/', (req, res) => res.json(ctx.media.list(req.query, pagination(req.query, { defaultPerPage: 40 }))));
    r.post('/', express.raw({ type: () => true, limit: MAX_SIZE }), async (req, res) => {
      let name = req.get('x-filename') || '';
      try {
        name = decodeURIComponent(name);
      } catch {
        /* Rohwert verwenden */
      }
      res.status(201).json(await ctx.media.create(req.body, name, req.user?.id));
    });
    // Varianten für ältere Bilder nachträglich erzeugen
    r.post('/optimize', requireEditor, async (req, res) => {
      const ids = ctx.db.all("SELECT id FROM media WHERE mime IN ('image/jpeg', 'image/png', 'image/webp') AND variants = '[]'").map((m) => m.id);
      let done = 0;
      for (const id of ids) {
        try {
          if ((await ctx.media.optimizeExisting(id)).variants.length) done++;
        } catch (err) {
          ctx.logger.warn(`[media] Bild ${id} konnte nicht optimiert werden: ${err.message}`);
        }
      }
      res.json({ checked: ids.length, optimized: done, available: Boolean(await loadSharp()) });
    });
    r.get('/:id', (req, res) => res.json(ctx.media.find(parseId(req.params.id))));
    // Autoren ändern und löschen nur ihre eigenen Uploads
    const own = (req) => {
      const m = ctx.media.find(parseId(req.params.id));
      if (isAuthor(req) && m.created_by !== req.user?.id) throw forbidden('Autoren können nur eigene Dateien ändern');
      return m;
    };
    r.put('/:id', (req, res) => {
      const data = validate(req.body, { alt: { type: 'string', max: 300 }, title: { type: 'string', max: 300 } }, { partial: true });
      res.json(ctx.media.update(own(req).id, data));
    });
    r.delete('/:id', (req, res) => {
      ctx.media.remove(own(req).id);
      res.status(204).end();
    });
    router.use('/media', r);
  },

  publicRoutes(router, ctx) {
    router.use(
      '/uploads',
      express.static(ctx.config.uploadsDir, {
        maxAge: '30d',
        immutable: true,
        index: false,
        dotfiles: 'deny',
        setHeaders: (res) => res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"),
      }),
    );
  },
};
