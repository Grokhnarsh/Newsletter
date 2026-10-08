import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { excerpt, sanitizeContent, slugify } from '../../core/content.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/render.js';
import { now } from '../../lib/time.js';
import { parseId, SAFE_URL, validate } from '../../lib/validate.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

// Erste URL-Segmente, die von System und Modulen belegt sind
const CORE_RESERVED = ['admin', 'api', 'uploads', 'theme', 'suche', 'sitemap.xml', 'robots.txt', 'health'];
const TEMPLATES = ['default', 'full', 'landing'];

const pageSchema = {
  title: { type: 'string', required: true, max: 200 },
  slug: { type: 'string', max: 120 },
  parent_id: { type: 'int', min: 1 },
  content: { type: 'string', max: 2_000_000, trim: false },
  status: { type: 'enum', values: ['draft', 'published'] },
  template: { type: 'enum', values: TEMPLATES },
  seo_title: { type: 'string', max: 200 },
  seo_description: { type: 'string', max: 400 },
  cover_url: { type: 'string', max: 500, ...SAFE_URL },
  position: { type: 'int', min: 0, max: 100000 },
};

export class PageService {
  constructor({ db, content, hooks, search, settings }) {
    Object.assign(this, { db, content, hooks, search, settings });
  }

  reservedSlugs() {
    return new Set([...CORE_RESERVED, ...this.hooks.collect('site.reserved')]);
  }

  all() {
    return this.db.all(
      `SELECT p.id, p.title, p.slug, p.parent_id, p.status, p.template, p.position, p.updated_at, p.published_at, u.email AS author
       FROM pages p LEFT JOIN users u ON u.id = p.author_id ORDER BY p.position, p.title`,
    );
  }

  /** Alle Seiten mit berechnetem Pfad, als flache Liste in Baumreihenfolge. */
  tree() {
    const rows = this.all();
    const byParent = new Map();
    for (const r of rows) {
      const key = r.parent_id ?? 0;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(r);
    }
    const out = [];
    const walk = (parentId, depth, prefix) => {
      for (const r of byParent.get(parentId) || []) {
        const p = `${prefix}/${r.slug}`;
        out.push({ ...r, depth, path: p });
        if (depth < 10) walk(r.id, depth + 1, p);
      }
    };
    walk(0, 0, '');
    return out;
  }

  find(id) {
    const row = this.db.get('SELECT * FROM pages WHERE id = ?', id);
    if (!row) throw notFound('Seite nicht gefunden');
    return { ...row, path: this.pathFor(row) };
  }

