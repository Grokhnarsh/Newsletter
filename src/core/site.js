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

  menu(location, lang) {
    return this.hooks.first('site.menu', location, lang) || [];
  }

  /**
   * Sprachumschalter und hreflang-Verweise. `view.alternates` ([{ lang, url }]) nennt
   * Übersetzungen des aktuellen Inhalts; sonst führt der Umschalter zur Startseite der Sprache.
   */
  languageLinks(req, view) {
    const i18n = this.i18n;
    if (!i18n?.isMulti()) return { languages: [], hreflang: '' };
    const lang = req?.lang || i18n.defaultLang();
    const alternates = new Map((view.alternates || []).map((a) => [a.lang, a.url]));
    const languages = i18n.languages().map((code) => ({
      code,
      label: i18n.label(code),
      url: alternates.get(code) || i18n.path('/', code),
      current: code === lang,
      translated: alternates.has(code),
    }));
    const hreflang = view.alternates?.length > 1 && !view.noindex
      ? [...alternates]
          .map(([code, url]) => `<link rel="alternate" hreflang="${escapeHtml(code)}" href="${escapeHtml(this.url(url))}">`)
          .concat(alternates.has(i18n.defaultLang()) ? [`<link rel="alternate" hreflang="x-default" href="${escapeHtml(this.url(alternates.get(i18n.defaultLang())))}">`] : [])
          .join('\n')
      : '';
    return { languages, hreflang };
  }

  /** Text des Themes in der Sprache der Anfrage. */
  t(req, key) {
    return this.i18n ? this.i18n.t(req?.lang || this.i18n.defaultLang(), key) : key;
  }

  /** Pfad in der Sprache der Anfrage (z. B. '/' → '/en'). */
  localPath(req, p) {
    return this.i18n ? this.i18n.path(p, req?.lang) : p;
  }

  /** Rendert eine Ansicht im Theme-Layout. */
  render(req, view) {
    const s = this.settings.all();
    const pathName = req?.originalUrl?.split('?')[0] || req?.path || '/';
    const lang = req?.lang || this.i18n?.defaultLang() || 'de';
    const { languages, hreflang } = this.languageLinks(req, view);
    return this.theme.layout({
      lang,
      languages,
      homeUrl: this.localPath(req, '/'),
      searchUrl: this.localPath(req, '/suche'),
      t: (key) => this.t(req, key),
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
      menus: { main: this.menu('main', lang), footer: this.menu('footer', lang) },
      head: [hreflang, ...this.hooks.collect('site.head', req)].filter(Boolean).join('\n'),
      widgets: {
        top: this.hooks.collect('site.widgets', 'top', req).join('\n'),
        footer: this.hooks.collect('site.widgets', 'footer', req).join('\n'),
      },
      escape: escapeHtml,
    });
  }

  send(req, res, view) {
    const status = view.status || 200;
    // Nur allgemeine, nicht personalisierte Seiten dürfen zwischengespeichert werden
    if (status === 200 && !view.noindex && view.cache !== false) res.locals.cacheable = true;
    res.status(status).type('html').send(this.render(req, view));
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
    const t = (k) => escapeHtml(this.t(req, k));
    this.send(req, res, {
      title: this.t(req, 'notFound'),
      status: 404,
      noindex: true,
      content: `<div class="panel"><h1>${t('notFound')}</h1><p>${t('notFoundText')}</p>
        <form class="search-form" action="/suche" method="get"><input type="search" name="q" placeholder="${t('search')}" aria-label="${t('searchLabel')}"><button type="submit">${t('searchButton')}</button></form>
        <p><a href="${escapeHtml(this.localPath(req, '/'))}">${t('toHome')}</a></p></div>`,
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
      // Volltextindex plus Treffer von Modulen, die eigene Suchen anbieten
      const all =
        q.length >= 2
          ? [
              ...(this.search?.query(q) || []),
              ...this.hooks.collect('site.search', q).map((r) => ({ ...r, excerptHtml: escapeHtml(r.excerpt || '') })),
            ]
          : [];
      // Nur Treffer in der Sprache der Anfrage
      const results = this.i18n?.isMulti() ? all.filter((r) => this.i18n.langOfPath(r.url) === req.lang) : all;
      const t = (k) => escapeHtml(this.t(req, k));
      this.send(req, res, {
        title: q ? `${this.t(req, 'searchTitle')}: ${q}` : this.t(req, 'searchTitle'),
        noindex: true,
        content: `<div class="panel"><h1>${t('searchTitle')}</h1>
          <form class="search-form" action="${escapeHtml(this.localPath(req, '/suche'))}" method="get"><input type="search" name="q" value="${escapeHtml(q)}" placeholder="${t('search')}" aria-label="${t('searchLabel')}" autofocus><button type="submit">${t('searchButton')}</button></form>
          ${
            q.length >= 2
              ? results.length
                ? `<p class="muted">${results.length} ${t('results')}</p><ul class="search-results">${results
                    .map(
                      (r) =>
                        `<li><span class="tag">${escapeHtml(r.type)}</span> <a href="${escapeHtml(r.url)}">${escapeHtml(r.title)}</a>${r.excerptHtml ? `<p>${r.excerptHtml}</p>` : ''}</li>`,
                    )
                    .join('')}</ul>`
                : `<p>${t('noResults')}</p>`
              : q
                ? `<p class="muted">${t('minChars')}</p>`
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
