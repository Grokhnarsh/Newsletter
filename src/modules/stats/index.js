import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';

const dir = path.dirname(fileURLToPath(import.meta.url));
const BOT_RE = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|httpclient|headless|lighthouse|pingdom|scan|facebookexternalhit|embedly/i;
const RETENTION_DAYS = 730;

const today = (d = new Date()) => d.toISOString().slice(0, 10);

export function deviceOf(ua) {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'Tablet';
  if (/Mobi|iPhone|Android|IEMobile|Opera Mini/i.test(ua)) return 'Smartphone';
  return 'Desktop';
}

/**
 * Datenschutzfreundliche Besucherstatistik ohne Cookies: gespeichert werden nur
 * Tageszählungen. Eindeutige Besucher werden über einen täglich wechselnden,
 * nur im Arbeitsspeicher gehaltenen Schlüssel gezählt – IP-Adressen werden nie gespeichert.
 */
export class StatsService {
  constructor({ db, config }) {
    this.db = db;
    this.ownHost = (() => {
      try {
        return new URL(config.baseUrl).host;
      } catch {
        return '';
      }
    })();
    this.salt = { day: '', value: '' };
    this.lastPurge = '';
  }

  daySalt(day) {
    if (this.salt.day !== day) this.salt = { day, value: crypto.randomBytes(16).toString('hex') };
    return this.salt.value;
  }

  record(req, res) {
    if (res.statusCode !== 200 || !String(res.get('Content-Type') || '').startsWith('text/html')) return;
    const ua = req.get('user-agent') || '';
    if (!ua || BOT_RE.test(ua)) return;
    const pathName = req.originalUrl.split('?')[0].slice(0, 300);
    if (/^\/(admin|api|uploads|theme|t\/|view\/|unsubscribe|preferences|confirm)/.test(pathName)) return;
    const day = today();
    this.purge(day);

    const visitor = crypto.createHash('sha256').update(`${this.daySalt(day)}|${req.ip}|${ua}`).digest('base64url').slice(0, 16);
    const isNew = this.db.run('INSERT OR IGNORE INTO stats_visitors (day, hash) VALUES (?, ?)', day, visitor).changes > 0;
    this.db.run(
      `INSERT INTO stats_days (day, views, visitors) VALUES (?, 1, ?)
       ON CONFLICT(day) DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors`,
      day,
      isNew ? 1 : 0,
    );
    this.db.run('INSERT INTO stats_pages (day, path, views) VALUES (?, ?, 1) ON CONFLICT(day, path) DO UPDATE SET views = views + 1', day, pathName);
    if (isNew) {
      this.db.run('INSERT INTO stats_devices (day, device, visitors) VALUES (?, ?, 1) ON CONFLICT(day, device) DO UPDATE SET visitors = visitors + 1', day, deviceOf(ua));
    }
    const referrer = req.get('referer');
    if (referrer) {
      try {
        const host = new URL(referrer).host.replace(/^www\./, '');
        if (host && host !== this.ownHost.replace(/^www\./, '')) {
          this.db.run('INSERT INTO stats_referrers (day, host, views) VALUES (?, ?, 1) ON CONFLICT(day, host) DO UPDATE SET views = views + 1', day, host.slice(0, 200));
        }
      } catch {
        /* ungültiger Referer */
      }
    }
  }

  /** Besucher-Schlüssel vom Vortag löschen; alte Tageswerte nach zwei Jahren entfernen. */
  purge(day) {
    if (this.lastPurge === day) return;
    this.lastPurge = day;
    this.db.run('DELETE FROM stats_visitors WHERE day < ?', day);
    const cutoff = today(new Date(Date.now() - RETENTION_DAYS * 86400_000));
    for (const table of ['stats_days', 'stats_pages', 'stats_referrers', 'stats_devices']) this.db.run(`DELETE FROM ${table} WHERE day < ?`, cutoff);
  }

  report(days = 30) {
    const since = today(new Date(Date.now() - (days - 1) * 86400_000));
    const rows = new Map(this.db.all('SELECT * FROM stats_days WHERE day >= ?', since).map((r) => [r.day, r]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = today(new Date(Date.now() - i * 86400_000));
      series.push({ day, views: rows.get(day)?.views || 0, visitors: rows.get(day)?.visitors || 0 });
    }
    const top = (table, col, metric) =>
      this.db.all(`SELECT ${col} AS key, SUM(${metric}) AS n FROM ${table} WHERE day >= ? GROUP BY ${col} ORDER BY n DESC LIMIT 10`, since);
    return {
      days: series,
      totals: { views: series.reduce((a, d) => a + d.views, 0), visitors: series.reduce((a, d) => a + d.visitors, 0) },
      pages: top('stats_pages', 'path', 'views'),
      referrers: top('stats_referrers', 'host', 'views'),
      devices: top('stats_devices', 'device', 'visitors'),
    };
  }
}

export default {
  name: 'stats',
  label: 'Statistik',
  description: 'Besucherstatistik ohne Cookies und ohne Speicherung von IP-Adressen: Aufrufe, Besucher, Top-Seiten, Herkunft, Geräte.',
  version: '1.0.0',
  adminDir: path.join(dir, 'admin'),
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE stats_days (day TEXT PRIMARY KEY, views INTEGER NOT NULL DEFAULT 0, visitors INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE stats_pages (day TEXT NOT NULL, path TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path));
        CREATE TABLE stats_referrers (day TEXT NOT NULL, host TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, host));
        CREATE TABLE stats_devices (day TEXT NOT NULL, device TEXT NOT NULL, visitors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, device));
        CREATE TABLE stats_visitors (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash));
      `,
    },
  ],

  setup(ctx) {
    ctx.siteStats = new StatsService(ctx);
    const opts = { module: 'stats' };
    ctx.hooks.on('site.pageview', (req, res) => ctx.siteStats.record(req, res), opts);
    ctx.hooks.on(
      'admin.dashboard',
      () => {
        const r = ctx.siteStats.report(30);
        return { stats: { views: r.totals.views, visitors: r.totals.visitors, days: r.days } };
      },
      opts,
    );
  },

  api(router, ctx) {
    const r = Router();
    r.get('/', (req, res) => {
      const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
      res.json(ctx.siteStats.report(days));
    });
    router.use('/analytics', r);
  },
};
