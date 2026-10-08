import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { excerpt, sanitizeContent, slugify } from '../../core/content.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/render.js';
import { now } from '../../lib/time.js';
import { pagination, parseId, SAFE_URL, validate } from '../../lib/validate.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Berlin' });

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
};

const PUBLISHED = "p.status = 'published' AND p.published_at <= ?";

export class PostService {
  constructor({ db, content, settings, site, hooks }) {
    Object.assign(this, { db, content, settings, site, hooks });
  }

  publicUrl(post, absolute = true) {
    const p = `/blog/${post.slug}`;
    return absolute ? this.site.url(p) : p;
  }

  categoriesFor(postId) {
    return this.db.all(
      'SELECT c.id, c.name, c.slug FROM categories c JOIN post_categories pc ON pc.category_id = c.id WHERE pc.post_id = ? ORDER BY c.name',
      postId,
    );
  }

  /** Liste für die Verwaltung (alle Status). */
  list({ q, status, category_id }, { page, perPage, offset }) {
    const where = [];
    const params = [];
    if (q) {
      where.push('(p.title LIKE ? OR p.content LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (status === 'scheduled') {
      where.push("p.status = 'published' AND p.published_at > ?");
      params.push(now());
    } else if (status) {
      where.push('p.status = ?');
      params.push(status);
    }
    if (category_id) {
      where.push('EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = p.id AND pc.category_id = ?)');
      params.push(Number(category_id));
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get(`SELECT COUNT(*) AS n FROM posts p ${sql}`, ...params).n;
    const items = this.db
      .all(
        `SELECT p.id, p.title, p.slug, p.status, p.published_at, p.updated_at, p.cover_url, u.email AS author
         FROM posts p LEFT JOIN users u ON u.id = p.author_id ${sql}
         ORDER BY COALESCE(p.published_at, p.updated_at) DESC, p.id DESC LIMIT ? OFFSET ?`,
        ...params,
        perPage,
        offset,
      )
      .map((p) => ({ ...p, categories: this.categoriesFor(p.id), scheduled: p.status === 'published' && p.published_at > now() }));
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

  published({ categoryId, limit = 10, offset = 0 } = {}) {
    const params = [now()];
    let extra = '';
    if (categoryId) {
      extra = 'AND EXISTS (SELECT 1 FROM post_categories pc WHERE pc.post_id = p.id AND pc.category_id = ?)';
      params.push(categoryId);
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
        `INSERT INTO posts (title, slug, excerpt, content, cover_url, status, published_at, seo_title, seo_description, author_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      if (d.category_ids) this.setCategories(id, d.category_ids);
      return this.find(id);
    });
  }

  update(id, data, userId) {
    const existing = this.find(id);
    const post = this.updateRow(existing, data, userId);
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
      const fields = ['title', 'slug', 'excerpt', 'content', 'cover_url', 'status', 'published_at', 'seo_title', 'seo_description'];
      const sets = [];
      const params = [];
      for (const f of fields) {
        if (d[f] === undefined) continue;
        sets.push(`${f} = ?`);
        params.push(d[f] ?? (f === 'published_at' ? null : ''));
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

  search(q) {
    const like = `%${q}%`;
    return this.db
      .all(`SELECT p.* FROM posts p WHERE ${PUBLISHED} AND (p.title LIKE ? OR p.content LIKE ? OR p.excerpt LIKE ?) ORDER BY p.published_at DESC LIMIT 20`, now(), like, like, like)
      .map((p) => ({ type: 'Beitrag', title: p.title, url: this.publicUrl(p, false), excerpt: p.excerpt || excerpt(p.content, 160) }));
  }
}

// ---- Darstellung ----

function postCard(posts, p, heading = 'h2') {
  const url = posts.publicUrl(p, false);
  return `<article class="post-card">
  ${p.cover_url ? `<a href="${escapeHtml(url)}" tabindex="-1" aria-hidden="true"><img src="${escapeHtml(p.cover_url)}" alt="" loading="lazy"></a>` : ''}
  <div class="body">
    <p class="meta">${p.categories.map((c) => `<a class="tag" href="/blog/kategorie/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`).join('')}<time datetime="${escapeHtml(p.published_at)}">${dateFmt.format(new Date(p.published_at))}</time></p>
    <${heading}><a href="${escapeHtml(url)}">${escapeHtml(p.title)}</a></${heading}>
    <p>${escapeHtml(p.excerpt || excerpt(p.content, 180))}</p>
  </div>
</article>`;
}

function pager(page, pages, base) {
  if (pages <= 1) return '';
  const link = (n, label) => `<a href="${base}${n > 1 ? `?seite=${n}` : ''}">${label}</a>`;
  return `<nav class="pagination" aria-label="Seiten">${page > 1 ? link(page - 1, '‹ Neuere') : ''}<span>Seite ${page} von ${pages}</span>${
    page < pages ? link(page + 1, 'Ältere ›') : ''
  }</nav>`;
}

function listView(ctx, req, { title, intro = '', categoryId, base }) {
  const perPage = ctx.settings.get('blog_posts_per_page');
  const page = Math.max(1, Number.parseInt(req.query.seite, 10) || 1);
  const { items, total } = ctx.posts.published({ categoryId, limit: perPage, offset: (page - 1) * perPage });
  const pages = Math.max(1, Math.ceil(total / perPage));
  return {
    title: page > 1 ? `${title} – Seite ${page}` : title,
    canonical: ctx.site.url(page > 1 ? `${base}?seite=${page}` : base),
    status: page > pages ? 404 : 200,
    content: `<header class="hero"><h1>${escapeHtml(title)}</h1>${intro}</header>
${items.length ? `<div class="post-list">${items.map((p) => postCard(ctx.posts, p)).join('')}</div>` : '<p class="muted">Noch keine Beiträge veröffentlicht.</p>'}
${pager(page, pages, base)}`,
  };
}

function postView(ctx, req, post) {
  const author = post.author_name ? ` · ${escapeHtml(post.author_name)}` : '';
  return {
    title: post.seo_title || post.title,
    description: post.seo_description || post.excerpt || excerpt(post.content, 160),
    image: post.cover_url ? (post.cover_url.startsWith('http') ? post.cover_url : ctx.site.url(post.cover_url)) : '',
    type: 'article',
    bodyClass: 'post',
    canonical: ctx.posts.publicUrl(post),
    content: `<nav class="breadcrumbs" aria-label="Brotkrumen"><a href="/blog">${escapeHtml(ctx.settings.get('blog_title'))}</a></nav>
<article class="prose">
  <p class="meta">${post.categories.map((c) => `<a class="tag" href="/blog/kategorie/${escapeHtml(c.slug)}">${escapeHtml(c.name)}</a>`).join('')}<time datetime="${escapeHtml(post.published_at)}">${dateFmt.format(new Date(post.published_at))}</time>${author}</p>
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
  version: '1.0.0',
  adminDir: path.join(dir, 'admin'),
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
    hooks.on('site.head', () => `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(settings.get('site_name'))}" href="/blog/feed.xml">`, opts);
    hooks.on('site.search', (q) => ctx.posts.search(q), opts);
    hooks.on(
      'site.sitemap',
      () => [
        { loc: ctx.site.url('/blog') },
        ...ctx.posts.published({ limit: 5000 }).items.map((p) => ({ loc: ctx.posts.publicUrl(p), lastmod: p.updated_at })),
        ...ctx.posts.categories().filter((c) => c.post_count).map((c) => ({ loc: ctx.site.url(`/blog/kategorie/${c.slug}`) })),
      ],
      opts,
    );
    hooks.on(
      'admin.dashboard',
      () => ({ blog: ctx.db.get("SELECT COUNT(*) AS total, SUM(status = 'draft') AS drafts, SUM(status = 'published' AND published_at > ?) AS scheduled FROM posts", now()) }),
      opts,
    );
    hooks.on('menus.resolve', (item) => (item.type === 'blog' ? '/blog' : undefined), opts);
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
      (attrs) => {
        const limit = Math.min(12, Math.max(1, Number(attrs.limit) || 3));
        const cat = attrs.category ? ctx.db.get('SELECT id FROM categories WHERE slug = ?', attrs.category) : null;
        const { items } = ctx.posts.published({ categoryId: cat?.id, limit });
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

    r.get('/', (req, res) => res.json(ctx.posts.list(req.query, pagination(req.query))));
    r.post('/', (req, res) => {
      const data = validate(req.body, postSchema, { partial: true });
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
      const id = parseId(req.params.id);
      res.json({ ...ctx.posts.find(id), url: ctx.posts.publicUrl(ctx.posts.find(id)), revisions: ctx.content.revisions('post', id) });
    });
    r.put('/:id', (req, res) => {
      const id = parseId(req.params.id);
      const before = ctx.posts.find(id);
      const post = ctx.posts.update(id, validate(req.body, postSchema, { partial: true }), req.user?.id);
      publishEvent(before, post, req);
      res.json(post);
    });
    r.delete('/:id', (req, res) => {
      ctx.posts.remove(parseId(req.params.id));
      res.status(204).end();
    });
    r.get('/:id/revisions/:rid', (req, res) => res.json(ctx.content.revision('post', parseId(req.params.id), parseId(req.params.rid))));
    r.post('/:id/revisions/:rid/restore', (req, res) => {
      const id = parseId(req.params.id);
      const rev = ctx.content.revision('post', id, parseId(req.params.rid));
      res.json(ctx.posts.update(id, { title: rev.title, content: rev.content }, req.user?.id));
    });
    router.use('/posts', r);

    const c = Router();
    const catSchema = { name: { type: 'string', required: true, max: 100 }, slug: { type: 'string', max: 100 }, description: { type: 'string', max: 1000 } };
    c.get('/', (req, res) => res.json(ctx.posts.categories()));
    c.post('/', (req, res) => res.status(201).json(ctx.posts.saveCategory(null, validate(req.body, catSchema))));
    c.put('/:id', (req, res) => res.json(ctx.posts.saveCategory(parseId(req.params.id), validate(req.body, catSchema))));
    c.delete('/:id', (req, res) => {
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
      const { items } = ctx.posts.published({ limit: 20 });
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
  <link>${escapeHtml(ctx.site.url('/blog'))}</link>
  <atom:link href="${escapeHtml(ctx.site.url('/blog/feed.xml'))}" rel="self" type="application/rss+xml"/>
  <description>${escapeHtml(s.site_description || s.site_tagline || s.site_name)}</description>
  <language>de-de</language>
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
      ctx.site.send(req, res, postView(ctx, req, post));
    });
  },
};