  ancestors(page) {
    const chain = [];
    let parentId = page.parent_id;
    const seen = new Set([page.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = this.db.get('SELECT id, title, slug, parent_id, status FROM pages WHERE id = ?', parentId);
      if (!parent) break;
      chain.unshift(parent);
      parentId = parent.parent_id;
    }
    return chain;
  }

  pathFor(page) {
    return `/${[...this.ancestors(page).map((p) => p.slug), page.slug].join('/')}`;
  }

  /** Sucht eine veröffentlichte Seite über ihren vollständigen Pfad. */
  findPublishedByPath(urlPath) {
    let segments;
    try {
      segments = urlPath.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
    } catch {
      return null; // ungültige Prozent-Kodierung → 404 statt 500
    }
    if (!segments.length) return null;
    let parentId = null;
    let page = null;
    for (const slug of segments) {
      page = parentId
        ? this.db.get("SELECT * FROM pages WHERE slug = ? AND parent_id = ? AND status = 'published'", slug, parentId)
        : this.db.get("SELECT * FROM pages WHERE slug = ? AND parent_id IS NULL AND status = 'published'", slug);
      if (!page) return null;
      parentId = page.id;
    }
    return page;
  }

  children(id, { publishedOnly = true } = {}) {
    return this.db.all(
      `SELECT * FROM pages WHERE parent_id = ? ${publishedOnly ? "AND status = 'published'" : ''} ORDER BY position, title`,
      id,
    );
  }

  normalize(data, existing) {
    const out = { ...data };
    if (out.slug !== undefined || !existing) out.slug = slugify(out.slug || out.title || existing?.title);
    if (out.slug !== undefined && !out.slug) throw badRequest('Validierung fehlgeschlagen', { slug: 'Ungültiger Slug' });
    if (out.content !== undefined) out.content = sanitizeContent(out.content);
    const parentId = out.parent_id !== undefined ? out.parent_id : existing?.parent_id;
    const slug = out.slug ?? existing?.slug;
    if (parentId) {
      const parent = this.find(parentId);
      if (existing && (parent.id === existing.id || this.ancestors(parent).some((a) => a.id === existing.id))) {
        throw badRequest('Eine Seite kann nicht unter sich selbst einsortiert werden');
      }
    } else if (this.reservedSlugs().has(slug)) {
      throw badRequest('Validierung fehlgeschlagen', { slug: `„${slug}“ ist für das System reserviert` });
    }
    const clash = parentId
      ? this.db.get('SELECT id FROM pages WHERE slug = ? AND parent_id = ? AND id != ?', slug, parentId, existing?.id ?? 0)
      : this.db.get('SELECT id FROM pages WHERE slug = ? AND parent_id IS NULL AND id != ?', slug, existing?.id ?? 0);
    if (clash) throw conflict('Auf dieser Ebene gibt es bereits eine Seite mit dieser Adresse', { slug: 'bereits vergeben' });
    return out;
  }

  create(data, userId) {
    const d = this.normalize(data);
    const t = now();
    const status = d.status || 'draft';
    const { lastInsertRowid: id } = this.db.run(
      `INSERT INTO pages (title, slug, parent_id, content, status, template, seo_title, seo_description, cover_url, position,
         author_id, created_at, updated_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      d.title,
      d.slug,
      d.parent_id || null,
      d.content || '',
      status,
      d.template || 'default',
      d.seo_title || '',
      d.seo_description || '',
      d.cover_url || '',
      d.position ?? 0,
      userId ?? null,
      t,
      t,
      status === 'published' ? t : null,
    );
    this.reindex();
    return this.find(id);
  }

  /** Pfade aller veröffentlichten Seiten (id → Pfad), um Verschiebungen zu erkennen. */
  publishedPaths() {
    return new Map(this.tree().filter((p) => p.status === 'published').map((p) => [p.id, p.path]));
  }

  /** Meldet geänderte Adressen veröffentlichter Seiten (z. B. für automatische Weiterleitungen). */
  reportMoves(before) {
    const after = this.publishedPaths();
    const moves = [];
    for (const [id, from] of before) {
      const to = after.get(id);
      if (to && to !== from) moves.push({ from, to });
    }
    if (moves.length) this.hooks.collect('content.moved', moves);
  }

  update(id, data, userId) {
    const before = this.publishedPaths();
    const page = this.updateRow(id, data, userId);
    this.reportMoves(before);
    this.reindex();
    return page;
  }

  updateRow(id, data, userId) {
    const existing = this.find(id);
    const d = this.normalize(data, existing);
    return this.db.transaction(() => {
      if (d.content !== undefined && (d.content !== existing.content || (d.title && d.title !== existing.title))) {
        this.content.saveRevision('page', id, { title: existing.title, content: existing.content }, userId);
      }
      const fields = ['title', 'slug', 'parent_id', 'content', 'status', 'template', 'seo_title', 'seo_description', 'cover_url', 'position'];
      const sets = [];
      const params = [];
      for (const f of fields) {
        if (d[f] === undefined) continue;
        sets.push(`${f} = ?`);
        params.push(f === 'parent_id' ? d[f] || null : d[f] ?? '');
      }
      if (d.status === 'published' && !existing.published_at) {
        sets.push('published_at = ?');
        params.push(now());
      }
      sets.push('updated_at = ?');
      params.push(now(), id);
      this.db.run(`UPDATE pages SET ${sets.join(', ')} WHERE id = ?`, ...params);
      return this.find(id);
    });
  }

  remove(id) {
    const page = this.find(id);
    const before = this.publishedPaths();
    this.db.transaction(() => {
      // Unterseiten rücken eine Ebene nach oben
      this.db.run('UPDATE pages SET parent_id = ? WHERE parent_id = ?', page.parent_id, id);
      this.db.run('DELETE FROM pages WHERE id = ?', id);
      this.content.deleteRevisions('page', id);
    });
    before.delete(id);
    this.reportMoves(before);
    this.reindex();
  }

  /** Alle veröffentlichten Seiten als Dokumente für die Volltextsuche. */
  searchDocuments() {
    const home = this.settings?.get('home_page_id');
    return this.tree()
      .filter((p) => p.status === 'published')
      .map((p) => {
        const row = this.db.get('SELECT content, seo_description FROM pages WHERE id = ?', p.id);
        return { entity: 'page', id: p.id, title: p.title, html: row.content, text: row.seo_description, url: p.id === home ? '/' : p.path };
      });
  }

  /** Suchindex der Seiten erneuern (Pfade von Unterseiten können sich mitändern). */
  reindex() {
    if (!this.search) return;
    this.db.transaction(() => {
      this.db.run("DELETE FROM search_index WHERE entity = 'page'");
      for (const d of this.searchDocuments()) this.search.index('page', d.id, d);
    });
  }
}

function renderPage(ctx, req, page) {
  const crumbs = ctx.pages.ancestors(page).filter((a) => a.status === 'published');
  req.currentPage = page;
  const body = ctx.content.render(page.content, req);
  const showTitle = page.template !== 'landing';
  return {
    title: page.seo_title || page.title,
    description: page.seo_description || excerpt(page.content, 160),
    image: page.cover_url ? (page.cover_url.startsWith('http') ? page.cover_url : ctx.site.url(page.cover_url)) : '',
    bodyClass: page.template === 'default' ? 'page' : 'page page-full',
    canonical: ctx.site.url(ctx.pages.pathFor(page)),
    content: `${
      crumbs.length
        ? `<nav class="breadcrumbs" aria-label="Brotkrumen"><a href="/">Start</a> › ${crumbs
            .map((c) => `<a href="${escapeHtml(ctx.pages.pathFor(c))}">${escapeHtml(c.title)}</a>`)
            .join(' › ')}</nav>`
        : ''
    }<article class="prose">${showTitle ? `<h1>${escapeHtml(page.title)}</h1>` : ''}${
      page.cover_url ? `<img class="cover" src="${escapeHtml(page.cover_url)}" alt="">` : ''
    }${body}</article>`,
  };
}

export default {
  name: 'pages',
  label: 'Seiten',
  description: 'Hierarchische Inhaltsseiten mit Revisionen, SEO-Feldern, Vorlagen und frei wählbarer Startseite.',
  version: '1.0.0',
  adminDir: path.join(dir, 'admin'),
  settings: {
    defaults: { home_page_id: null },
    rules: { home_page_id: { type: 'int', min: 1 } },
  },
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE pages (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          slug TEXT NOT NULL,
          parent_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
          content TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
          template TEXT NOT NULL DEFAULT 'default',
          seo_title TEXT NOT NULL DEFAULT '',
          seo_description TEXT NOT NULL DEFAULT '',
          cover_url TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL DEFAULT 0,
          author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          published_at TEXT
        );
        CREATE INDEX idx_pages_parent_slug ON pages(parent_id, slug);
      `,
    },
  ],

  setup(ctx) {
    const { hooks, content, settings } = ctx;
    ctx.pages = new PageService(ctx);
    const opts = { module: 'pages' };

    hooks.on(
      'site.home',
      (req) => {
        const id = settings.get('home_page_id');
        const page = id && ctx.db.get("SELECT * FROM pages WHERE id = ? AND status = 'published'", id);
        if (!page) return undefined;
        return { ...renderPage(ctx, req, page), canonical: ctx.site.url('/') };
      },
      { ...opts, priority: 5 },
    );
    ctx.search.registerType('page', 'Seite', 'pages');
    hooks.on('search.documents', () => ctx.pages.searchDocuments(), opts);
    hooks.on(
      'site.sitemap',
      () =>
        ctx.pages
          .tree()
          .filter((p) => p.status === 'published')
          .map((p) => ({ loc: ctx.site.url(p.path), lastmod: p.updated_at })),
      opts,
    );
    hooks.on('admin.dashboard', () => ({ pages: ctx.db.get("SELECT COUNT(*) AS total, SUM(status = 'draft') AS drafts FROM pages") }), opts);
    hooks.on(
      'settings.validate',
      (data) => {
        if (data.home_page_id) ctx.pages.find(data.home_page_id);
      },
      opts,
    );
    hooks.on(
      'system.setup',
      () => {
        if (ctx.db.get('SELECT COUNT(*) AS n FROM pages').n > 0) return;
        const home = ctx.pages.create({
          title: 'Willkommen',
          slug: 'willkommen',
          status: 'published',
          template: 'landing',
          content:
            '<h1>Willkommen auf unserer Website</h1>\n<p>Diese Startseite kannst du im Admin-Bereich unter <strong>Seiten</strong> bearbeiten.</p>\n<h2>Aktuelle Beiträge</h2>\n<p>[recent_posts limit="3"]</p>',
        });
        settings.update({ home_page_id: home.id });
        ctx.pages.create({ title: 'Über uns', status: 'published', content: '<p>Erzähle hier, wer ihr seid und was ihr macht.</p>', position: 1 });
        ctx.pages.create({ title: 'Impressum', status: 'draft', content: '<p>Angaben gemäß § 5 DDG …</p>', position: 90 });
        ctx.pages.create({ title: 'Datenschutz', status: 'draft', content: '<p>Datenschutzerklärung …</p>', position: 91 });
      },
      opts,
    );
    // Menüs können auf Seiten verlinken
    hooks.on('menus.resolve', (item) => {
      if (item.type !== 'page') return undefined;
      const page = ctx.db.get("SELECT * FROM pages WHERE id = ? AND status = 'published'", item.target_id);
      if (!page) return null;
      return page.id === settings.get('home_page_id') ? '/' : ctx.pages.pathFor(page);
    }, opts);

    content.registerShortcode(
      'child_pages',
      (attrs, req) => {
        const parentId = Number(attrs.id) || req?.currentPage?.id;
        if (!parentId) return '';
        const kids = ctx.pages.children(parentId);
        if (!kids.length) return '';
        return `<ul class="child-pages">${kids.map((k) => `<li><a href="${escapeHtml(ctx.pages.pathFor(k))}">${escapeHtml(k.title)}</a></li>`).join('')}</ul>`;
      },
      { module: 'pages', description: 'Liste der Unterseiten der aktuellen (oder angegebenen) Seite', example: '[child_pages]' },
    );
  },

  api(router, ctx) {
    const r = Router();
    const homeId = () => ctx.settings.get('home_page_id');

    r.get('/', (req, res) => res.json(ctx.pages.tree().map((p) => ({ ...p, is_home: p.id === homeId() }))));

    r.post('/', (req, res) => {
      const data = validate(req.body, pageSchema, { partial: true });
      if (!data.title) throw badRequest('Validierung fehlgeschlagen', { title: 'Pflichtfeld' });
      res.status(201).json(ctx.pages.create(data, req.user?.id));
    });

    // Vorschau beliebiger (auch ungespeicherter) Inhalte im Theme
    r.post('/preview', (req, res) => {
      const data = validate(req.body, pageSchema, { partial: true });
      const page = { id: 0, parent_id: data.parent_id || null, slug: 'vorschau', title: data.title || 'Vorschau', template: data.template || 'default', ...data, content: sanitizeContent(data.content || '') };
      res.type('html').send(ctx.site.render(req, { ...renderPage(ctx, req, page), noindex: true }));
    });

    r.get('/:id', (req, res) => {
      const id = parseId(req.params.id);
      res.json({ ...ctx.pages.find(id), is_home: id === homeId(), revisions: ctx.content.revisions('page', id) });
    });

    r.put('/:id', (req, res) => {
      const data = validate(req.body, pageSchema, { partial: true });
      res.json(ctx.pages.update(parseId(req.params.id), data, req.user?.id));
    });

    r.delete('/:id', (req, res) => {
      const id = parseId(req.params.id);
      ctx.pages.remove(id);
      if (homeId() === id) ctx.settings.update({ home_page_id: null });
      res.status(204).end();
    });

    r.get('/:id/revisions/:rid', (req, res) => {
      res.json(ctx.content.revision('page', parseId(req.params.id), parseId(req.params.rid)));
    });

    r.post('/:id/revisions/:rid/restore', (req, res) => {
      const id = parseId(req.params.id);
      const rev = ctx.content.revision('page', id, parseId(req.params.rid));
      res.json(ctx.pages.update(id, { title: rev.title, content: rev.content }, req.user?.id));
    });

    router.use('/pages', r);
  },

  // Nach allen anderen Routen: Seiten über ihren Pfad auflösen
  fallbackRoutes(router, ctx) {
    router.get('/*path', (req, res, next) => {
      const page = ctx.pages.findPublishedByPath(req.path);
      if (!page) return next();
      if (page.id === ctx.settings.get('home_page_id')) return res.redirect(301, '/');
      ctx.site.send(req, res, renderPage(ctx, req, page));
    });
  },
};

