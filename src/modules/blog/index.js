import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { excerpt, sanitizeContent, slugify } from '../../core/content.js';
import { REVIEW_COLUMNS_SQL } from '../../core/review.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/render.js';
import { now } from '../../lib/time.js';
import { pagination, parseId, SAFE_URL, validate } from '../../lib/validate.js';
import { requireEditor } from '../../middleware/auth.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dateFormats = new Map();
// Datumsformat passend zur Sprache des Beitrags
function dateFmtFor(lang = 'de') {
  if (!dateFormats.has(lang)) dateFormats.set(lang, new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' }));
  return dateFormats.get(lang);
}

const postSchema = {
  title: { type: 'string', required: true, max: 200 },
  slug: { type: 'string', max: 120 },
  excerpt: { type: 'string', max: 1000 },
  content: { type: 'string', max: 2_000_000, trim: false },
  cover_url: { type: 'string', max: 500, ...SAFE_URL },
  status: { type: 'enum', values: ['draft', 'published'] },
  published_at: { type: 'date' },
  seo_title: { type: 'string', max: 200 },
  seo_description: { type: 'string', max: 400 },
  category_ids: { type: 'ids' },
  lang: { type: 'string', max: 2, pattern: /^([a-z]{2})?$/, patternMessage: 'Sprachkürzel, z. B. „en“' },
};

const PUBLISHED = "p.status = 'published' AND p.published_at <= ?";

export class PostService {
  constructor({ db, content, settings, site, hooks, search, i18n }) {
    Object.assign(this, { db, content, settings, site, hooks, search, i18n });
  }

  langOf(post) {
    return this.i18n ? this.i18n.langOf(post) : 'de';
  }

  /** Pfad in einer Sprache, z. B. ('/blog', 'en') → '/en/blog'. */
  localPath(p, lang) {
    return this.i18n ? this.i18n.path(p, lang) : p;
  }

  translations(post) {
    const group = post.translation_of || post.id;
    return this.db
      .all('SELECT id, title, slug, status, published_at, lang, translation_of FROM posts WHERE id = ? OR translation_of = ? ORDER BY id', group, group)
      .map((p) => ({ ...p, lang: this.langOf(p), url: this.publicUrl(p, false) }));
  }

  /** Übersetzung als Entwurf anlegen (Inhalt, Kategorien und Titelbild werden übernommen). */
  translate(id, lang, userId) {
    const post = this.find(id);
    if (!this.i18n?.languages().includes(lang)) throw badRequest('Sprache ist nicht eingerichtet');
    if (this.langOf(post) === lang) throw badRequest('Der Beitrag ist bereits in dieser Sprache');
    const existing = this.translations(post).find((t) => t.lang === lang);
    if (existing) throw conflict('Es gibt bereits eine Übersetzung in dieser Sprache', { id: existing.id });
    // Beitragsadressen sind sprachübergreifend eindeutig
    let slug = `${post.slug}-${lang}`;
    for (let i = 2; this.db.get('SELECT 1 FROM posts WHERE slug = ?', slug); i++) slug = `${post.slug}-${lang}-${i}`;
    return this.create(
      {
        title: post.title, slug, excerpt: post.excerpt, content: post.content, cover_url: post.cover_url, seo_title: post.seo_title,
        seo_description: post.seo_description, category_ids: post.category_ids, status: 'draft', lang, translation_of: post.translation_of || post.id,
      },
      userId,
    );
  }

  searchDocument(p) {
    return { entity: 'post', id: p.id, title: p.title, html: p.content, text: p.excerpt, url: this.publicUrl(p, false), published_at: p.published_at };
  }

  /** Veröffentlichte Beiträge im Suchindex halten (geplante erscheinen erst ab ihrem Datum). */
  indexPost(post) {
    if (!this.search) return;
    if (post.status === 'published') this.search.index('post', post.id, this.searchDocument(post));
    else this.search.remove('post', post.id);
  }

  publicUrl(post, absolute = true) {
    const p = this.localPath(`/blog/${post.slug}`, this.langOf(post));
    return absolute ? this.site.url(p) : p;
  }

  categoriesFor(postId) {
    return this.db.all(
      'SELECT c.id, c.name, c.slug FROM categories c JOIN post_categories pc ON pc.category_id = c.id WHERE pc.post_id = ? ORDER BY c.name',
      postId,
    );
  }

  /** Liste für die Verwaltung (alle Status). */
  list({ q, status, category_id, author_id, lang }, { page, perPage, offset }) {
    const where = [];
    const params = [];
    if (q) {
      where.push('(p.title LIKE ? OR p.content LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status === 'scheduled') {
      where.push("p.status = 'published' AND p.published_at > ?");
      params.push(now());
    } else if (status === 'review') {
      where.push("p.status = 'draft' AND p.review_requested_at IS NOT NULL");
    } else if (status) {
      where.push('p.status = ?');
      params.push(status);
    }
    if (lang && this.i18n) {
      const l = this.i18n.where(lang, 'p.lang');
      where.push(l.sql);
      params.push(...l.params);
    }
    if (author_id) {
      where.push('p.author_id = ?');
      params.push(Number(author_id));
    }
    if (category_id) {
      where.push('EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = p.id AND pc.category_id = ?)');
      params.push(Number(category_id));
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get(`SELECT COUNT(*) AS n FROM posts p ${sql}`, ...params).n;
    const items = this.db
      .all(
        `SELECT p.id, p.title, p.slug, p.status, p.published_at, p.updated_at, p.cover_url, p.author_id, p.review_requested_at, p.lang, p.translation_of, u.email AS author
         FROM posts p LEFT JOIN users u ON u.id = p.author_id ${sql}
         ORDER BY COALESCE(p.published_at, p.updated_at) DESC, p.id DESC LIMIT ? OFFSET ?`,
        ...params,
        perPage,
        offset,
      )
      .map((p) => ({ ...p, lang: this.langOf(p), categories: this.categoriesFor(p.id), scheduled: p.status === 'published' && p.published_at > now() }));
    return { items, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  find(id) {
    const row = this.db.get('SELECT * FROM posts WHERE id = ?', id);
    if (!row) throw notFound('Beitrag nicht gefunden');
    const categories = this.categoriesFor(id);
    return { ...row, categories, category_ids: categories.map((c) => c.id) };
  }

  findPublishedBySlug(slug) {
    const row = this.db.get(`SELECT p.*, u.name AS author_name FROM posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ? AND ${PUBLISHED}`, slug, now());
    return row ? { ...row, categories: this.categoriesFor(row.id) } : null;
  }

  /** Veröffentlichte Beiträge; mit `lang` nur in dieser Sprache. */
  published({ categoryId, limit = 10, offset = 0, lang } = {}) {
    const params = [now()];
    let extra = '';
    if (categoryId) {
      extra = 'AND EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = p.id AND pc.category_id = ?)';
      params.push(categoryId);
    }
    if (lang && this.i18n) {
      const l = this.i18n.where(lang, 'p.lang');
      extra += ` AND ${l.sql}`;
      params.push(...l.params);
    }
    const total = this.db.get(`SELECT COUNT(*) AS n FROM posts p WHERE ${PUBLISHED} ${extra}`, ...params).n;
    const items = this.db
      .all(`SELECT p.* FROM posts p WHERE ${PUBLISHED} ${extra} ORDER BY p.published_at DESC, p.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset)
      .map((p) => ({ ...p, categories: this.categoriesFor(p.id) }));
    return { items, total };
  }

  normalize(data, existing) {
    const out = { ...data };
    if (out.slug !== undefined || !existing) out.slug = slugify(out.slug || out.title || existing?.title);
    if (out.slug !== undefined) {
      if (!out.slug) throw badRequest('Validierung fehlgeschlagen', { slug: 'Ungültiger Slug' });
      if (['kategorie', 'feed.xml'].includes(out.slug)) throw badRequest('Validierung fehlgeschlagen', { slug: 'reserviert' });
      if (this.db.get('SELECT id FROM posts WHERE slug = ? AND id != ?', out.slug, existing?.id ?? 0)) {
        throw conflict('Es gibt bereits einen Beitrag mit dieser Adresse', { slug: 'bereits vergeben' });
      }
    }
    if (out.content !== undefined) out.content = sanitizeContent(out.content);
    if (out.lang !== undefined && this.i18n) {
      if (out.lang && !this.i18n.languages().includes(out.lang)) throw badRequest('Validierung fehlgeschlagen', { lang: 'Sprache ist nicht eingerichtet' });
      out.lang = this.i18n.storedLang(out.lang);
    }
    if (out.category_ids) {
      for (const id of out.category_ids) if (!this.db.get('SELECT 1 FROM categories WHERE id = ?', id)) throw notFound(`Kategorie ${id} nicht gefunden`);
    }
    return out;
  }

  setCategories(postId, ids) {
    this.db.run('DELETE FROM post_categories WHERE post_id = ?', postId);
    for (const id of ids) this.db.run('INSERT OR IGNORE INTO post_categories (post_id, category_id) VALUES (?, ?)', postId, id);
  }

  create(data, userId) {
    const d = this.normalize(data);
    const t = now();
    const status = d.status || 'draft';
    return this.db.transaction(() => {
      const { lastInsertRowid: id } = this.db.run(
        `INSERT INTO posts (title, slug, excerpt, content, cover_url, status, published_at, seo_title, seo_description, author_id, created_at, updated_at,
           lang, translation_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        d.title,
        d.slug,
        d.excerpt || '',
        d.content || '',
        d.cover_url || '',
        status,
        d.published_at || (status === 'published' ? t : null),
        d.seo_title || '',
        d.seo_description || '',
        userId ?? null,
        t,
        t,
        d.lang || null,
        d.translation_of || null,
      );
      if (d.category_ids) this.setCategories(id, d.category_ids);
      const post = this.find(id);
      this.indexPost(post);
      return post;
    });
  }

  update(id, data, userId) {
    const existing = this.find(id);
    const post = this.updateRow(existing, data, userId);
    this.indexPost(post);
    // Neue Adresse eines veröffentlichten Beitrags melden (automatische Weiterleitung)
    if (existing.status === 'published' && post.status === 'published' && post.slug !== existing.slug) {
      this.hooks.collect('content.moved', [{ from: this.publicUrl(existing, false), to: this.publicUrl(post, false) }]);
    }
    return post;
  }

  updateRow(existing, data, userId) {
    const id = existing.id;
    const d = this.normalize(data, existing);
    return this.db.transaction(() => {
      if (d.content !== undefined && d.content !== existing.content) {
        this.content.saveRevision('post', id, { title: existing.title, content: existing.content, data: { excerpt: existing.excerpt } }, userId);
      }
      // Veröffentlichte Beiträge brauchen immer ein Datum (sonst wären sie unsichtbar)
      const finalStatus = d.status ?? existing.status;
      const finalDate = d.published_at !== undefined ? d.published_at : existing.published_at;
      if (finalStatus === 'published' && !finalDate) d.published_at = now();
      const fields = ['title', 'slug', 'excerpt', 'content', 'cover_url', 'status', 'published_at', 'seo_title', 'seo_description', 'lang'];
      const sets = [];
      const params = [];
      for (const f of fields) {
        if (d[f] === undefined) continue;
        sets.push(`${f} = ?`);
        params.push(d[f] ?? (['published_at', 'lang'].includes(f) ? null : ''));
      }
      sets.push('updated_at = ?');
      params.push(now(), id);
      this.db.run(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`, ...params);
      if (d.category_ids) this.setCategories(id, d.category_ids);
      return this.find(id);
    });
  }

  remove(id) {
    this.find(id);
    this.db.run('DELETE FROM posts WHERE id = ?', id);
    this.content.deleteRevisions('post', id);
    this.search?.remove('post', id);
  }

  // ---- Kategorien ----

  categories() {
    return this.db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM post_categories pc WHERE pc.category_id = c.id) AS post_count FROM categories c ORDER BY c.name`,
    );
  }

  saveCategory(id, { name, slug, description }) {
    const s = slugify(slug || name);
    if (!s) throw badRequest('Validierung fehlgeschlagen', { slug: 'Ungültiger Slug' });
    if (this.db.get('SELECT id FROM categories WHERE slug = ? AND id != ?', s, id ?? 0)) throw conflict('Kategorie-Slug bereits vergeben');
    if (id) {
      const old = this.db.get('SELECT slug FROM categories WHERE id = ?', id);
      if (!old) throw notFound('Kategorie nicht gefunden');
      this.db.run('UPDATE categories SET name = ?, slug = ?, description = ? WHERE id = ?', name, s, description || '', id);
      if (old.slug !== s) this.hooks.collect('content.moved', [{ from: `/blog/kategorie/${old.slug}`, to: `/blog/kategorie/${s}` }]);
      return this.db.get('SELECT * FROM categories WHERE id = ?', id);
    }
    const { lastInsertRowid } = this.db.run('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)', name, s, description || '');
    return this.db.get('SELECT * FROM categories WHERE id = ?', lastInsertRowid);
  }

  removeCategory(id) {
    const { changes } = this.db.run('DELETE FROM categories WHERE id = ?', id);
    if (!changes) throw notFound('Kategorie nicht gefunden');
  }

  searchDocuments() {
    return this.db.all("SELECT * FROM posts WHERE status = 'published'").map((p) => this.searchDocument(p));
  }
}

// ---- Darstellung ----

function postCard(posts, p, heading = 'h2') {
  const url = posts.publicUrl(p, false);
  const lang = posts.langOf(p);
  return `<article class="post-card">
  ${p.cover_url ? `<a href="${escapeHtml(url)}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(p.cover_url)}" alt="" loading="lazy"></a>` : ''}
  <div class="body">
    <p class="meta">${p.categories.map((c) => `<a class="tag" href="${escapeHtml(posts.localPath(`/blog/kategorie/${c.slug}`, lang))}">${escapeHtml(c.name)}</a>`).join('')}<time datetime="${escapeHtml(p.published_at)}">${dateFmtFor(lang).format(new Date(p.published_at))}</time></p>
    <${heading}><a href="${escapeHtml(url)}">${escapeHtml(p.title)}</a></${heading}>
    <p>${escapeHtml(p.excerpt || excerpt(p.content, 180))}</p>
  </div>
</article>`;
}

function pager(page, pages, base, t = (k) => ({ newer: '‹ Neuere', older: 'Ältere ›', page: 'Seite' })[k]) {
  if (pages <= 1) return '';
  const link = (n, label) => `<a href="${base}${n > 1 ? `?seite=${n}` : ''}">${escapeHtml(label)}</a>`;
  return `<nav class="pagination" aria-label="${escapeHtml(t('page'))}">${page > 1 ? link(page - 1, t('newer')) : ''}<span>${escapeHtml(t('page'))} ${page} / ${pages}</span>${
    page < pages ? link(page + 1, t('older')) : ''
  }</nav>`;
}

function listView(ctx, req, { title, intro = '', categoryId, base: rawBase }) {
  const perPage = ctx.settings.get('blog_posts_per_page');
  const page = Math.max(1, Number.parseInt(req.query.seite, 10) || 1);
  const base = ctx.site.localPath(req, rawBase);
  const t = (k) => ctx.site.t(req, k);
  const { items, total } = ctx.posts.published({ categoryId, limit: perPage, offset: (page - 1) * perPage, lang: req.lang });
  const pages = Math.max(1, Math.ceil(total / perPage));
  return {
    title: page > 1 ? `${title} – ${t('page')} ${page}` : title,
    canonical: ctx.site.url(page > 1 ? `${base}?seite=${page}` : base),
    status: page > pages ? 404 : 200,
    content: `<header class="hero"><h1>${escapeHtml(title)}</h1>${intro}</header>
${items.length ? `<div class="post-list">${items.map((p) => postCard(ctx.posts, p)).join('')}</div>` : `<p class="muted">${escapeHtml(t('noPosts'))}</p>`}
${pager(page, pages, base, t)}`,
  };
}

function postView(ctx, req, post) {
  const lang = ctx.posts.langOf(post);
  const author = post.author_name ? ` · ${escapeHtml(post.author_name)}` : '';
  return {
    title: post.seo_title || post.title,
    description: post.seo_description || post.excerpt || excerpt(post.content, 160),
    image: post.cover_url ? (post.cover_url.startsWith('http') ? post.cover_url : ctx.site.url(post.cover_url)) : '',
    type: 'article',
    bodyClass: 'post',
    canonical: ctx.posts.publicUrl(post),
    alternates: post.id ? ctx.posts.translations(post).filter((t) => t.status === 'published' && t.published_at <= now()).map((t) => ({ lang: t.lang, url: t.url })) : [],
    content: `<nav class="breadcrumbs" aria-label="Brotkrumen"><a href="${escapeHtml(ctx.posts.localPath('/blog', lang))}">${escapeHtml(ctx.settings.get('blog_title'))}</a></nav>
<article class="prose">
  <p class="meta">${post.categories.map((c) => `<a class="tag" href="${escapeHtml(ctx.posts.localPath(`/blog/kategorie/${c.slug}`, lang))}">${escapeHtml(c.name)}</a>`).join('')}<time datetime="${escapeHtml(post.published_at)}">${dateFmtFor(lang).format(new Date(post.published_at))}</time>${author}</p>
  <h1>${escapeHtml(post.title)}</h1>
  ${post.excerpt ? `<p class="lead">${escapeHtml(post.excerpt)}</p>` : ''}
  ${post.cover_url ? `<img class="cover" src="${escapeHtml(post.cover_url)}" alt="">` : ''}
  ${ctx.content.render(post.content, req)}
</article>`,
  };
}

export default {
  name: 'blog',
  label: 'Blog',
  description: 'Beiträge mit Kategorien, geplanter Veröffentlichung, RSS-Feed und Newsletter-Anbindung.',
  version: '1.2.0',
  adminDir: path.join(dir, 'admin'),
  // Autoren dürfen eigene Entwürfe anlegen und zur Prüfung einreichen
  authors: true,
  settings: {
    defaults: { blog_title: 'Blog', blog_intro: '', blog_posts_per_page: 9, blog_on_home: true },
    rules: {
      blog_title: { type: 'string', max: 100 },
      blog_intro: { type: 'string', max: 1000 },
      blog_posts_per_page: { type: 'int', min: 1, max: 100 },
      blog_on_home: { type: 'bool' },
    },
  },
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE posts (
          id INTEGER PRIMARY KEY,
          title TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          excerpt TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL DEFAULT '',
          cover_url TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
          published_at TEXT,
          seo_title TEXT NOT NULL DEFAULT '',
          seo_description TEXT NOT NULL DEFAULT '',
          author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_posts_published ON posts(status, published_at);
        CREATE TABLE categories (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE post_categories (
          post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
          category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          PRIMARY KEY (post_id, category_id)
        );
      `,
    },
    { version: 2, sql: REVIEW_COLUMNS_SQL('posts') },
    {
      version: 3,
      sql: `
        ALTER TABLE posts ADD COLUMN lang TEXT;
        ALTER TABLE posts ADD COLUMN translation_of INTEGER REFERENCES posts(id) ON DELETE SET NULL;
        CREATE INDEX idx_posts_translation ON posts(translation_of);
      `,
    },
  ],

  setup(ctx) {
    const { hooks, content, settings } = ctx;
    ctx.posts = new PostService(ctx);
    const opts = { module: 'blog' };

    hooks.on('site.reserved', () => ['blog'], opts);
    hooks.on(
      'site.home',
      (req) => {
        if (!settings.get('blog_on_home')) return undefined;
        const view = listView(ctx, req, { title: settings.get('blog_title'), base: '/' });
        return { ...view, title: settings.get('site_name') };
      },
      { ...opts, priority: 20 },
    );
    hooks.on('site.head', (req) => `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(settings.get('site_name'))}" href="${escapeHtml(ctx.site.localPath(req, '/blog/feed.xml'))}">`, opts);
    ctx.search.registerType('post', 'Beitrag', 'blog');
    hooks.on('search.documents', () => ctx.posts.searchDocuments(), opts);
    hooks.on(
      'site.sitemap',
      () => [
        ...(ctx.i18n?.languages() || [null]).map((l) => ({ loc: ctx.site.url(ctx.posts.localPath('/blog', l)) })),
        ...ctx.posts.published({ limit: 5000 }).items.map((p) => ({ loc: ctx.posts.publicUrl(p), lastmod: p.updated_at })),
        ...ctx.posts.categories().filter((c) => c.post_count).map((c) => ({ loc: ctx.site.url(`/blog/kategorie/${c.slug}`) })),
      ],
      opts,
    );
    hooks.on(
      'admin.dashboard',
      () => ({ blog: ctx.db.get("SELECT COUNT(*) AS total, SUM(status = 'draft') AS drafts, SUM(status = 'published' AND published_at > ?) AS scheduled, SUM(status = 'draft' AND review_requested_at IS NOT NULL) AS review FROM posts", now()) }),
      opts,
    );
    hooks.on('menus.resolve', (item, lang) => (item.type === 'blog' ? ctx.posts.localPath('/blog', lang) : undefined), opts);
    hooks.on(
      'system.setup',
      ({ user }) => {
        if (ctx.db.get('SELECT COUNT(*) AS n FROM posts').n > 0) return;
        const cat = ctx.posts.saveCategory(null, { name: 'Neuigkeiten' });
        ctx.posts.create(
          {
            title: 'Hallo Welt!',
            excerpt: 'Der erste Beitrag auf der neuen Website.',
            content: '<p>Willkommen! Dies ist der erste Beitrag. Bearbeite oder lösche ihn im Admin-Bereich unter <strong>Blog</strong>.</p>',
            status: 'published',
            category_ids: [cat.id],
          },
          user?.id,
        );
      },
      opts,
    );

    content.registerShortcode(
      'recent_posts',
      (attrs, req) => {
        const limit = Math.min(12, Math.max(1, Number(attrs.limit) || 3));
        const cat = attrs.category ? ctx.db.get('SELECT id FROM categories WHERE slug = ?', attrs.category) : null;
        const { items } = ctx.posts.published({ categoryId: cat?.id, limit, lang: req?.lang });
        if (!items.length) return '<p class="muted">Noch keine Beiträge.</p>';
        return `<div class="post-list">${items.map((p) => postCard(ctx.posts, p, 'h3')).join('')}</div>`;
      },
      { module: 'blog', description: 'Neueste Blogbeiträge (optional nach Kategorie)', example: '[recent_posts limit="3" category="neuigkeiten"]' },
    );
  },

  api(router, ctx) {
    const r = Router();
    const publishEvent = (before, after, req) => {
      if (after.status === 'published' && before?.status !== 'published') {
        ctx.hooks.emit('blog.post.published', after, { userId: req.user?.id });
      }
    };

    const review = { table: 'posts', kind: 'den Beitrag' };
    const editable = (req) => {
      const post = ctx.posts.find(parseId(req.params.id));
      ctx.review.assertCanEdit(req, post);
      return post;
    };

    r.get('/', (req, res) => {
      const list = ctx.posts.list(req.query, pagination(req.query));
      res.json({ ...list, items: list.items.map((p) => ({ ...p, can_edit: ctx.review.canEdit(req, p) })) });
    });
    r.post('/', (req, res) => {
      const data = ctx.review.restrict(req, validate(req.body, postSchema, { partial: true }));
      if (!data.title) throw badRequest('Validierung fehlgeschlagen', { title: 'Pflichtfeld' });
      const post = ctx.posts.create(data, req.user?.id);
      publishEvent(null, post, req);
      res.status(201).json(post);
    });
    r.post('/preview', (req, res) => {
      const data = validate(req.body, postSchema, { partial: true });
      const post = {
        id: 0, slug: 'vorschau', title: 'Vorschau', excerpt: '', cover_url: '', ...data,
        content: sanitizeContent(data.content || ''), published_at: data.published_at || now(), categories: [],
      };
      res.type('html').send(ctx.site.render(req, { ...postView(ctx, req, post), noindex: true }));
    });
    r.get('/:id', (req, res) => {
      const post = ctx.posts.find(parseId(req.params.id));
      res.json({
        ...post, lang: ctx.posts.langOf(post), url: ctx.posts.publicUrl(post), can_edit: ctx.review.canEdit(req, post),
        translations: ctx.posts.translations(post), revisions: ctx.content.revisions('post', post.id),
      });
    });
    r.put('/:id', async (req, res) => {
      const before = editable(req);
      const post = ctx.posts.update(before.id, ctx.review.restrict(req, validate(req.body, postSchema, { partial: true })), req.user?.id);
      publishEvent(before, post, req);
      if (post.status === 'published' && before.status !== 'published') {
        await ctx.review.published(req, { ...review, item: before, url: ctx.posts.publicUrl(post) });
      }
      res.json(ctx.posts.find(post.id));
    });
    r.delete('/:id', (req, res) => {
      ctx.posts.remove(editable(req).id);
      res.status(204).end();
    });
    // Übersetzung anlegen
    r.post('/:id/translate', (req, res) => {
      const { lang } = validate(req.body, { lang: { type: 'string', required: true, max: 2 } });
      res.status(201).json(ctx.posts.translate(parseId(req.params.id), lang, req.user?.id));
    });
    // Freigabe-Workflow
    r.post('/:id/submit', async (req, res) => {
      const post = ctx.posts.find(parseId(req.params.id));
      const result = await ctx.review.submit(req, { ...review, item: post, editPath: `/posts/${post.id}` });
      res.json({ ...ctx.posts.find(post.id), ...result });
    });
    r.post('/:id/decline', async (req, res) => {
      const post = ctx.posts.find(parseId(req.params.id));
      const result = await ctx.review.decline(req, { ...review, item: post, editPath: `/posts/${post.id}`, note: req.body?.note });
      res.json({ ...ctx.posts.find(post.id), ...result });
    });
    r.get('/:id/revisions/:rid', (req, res) => res.json(ctx.content.revision('post', parseId(req.params.id), parseId(req.params.rid))));
    r.post('/:id/revisions/:rid/restore', (req, res) => {
      const { id } = editable(req);
      const rev = ctx.content.revision('post', id, parseId(req.params.rid));
      res.json(ctx.posts.update(id, { title: rev.title, content: rev.content }, req.user?.id));
    });
    router.use('/posts', r);

    const c = Router();
    const catSchema = { name: { type: 'string', required: true, max: 100 }, slug: { type: 'string', max: 100 }, description: { type: 'string', max: 1000 } };
    c.get('/', (req, res) => res.json(ctx.posts.categories()));
    c.post('/', requireEditor, (req, res) => res.status(201).json(ctx.posts.saveCategory(null, validate(req.body, catSchema))));
    c.put('/:id', requireEditor, (req, res) => res.json(ctx.posts.saveCategory(parseId(req.params.id), validate(req.body, catSchema))));
    c.delete('/:id', requireEditor, (req, res) => {
      ctx.posts.removeCategory(parseId(req.params.id));
      res.status(204).end();
    });
    router.use('/categories', c);
  },

  publicRoutes(router, ctx) {
    router.get('/blog', (req, res) => {
      const intro = ctx.settings.get('blog_intro');
      ctx.site.send(req, res, listView(ctx, req, { title: ctx.settings.get('blog_title'), intro: intro ? `<p class="lead">${escapeHtml(intro)}</p>` : '', base: '/blog' }));
    });

    router.get('/blog/feed.xml', (req, res) => {
      const s = ctx.settings.all();
      const { items } = ctx.posts.published({ limit: 20, lang: req.lang });
      const xml = items
        .map(
          (p) => `  <item>
    <title>${escapeHtml(p.title)}</title>
    <link>${escapeHtml(ctx.posts.publicUrl(p))}</link>
    <guid isPermaLink="true">${escapeHtml(ctx.posts.publicUrl(p))}</guid>
    <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
    ${p.categories.map((c) => `<category>${escapeHtml(c.name)}</category>`).join('')}
    <description>${escapeHtml(p.excerpt || excerpt(p.content, 300))}</description>
  </item>`,
        )
        .join('\n');
      res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>${escapeHtml(s.site_name)}</title>
  <link>${escapeHtml(ctx.site.url(ctx.site.localPath(req, '/blog')))}</link>
  <atom:link href="${escapeHtml(ctx.site.url(ctx.site.localPath(req, '/blog/feed.xml')))}" rel="self" type="application/rss+xml"/>
  <description>${escapeHtml(s.site_description || s.site_tagline || s.site_name)}</description>
  <language>${escapeHtml(req.lang || 'de')}</language>
${xml}
</channel>
</rss>
`);
    });

    router.get('/blog/kategorie/:slug', (req, res, next) => {
      const cat = ctx.db.get('SELECT * FROM categories WHERE slug = ?', req.params.slug);
      if (!cat) return next();
      ctx.site.send(
        req,
        res,
        listView(ctx, req, {
          title: cat.name,
          intro: cat.description ? `<p class="lead">${escapeHtml(cat.description)}</p>` : '',
          categoryId: cat.id,
          base: `/blog/kategorie/${cat.slug}`,
        }),
      );
    });

    router.get('/blog/:slug', (req, res, next) => {
      const post = ctx.posts.findPublishedBySlug(req.params.slug);
      if (!post) return next();
      // Beitrag einer anderen Sprache → auf seine richtige Adresse
      if (ctx.i18n && ctx.posts.langOf(post) !== req.lang) return res.redirect(301, ctx.posts.publicUrl(post, false));
      ctx.site.send(req, res, postView(ctx, req, post));
    });
  },
};
