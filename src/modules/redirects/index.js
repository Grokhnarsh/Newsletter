import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { now } from '../../lib/time.js';
import { pagination, parseId, validate } from '../../lib/validate.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const MAX_NOT_FOUND = 500;
const CODES = [301, 302, 410];

/** Normalisiert einen Pfad: führender Schrägstrich, ohne Abfrage und ohne abschließenden Schrägstrich. */
export function normalizePath(value) {
  let p = String(value ?? '').trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return '';
    }
  }
  p = p.split(/[?#]/)[0];
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p.replace(/\/{2,}/g, '/');
}

export class RedirectService {
  constructor(db) {
    this.db = db;
  }

  list({ q }, { page, perPage, offset }) {
    const where = q ? 'WHERE source LIKE ? OR target LIKE ?' : '';
    const params = q ? [`%${q}%`, `%${q}%`] : [];
    const total = this.db.get(`SELECT COUNT(*) AS n FROM redirects ${where}`, ...params).n;
    const items = this.db
      .all(`SELECT * FROM redirects ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`, ...params, perPage, offset)
      .map((r) => ({ ...r, auto: Boolean(r.auto) }));
    return { items, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  find(id) {
    const row = this.db.get('SELECT * FROM redirects WHERE id = ?', id);
    if (!row) throw notFound('Weiterleitung nicht gefunden');
    return { ...row, auto: Boolean(row.auto) };
  }

  clean(data) {
    const source = normalizePath(data.source);
    if (!source || source === '/' || source.startsWith('/admin') || source.startsWith('/api')) {
      throw badRequest('Validierung fehlgeschlagen', { source: 'Ungültige Quell-Adresse' });
    }
    const code = data.code ?? 301;
    let target = String(data.target ?? '').trim();
    if (code !== 410) {
      if (/^https?:\/\//i.test(target)) {
        try {
          target = new URL(target).toString();
        } catch {
          throw badRequest('Validierung fehlgeschlagen', { target: 'Ungültige Ziel-Adresse' });
        }
      } else if (target.startsWith('/')) {
        if (target.startsWith('//')) throw badRequest('Validierung fehlgeschlagen', { target: 'Ungültige Ziel-Adresse' });
      } else {
        throw badRequest('Validierung fehlgeschlagen', { target: 'Ziel muss mit / oder https:// beginnen' });
      }
      if (normalizePath(target) === source && target.startsWith('/')) throw badRequest('Quelle und Ziel sind identisch');
    } else {
      target = '';
    }
    return { source, target, code, note: data.note ?? '' };
  }

  save(id, data, { auto = false } = {}) {
    const d = this.clean(data);
    const clash = this.db.get('SELECT id FROM redirects WHERE source = ? AND id != ?', d.source, id ?? 0);
    if (clash) throw conflict('Für diese Adresse gibt es bereits eine Weiterleitung', { source: 'bereits vorhanden' });
    const t = now();
    if (id) {
      this.find(id);
      this.db.run('UPDATE redirects SET source = ?, target = ?, code = ?, note = ?, auto = 0, updated_at = ? WHERE id = ?', d.source, d.target, d.code, d.note, t, id);
      this.db.run('DELETE FROM redirect_misses WHERE path = ?', d.source);
      return this.find(id);
    }
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO redirects (source, target, code, note, auto, hits, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      d.source, d.target, d.code, d.note, auto ? 1 : 0, t, t,
    );
    this.db.run('DELETE FROM redirect_misses WHERE path = ?', d.source);
    return this.find(lastInsertRowid);
  }

  remove(id) {
    this.find(id);
    this.db.run('DELETE FROM redirects WHERE id = ?', id);
  }

  /**
   * Inhalte haben eine neue Adresse: alte Adresse weiterleiten, bestehende Ketten auf das
   * neue Ziel verkürzen und eine Weiterleitung entfernen, die das neue Ziel überdecken würde.
   */
  contentMoved(moves) {
    this.db.transaction(() => {
      for (const { from, to } of moves) {
        const t = now();
        this.db.run('DELETE FROM redirects WHERE source = ?', to);
        this.db.run('UPDATE redirects SET target = ?, updated_at = ? WHERE target = ?', to, t, from);
        const existing = this.db.get('SELECT id FROM redirects WHERE source = ?', from);
        if (existing) this.db.run('UPDATE redirects SET target = ?, code = 301, updated_at = ? WHERE id = ?', to, t, existing.id);
        else this.db.run("INSERT INTO redirects (source, target, code, note, auto, hits, created_at, updated_at) VALUES (?, ?, 301, '', 1, 0, ?, ?)", from, to, t, t);
        this.db.run('DELETE FROM redirect_misses WHERE path = ?', from);
      }
    });
  }

  /** Passende Weiterleitung für einen Pfad (exakt oder per Platzhalter „/alt/*“). */
  match(requestPath) {
    const p = normalizePath(requestPath);
    let row = this.db.get('SELECT * FROM redirects WHERE source = ?', p);
    let rest = '';
    if (!row) {
      const wildcards = this.db.all("SELECT * FROM redirects WHERE source LIKE '%/*' ORDER BY length(source) DESC");
      for (const w of wildcards) {
        const prefix = w.source.slice(0, -2);
        if (p === prefix || p.startsWith(`${prefix}/`)) {
          row = w;
          rest = p.slice(prefix.length);
          break;
        }
      }
    }
    if (!row) return null;
    this.db.run('UPDATE redirects SET hits = hits + 1, last_hit_at = ? WHERE id = ?', now(), row.id);
    let target = row.target;
    if (target.endsWith('/*')) target = target.slice(0, -2) + rest;
    return { code: row.code, target };
  }

  // ---- 404-Protokoll ----

  recordMiss(requestPath, referrer) {
    const p = normalizePath(requestPath);
    if (!p || p.length > 300 || /\.(php|asp|env|git|sql|bak)\b|wp-/i.test(p)) return; // typische Scanner-Anfragen ignorieren
    this.db.run(
      `INSERT INTO redirect_misses (path, hits, referrer, last_seen) VALUES (?, 1, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hits = hits + 1, referrer = COALESCE(excluded.referrer, referrer), last_seen = excluded.last_seen`,
      p,
      referrer ? String(referrer).slice(0, 300) : null,
      now(),
    );
    const count = this.db.get('SELECT COUNT(*) AS n FROM redirect_misses').n;
    if (count > MAX_NOT_FOUND) {
      this.db.run('DELETE FROM redirect_misses WHERE path IN (SELECT path FROM redirect_misses ORDER BY last_seen LIMIT ?)', count - MAX_NOT_FOUND);
    }
  }

  misses() {
    return this.db.all('SELECT * FROM redirect_misses ORDER BY hits DESC, last_seen DESC LIMIT 200');
  }

  clearMiss(p) {
    this.db.run('DELETE FROM redirect_misses WHERE path = ?', p);
  }
}

const schema = {
  source: { type: 'string', required: true, max: 500 },
  target: { type: 'string', max: 1000 },
  code: { type: 'enum', values: CODES, default: 301 },
  note: { type: 'string', max: 300 },
};

export default {
  name: 'redirects',
  label: 'Weiterleitungen',
  description: 'Weiterleitungen (301/302/410), automatisch bei geänderten Adressen, mit Protokoll nicht gefundener Seiten.',
  version: '1.0.0',
  adminDir: path.join(dir, 'admin'),
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE redirects (
          id INTEGER PRIMARY KEY,
          source TEXT NOT NULL UNIQUE,
          target TEXT NOT NULL DEFAULT '',
          code INTEGER NOT NULL DEFAULT 301,
          note TEXT NOT NULL DEFAULT '',
          auto INTEGER NOT NULL DEFAULT 0,
          hits INTEGER NOT NULL DEFAULT 0,
          last_hit_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE redirect_misses (
          path TEXT PRIMARY KEY,
          hits INTEGER NOT NULL DEFAULT 1,
          referrer TEXT,
          last_seen TEXT NOT NULL
        );
      `,
    },
  ],

  setup(ctx) {
    ctx.redirects = new RedirectService(ctx.db);
    const opts = { module: 'redirects' };
    ctx.hooks.on('content.moved', (moves) => ctx.redirects.contentMoved(moves), opts);
    ctx.hooks.on('site.not_found', (req) => ctx.redirects.recordMiss(req.path, req.get('referer')), opts);
    ctx.hooks.on('admin.dashboard', () => ({ redirects: { misses: ctx.db.get('SELECT COUNT(*) AS n FROM redirect_misses').n } }), opts);
  },

  api(router, ctx) {
    const r = Router();
    r.get('/', (req, res) => res.json(ctx.redirects.list(req.query, pagination(req.query, { defaultPerPage: 50 }))));
    r.post('/', (req, res) => res.status(201).json(ctx.redirects.save(null, validate(req.body, schema))));
    r.get('/misses', (req, res) => res.json(ctx.redirects.misses()));
    r.delete('/misses', (req, res) => {
      ctx.redirects.clearMiss(String(req.query.path || ''));
      res.status(204).end();
    });
    r.put('/:id', (req, res) => res.json(ctx.redirects.save(parseId(req.params.id), validate(req.body, schema))));
    r.delete('/:id', (req, res) => {
      ctx.redirects.remove(parseId(req.params.id));
      res.status(204).end();
    });
    router.use('/redirects', r);
  },

  // Nach den Seiten: nur Adressen, die sonst nichts gefunden hätten
  fallbackRoutes(router, ctx) {
    router.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const hit = ctx.redirects.match(req.path);
      if (!hit) return next();
      if (hit.code === 410) {
        return ctx.site.message(req, res, { title: 'Nicht mehr verfügbar', message: 'Diese Seite wurde dauerhaft entfernt.', status: 410 });
      }
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      res.redirect(hit.code, hit.target.includes('?') ? hit.target : hit.target + query);
    });
  },
};
