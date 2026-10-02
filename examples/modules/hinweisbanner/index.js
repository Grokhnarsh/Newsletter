/**
 * Beispielmodul „Hinweisbanner“: zeigt einen konfigurierbaren Hinweis oberhalb
 * des Inhalts jeder Seite. Zum Aktivieren den Ordner nach `modules/` kopieren
 * (oder MODULES_DIR auf `examples/modules` setzen) und den Server neu starten.
 *
 * Es zeigt die wichtigsten Erweiterungspunkte:
 *   - eigene Einstellungen (mit Validierung)
 *   - eine eigene Tabelle per Migration
 *   - Hooks der Website (site.widgets)
 *   - eine authentifizierte API-Route
 *   - ein Admin-Skript mit Einstellungs-Tab und Dashboard-Kachel
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Externe Module bringen kleine Hilfen selbst mit (oder importieren sie aus src/lib/).
const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export default {
  name: 'hinweisbanner',
  label: 'Hinweisbanner',
  description: 'Beispielmodul: Hinweis über dem Seiteninhalt (z. B. Aktionen, Öffnungszeiten).',
  version: '1.0.0',
  defaultEnabled: true,
  adminDir: path.join(dir, 'admin'),

  settings: {
    defaults: { banner_text: '', banner_link_url: '', banner_link_label: 'Mehr erfahren' },
    rules: {
      banner_text: { type: 'string', max: 300 },
      banner_link_url: { type: 'string', max: 500, pattern: /^(https?:\/\/|\/)/, patternMessage: 'Muss mit https:// oder / beginnen' },
      banner_link_label: { type: 'string', max: 60 },
    },
  },

  migrations: [
    {
      version: 1,
      sql: `CREATE TABLE banner_clicks (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL);`,
    },
  ],

  setup(ctx) {
    ctx.hooks.on(
      'site.widgets',
      (area) => {
        if (area !== 'top') return undefined;
        const s = ctx.settings.all();
        if (!s.banner_text) return undefined;
        const link = s.banner_link_url ? `<a href="/banner/klick">${escapeHtml(s.banner_link_label)} →</a>` : '';
        return `<div class="notice-banner" role="note">${escapeHtml(s.banner_text)}${link}</div>`;
      },
      { module: 'hinweisbanner' },
    );
    ctx.hooks.on(
      'admin.dashboard',
      () => ({ hinweisbanner: ctx.db.get('SELECT COUNT(*) AS clicks FROM banner_clicks') }),
      { module: 'hinweisbanner' },
    );
  },

  // Öffentliche Route: zählt Klicks und leitet weiter
  publicRoutes(router, ctx) {
    router.get('/banner/klick', (req, res) => {
      const url = ctx.settings.get('banner_link_url');
      if (!url) return res.redirect('/');
      ctx.db.run('INSERT INTO banner_clicks (created_at) VALUES (?)', new Date().toISOString());
      res.redirect(302, url);
    });
  },

  // Authentifizierte API unter /api
  api(router, ctx) {
    router.get('/hinweisbanner/stats', (req, res) => {
      res.json(ctx.db.get('SELECT COUNT(*) AS clicks FROM banner_clicks'));
    });
  },
};
