import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express, { Router } from 'express';
import { escapeHtml } from '../lib/render.js';
import { SAFE_URL } from '../lib/validate.js';

/**
 * Öffentliche Website: lädt das Theme und rendert Ansichten in dessen Layout.
 * Module liefern Inhalte über Hooks:
 *   site.home      (req) → Ansicht | undefined   – Startseite
 *   site.menu      (location) → [{label, url, children}]
 *   site.head      (req) → HTML für <head>
 *   site.widgets   (area, req) → HTML für Widget-Bereiche (z. B. 'footer')
 *   site.sitemap   () → [{ loc, lastmod }]
 *   site.search    (query) → [{ title, url, excerpt, type }]
 */
export class SiteService {
  constructor({ config, settings, hooks, content, logger = console }) {
    Object.assign(this, { config, settings, hooks, content, logger });
    this.theme = null;
  }

  async loadTheme(name = 'default') {
    const dirs = [path.join(this.config.root, 'themes', name), path.join(this.config.root, 'src', 'themes', name)];
    const dir = dirs.find((d) => fs.existsSync(path.join(d, 'index.js')));
    if (!dir) throw new Error(`Theme ${name} nicht gefunden`);
    this.theme = (await import(pathToFileURL(path.join(dir, 'index.js')).href)).default;
    this.theme.dir = dir;
    return this.theme;
  }

  url(p = '/') {
    return `${this.config.baseUrl}${p.startsWith('/') ? p : `/${p}`}`;
  }

  menu(location) {
    return this.hooks.first('site.menu', location) || [];
  }

  /** Rendert eine Ansicht im Theme-Layout. */
  render(req, view) {
    const s = this.settings.all();
    const pathName = req?.path || '/';
    return this.theme.layout({
      site: {
        name: s.site_name,
        tagline: s.site_tagline,
        description: s.site_description,
        logo: s.theme_logo_url,
        accent: s.theme_accent_color,
        footerText: s.theme_footer_text,
        companyAddress: s.company_address,
        privacyUrl: s.privacy_url,
        imprintUrl: s.imprint_url,
        baseUrl: this.config.baseUrl,
        year: new Date().getFullYear(),
      },
      title: view.title || '',
      fullTitle: view.isHome ? `${s.site_name}${s.site_tagline ? ` – ${s.site_tagline}` : ''}` : `${view.title} – ${s.site_name}`,
      description: view.description || s.site_description || '',
      canonical: view.canonical || this.url(pathName),
      image: view.image || '',
      type: view.type || 'website',
      noindex: Boolean(view.noindex),
      bodyClass: view.bodyClass || '',
      isHome: Boolean(view.isHome),
      currentPath: pathName,
      content: this.hooks.filter('site.content', view.content || '', req),
      menus: { main: this.menu('main'), footer: this.menu('footer') },
      head: this.hooks.collect('site.head', req).join('\n'),
      widgets: {
        top: this.hooks.collect('site.widgets', 'top', req).join('\n'),
        footer: this.hooks.collect('site.widgets', 'footer', req).join('\n'),
      },
      escape: escapeHtml,
    });
  }

  send(req, res, view) {
    res.status(view.status || 200).type('html').send(this.render(req, view));
  }

  /** Einfache Meldungsseite (z. B. „Anmeldung bestätigt“). */
  message(req, res, { title, message, tone = '', status = 200, html = '' }) {
    this.send(req, res, {
      title,
      status,
      noindex: true,
      bodyClass: 'narrow',
      content: `<div class="panel"><h1 class="${tone}">${escapeHtml(title)}</h1>${message ? `<p>${escapeHtml(message)}</p>` : ''}${html}</div>`,
    });
  }

  notFound(req, res) {
    if (req.method === 'GET') this.hooks.collect('site.not_found', req);
    this.send(req, res, {
      title: 'Seite nicht gefunden',
      status: 404,
      noindex: true,
      content: `<div class="panel"><h1>Seite nicht gefunden</h1><p>Die angeforderte Seite existiert nicht (mehr).</p>
        <form class="search-form" action="/suche" method="get"><input type="search" name="q" placeholder="Website durchsuchen …" aria-label="Suche"><button type="submit">Suchen</button></form>
        <p><a href="/">Zur Startseite</a></p></div>`,
    });
  }

