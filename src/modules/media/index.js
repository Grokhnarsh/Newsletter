import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import { slugify } from '../../core/content.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { now } from '../../lib/time.js';
import { pagination, parseId, validate } from '../../lib/validate.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MAX_SIZE = 20 * 1024 * 1024;

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
  return row && { ...row, url: `/uploads/${row.path}`, is_image: row.mime.startsWith('image/') };
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

  create(buffer, originalName, userId) {
    if (!buffer?.length) throw badRequest('Leere Datei');
    if (buffer.length > MAX_SIZE) throw badRequest('Datei zu groß (max. 20 MB)');
    const type = sniff(buffer);
    if (!type) throw badRequest('Dateityp nicht erlaubt (erlaubt: JPG, PNG, GIF, WebP, PDF, MP4, MP3)');
    const date = new Date();
    const folder = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    const base = slugify(path.parse(originalName || 'datei').name) || 'datei';
    const fileName = `${base}-${crypto.randomBytes(4).toString('hex')}.${type.ext}`;
    const rel = `${folder}/${fileName}`;
    fs.mkdirSync(path.join(this.uploadsDir, folder), { recursive: true });
    fs.writeFileSync(path.join(this.uploadsDir, rel), buffer);
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO media (path, original_name, mime, size, width, height, alt, title, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
      rel,
      String(originalName || fileName).slice(0, 255),
      type.mime,
      buffer.length,
      type.width ?? null,
      type.height ?? null,
      userId ?? null,
      now(),
    );
    return this.find(lastInsertRowid);
  }

  update(id, { alt, title }) {
    this.find(id);
    this.db.run('UPDATE media SET alt = COALESCE(?, alt), title = COALESCE(?, title) WHERE id = ?', alt ?? null, title ?? null, id);
    return this.find(id);
  }

  remove(id) {
    const media = this.find(id);
    this.db.run('DELETE FROM media WHERE id = ?', id);
    fs.rmSync(path.join(this.uploadsDir, media.path), { force: true });
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
  ],

  setup(ctx) {
    ctx.media = new MediaService(ctx.db, ctx.config.uploadsDir);
    ctx.hooks.on('admin.dashboard', () => ({ media: ctx.media.stats() }), { module: 'media' });
  },

  api(router, ctx) {
    const r = Router();
    r.get('/', (req, res) => res.json(ctx.media.list(req.query, pagination(req.query, { defaultPerPage: 40 }))));
    r.post('/', express.raw({ type: () => true, limit: MAX_SIZE }), (req, res) => {
      let name = req.get('x-filename') || '';
      try {
        name = decodeURIComponent(name);
      } catch {
        /* Rohwert verwenden */
      }
      res.status(201).json(ctx.media.create(req.body, name, req.user?.id));
    });
    r.get('/:id', (req, res) => res.json(ctx.media.find(parseId(req.params.id))));
    r.put('/:id', (req, res) => {
      const data = validate(req.body, { alt: { type: 'string', max: 300 }, title: { type: 'string', max: 300 } }, { partial: true });
      res.json(ctx.media.update(parseId(req.params.id), data));
    });
    r.delete('/:id', (req, res) => {
      ctx.media.remove(parseId(req.params.id));
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