  /** Kernrouten der Website: Theme-Assets, Startseite, Suche, Sitemap, robots.txt. */
  routes() {
    const router = Router();
    router.use('/theme', express.static(path.join(this.theme.dir, 'assets'), { maxAge: this.config.env === 'production' ? '1d' : 0 }));

    router.get('/', (req, res) => {
      const view = this.hooks.first('site.home', req);
      if (view) return this.send(req, res, { ...view, isHome: true });
      const s = this.settings.all();
      this.send(req, res, {
        isHome: true,
        title: s.site_name,
        content: `<section class="hero"><h1>${escapeHtml(s.site_name)}</h1>${s.site_tagline ? `<p class="lead">${escapeHtml(s.site_tagline)}</p>` : ''}
          <p>Willkommen! Lege im <a href="/admin/">Admin-Bereich</a> eine Startseite fest oder veröffentliche Inhalte.</p></section>`,
      });
    });

    router.get('/suche', (req, res) => {
      const q = String(req.query.q || '').trim().slice(0, 100);
      const results = q.length >= 2 ? this.hooks.collect('site.search', q) : [];
      this.send(req, res, {
        title: q ? `Suche: ${q}` : 'Suche',
        noindex: true,
        content: `<div class="panel"><h1>Suche</h1>
          <form class="search-form" action="/suche" method="get"><input type="search" name="q" value="${escapeHtml(q)}" placeholder="Suchbegriff …" aria-label="Suchbegriff" autofocus><button type="submit">Suchen</button></form>
          ${
            q.length >= 2
              ? results.length
                ? `<p class="muted">${results.length} Treffer</p><ul class="search-results">${results
                    .map(
                      (r) =>
                        `<li><span class="tag">${escapeHtml(r.type)}</span> <a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a>${r.excerpt ? `<p>${escapeHtml(r.excerpt)}</p>` : ''}</li>`,
                    )
                    .join('')}</ul>`
                : '<p>Keine Treffer gefunden.</p>'
              : q
                ? '<p class="muted">Bitte mindestens zwei Zeichen eingeben.</p>'
                : ''
          }</div>`,
      });
    });

    router.get('/sitemap.xml', (req, res) => {
      const entries = [{ loc: this.url('/') }, ...this.hooks.collect('site.sitemap')];
      const seen = new Set();
      const xml = entries
        .filter((e) => !seen.has(e.loc) && seen.add(e.loc))
        .map((e) => `  <url><loc>${escapeHtml(e.loc)}</loc>${e.lastmod ? `<lastmod>${escapeHtml(e.lastmod.slice(0, 10))}</lastmod>` : ''}</url>`)
        .join('\n');
      res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xml}\n</urlset>\n`);
    });

    router.get('/robots.txt', (req, res) => {
      res.type('text/plain').send(`User-agent: *\nDisallow: /admin/\nDisallow: /api/\nSitemap: ${this.url('/sitemap.xml')}\n`);
    });

    return router;
  }
}

export const SITE_SETTINGS = {
  defaults: {
    site_name: 'Meine Website',
    site_tagline: '',
    site_description: '',
    company_address: '',
    privacy_url: '',
    imprint_url: '',
    theme_accent_color: '#2a78d6',
    theme_logo_url: '',
    theme_footer_text: '',
  },
  rules: {
    site_name: { type: 'string', max: 200 },
    site_tagline: { type: 'string', max: 300 },
    site_description: { type: 'string', max: 500 },
    company_address: { type: 'string', max: 2000 },
    privacy_url: { type: 'string', max: 500, ...SAFE_URL },
    imprint_url: { type: 'string', max: 500, ...SAFE_URL },
    theme_accent_color: { type: 'string', max: 7, pattern: /^#[0-9a-fA-F]{6}$/, patternMessage: 'Farbe im Format #RRGGBB' },
    theme_logo_url: { type: 'string', max: 500, ...SAFE_URL },
    theme_footer_text: { type: 'string', max: 1000 },
  },
};
