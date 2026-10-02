import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { createCms } from '../src/app.js';
import { sanitizeContent, slugify } from '../src/core/content.js';
import { HookBus } from '../src/core/hooks.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { coreMigrations } from '../src/db/migrations.js';
import { createMemoryMailer } from '../src/lib/mailer.js';
import { sniff } from '../src/modules/media/index.js';
import { migrations as newsletterMigrations } from '../src/modules/newsletter/migrations.js';
import { startTestServer } from './helpers.js';

// Minimales gültiges PNG (1×1 Pixel)
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

describe('Kern-Bausteine', () => {
  test('HookBus: filter, collect, first, Priorität und deaktivierte Module', async () => {
    const enabled = new Set(['core', 'a']);
    const hooks = new HookBus({ isEnabled: (m) => enabled.has(m), logger: { error() {} } });
    hooks.on('x', (v) => v + 1, { module: 'a', priority: 20 });
    hooks.on('x', (v) => v * 10, { module: 'a', priority: 5 });
    hooks.on('x', (v) => v - 100, { module: 'b' });
    assert.equal(hooks.filter('x', 1), 11);
    hooks.on('list', () => [1, 2], { module: 'a' });
    hooks.on('list', () => 3, { module: 'core' });
    hooks.on('list', () => null, { module: 'core' });
    assert.deepEqual(hooks.collect('list'), [1, 2, 3]);
    hooks.on('pick', () => undefined, { module: 'a', priority: 1 });
    hooks.on('pick', () => 'b-wins', { module: 'b', priority: 2 });
    hooks.on('pick', () => 'core', { module: 'core', priority: 3 });
    assert.equal(hooks.first('pick'), 'core');
    let seen = 0;
    hooks.on('ev', () => {
      throw new Error('kaputt');
    }, { module: 'a' });
    hooks.on('ev', () => seen++, { module: 'a' });
    await hooks.emit('ev');
    assert.equal(seen, 1, 'Fehler eines Handlers stoppt die anderen nicht');
  });

  test('sanitizeContent entfernt gefährliches HTML', () => {
    const out = sanitizeContent(
      '<p onclick="x()">Hi<script>alert(1)</script></p><a href="javascript:alert(1)">a</a><img src="x.png" onerror="y()"><iframe src="https://evil.example/"></iframe><iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe><a href="/ok" target="_blank">ok</a>',
    );
    assert.doesNotMatch(out, /script|onclick|onerror|javascript:|evil\.example/);
    assert.match(out, /<p>Hi<\/p>/);
    assert.match(out, /youtube-nocookie/);
    assert.match(out, /rel="noopener noreferrer"/);
  });

  test('slugify', () => {
    assert.equal(slugify('Über uns & Größe!'), 'ueber-uns-groesse');
    assert.equal(slugify('  Café — Crème  '), 'cafe-creme');
  });

  test('sniff erkennt Dateitypen anhand der Signatur', () => {
    assert.deepEqual(sniff(PNG), { mime: 'image/png', ext: 'png', width: 1, height: 1 });
    assert.equal(sniff(Buffer.from('%PDF-1.7\n')).mime, 'application/pdf');
    assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
    assert.equal(sniff(Buffer.from('<html><script>alert(1)</script></html>')), null);
  });
});

describe('Module', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('alle Module sind geladen und aktiv; Einrichtung legt Startinhalte an', async () => {
    const mods = (await t.get('/api/system/modules')).data;
    assert.deepEqual(mods.map((m) => m.name), ['media', 'pages', 'blog', 'menus', 'newsletter']);
    assert.ok(mods.every((m) => m.enabled));
    assert.ok(mods.every((m) => m.admin_entry?.startsWith(`/admin/modules/${m.name}/`)));
    const pages = (await t.get('/api/pages')).data;
    assert.ok(pages.find((p) => p.is_home && p.status === 'published'));
    assert.equal((await t.get('/api/posts')).data.total, 1);
    const menus = (await t.get('/api/menus')).data;
    assert.deepEqual(menus.find((m) => m.location === 'main').items.map((i) => i.label), ['Start', 'Über uns', 'Blog', 'Newsletter']);
  });

  test('Admin-Skripte der Module werden ausgeliefert', async () => {
    for (const name of ['media', 'pages', 'blog', 'menus', 'newsletter']) {
      const res = await t.get(`/admin/modules/${name}/index.js`, { auth: false });
      assert.equal(res.status, 200, name);
      assert.match(res.headers.get('content-type'), /javascript/);
    }
  });

  test('Dashboard sammelt Kennzahlen aller Module', async () => {
    const data = (await t.get('/api/system/dashboard')).data;
    for (const key of ['pages', 'blog', 'media', 'newsletter']) assert.ok(data[key], key);
  });

  test('Deaktivieren blendet Routen, Hooks und Shortcodes aus', async () => {
    assert.equal((await t.put('/api/system/modules/blog', { enabled: false })).status, 200);
    assert.equal((await t.get('/blog', { auth: false })).status, 404);
    assert.equal((await t.get('/api/posts')).status, 404);
    const home = (await t.get('/', { auth: false })).data;
    assert.doesNotMatch(home, /href="\/blog"/, 'Blog-Menüpunkt entfällt');
    assert.doesNotMatch(home, /\[recent_posts/, 'Shortcode deaktivierter Module verschwindet');
    assert.doesNotMatch(home, /application\/rss\+xml/);

    await t.put('/api/system/modules/newsletter', { enabled: false });
    assert.equal((await t.get('/subscribe', { auth: false })).status, 404);
    assert.equal((await t.get('/api/subscribers')).status, 404);
    assert.doesNotMatch((await t.get('/', { auth: false })).data, /newsletter-box/);

    await t.put('/api/system/modules/blog', { enabled: true });
    await t.put('/api/system/modules/newsletter', { enabled: true });
    assert.equal((await t.get('/blog', { auth: false })).status, 200);
    assert.match((await t.get('/', { auth: false })).data, /newsletter-box/);
  });

  test('Modulverwaltung nur für Administratoren; unbekannte Module', async () => {
    assert.equal((await t.put('/api/system/modules/gibtsnicht', { enabled: false })).status, 404);
    await t.post('/api/users', { email: 'red@example.com', password: 'redakteur123', role: 'editor' });
    const login = await t.post('/api/auth/login', { email: 'red@example.com', password: 'redakteur123' }, { auth: false });
    const res = await t.put('/api/system/modules/blog', { enabled: false }, { headers: { Authorization: `Bearer ${login.data.token}` } });
    assert.equal(res.status, 403);
  });
});

describe('Seiten', () => {
  let t;
  let parent;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('Hierarchie, Pfade und Brotkrumen', async () => {
    parent = (await t.post('/api/pages', { title: 'Leistungen', status: 'published', content: '<p>Übersicht</p><p>[child_pages]</p>' })).data;
    assert.equal(parent.slug, 'leistungen');
    const child = (await t.post('/api/pages', { title: 'Webdesign', parent_id: parent.id, status: 'published', content: '<p>Schöne Websites</p>' })).data;
    assert.equal(child.path, '/leistungen/webdesign');

    const page = await t.get('/leistungen/webdesign', { auth: false });
    assert.equal(page.status, 200);
    assert.match(page.data, /<h1>Webdesign<\/h1>/);
    assert.match(page.data, /class="breadcrumbs".*href="\/leistungen"/s);
    assert.match(page.data, /<link rel="canonical" href="http:\/\/test.local\/leistungen\/webdesign">/);

    const overview = (await t.get('/leistungen', { auth: false })).data;
    assert.match(overview, /class="child-pages".*href="\/leistungen\/webdesign"/s);
    assert.equal((await t.get('/webdesign', { auth: false })).status, 404);
  });

  test('Validierung: reservierte Slugs, Duplikate, Zyklen', async () => {
    for (const slug of ['blog', 'admin', 'subscribe', 'api']) {
      const res = await t.post('/api/pages', { title: 'X', slug });
      assert.equal(res.status, 400, slug);
    }
    // Unter einer Elternseite ist der Slug erlaubt
    assert.equal((await t.post('/api/pages', { title: 'Blog', parent_id: parent.id })).status, 201);
    assert.equal((await t.post('/api/pages', { title: 'Leistungen' })).status, 409);
    const child = (await t.get('/api/pages')).data.find((p) => p.slug === 'webdesign');
    assert.equal((await t.put(`/api/pages/${parent.id}`, { parent_id: child.id })).status, 400);
    assert.equal((await t.put(`/api/pages/${parent.id}`, { parent_id: parent.id })).status, 400);
  });

  test('Inhalte werden bereinigt; Entwürfe sind nicht öffentlich', async () => {
    const draft = (await t.post('/api/pages', { title: 'Geheim', content: '<p>Text</p><script>alert(1)</script><img src=x onerror=alert(1)>' })).data;
    assert.equal(draft.status, 'draft');
    assert.doesNotMatch(draft.content, /script|onerror/);
    assert.equal((await t.get('/geheim', { auth: false })).status, 404);
    const preview = await t.post('/api/pages/preview', { title: 'Geheim', content: '<p>Vorschau</p>' });
    assert.match(preview.data, /Vorschau/);
    assert.match(preview.data, /noindex/);
  });

  test('Revisionen speichern und wiederherstellen', async () => {
    await t.put(`/api/pages/${parent.id}`, { content: '<p>Version 2</p>' });
    await t.put(`/api/pages/${parent.id}`, { content: '<p>Version 3</p>' });
    const page = (await t.get(`/api/pages/${parent.id}`)).data;
    assert.equal(page.revisions.length, 2);
    const oldest = page.revisions.at(-1);
    const restored = (await t.post(`/api/pages/${parent.id}/revisions/${oldest.id}/restore`)).data;
    assert.match(restored.content, /\[child_pages\]/);
    assert.equal((await t.get(`/api/pages/${parent.id}`)).data.revisions.length, 3);
  });

  test('Startseite, Suche und Sitemap', async () => {
    await t.put('/api/settings', { home_page_id: parent.id });
    const home = await t.get('/', { auth: false });
    assert.match(home.data, /<h1>Leistungen<\/h1>/);
    const redirect = await t.get('/leistungen', { auth: false });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/');
    assert.equal((await t.put('/api/settings', { home_page_id: 99999 })).status, 404);

    const search = (await t.get('/suche?q=Websites', { auth: false })).data;
    assert.match(search, /href="\/leistungen\/webdesign"/);
    const sitemap = (await t.get('/sitemap.xml', { auth: false })).data;
    assert.match(sitemap, /<loc>http:\/\/test.local\/leistungen\/webdesign<\/loc>/);
    assert.doesNotMatch(sitemap, /geheim/);
  });

  test('Löschen hebt Unterseiten eine Ebene an', async () => {
    await t.put('/api/settings', { home_page_id: null });
    await t.del(`/api/pages/${parent.id}`);
    assert.equal((await t.get('/webdesign', { auth: false })).status, 200);
  });
});

describe('Blog', () => {
  let t;
  let cat;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    cat = (await t.post('/api/categories', { name: 'Technik & Tipps' })).data;
  });
  after(() => t.close());

  test('Beitrag veröffentlichen, Kategorie, Startseite, RSS', async () => {
    assert.equal(cat.slug, 'technik-tipps');
    const post = (await t.post('/api/posts', { title: 'Neue Funktion', excerpt: 'Kurz & knapp', content: '<p>Details</p>', status: 'published', category_ids: [cat.id] })).data;
    assert.ok(post.published_at);
    const page = await t.get('/blog/neue-funktion', { auth: false });
    assert.equal(page.status, 200);
    assert.match(page.data, /<meta property="og:type" content="article">/);
    assert.match((await t.get('/blog/kategorie/technik-tipps', { auth: false })).data, /Neue Funktion/);
    const feed = await t.get('/blog/feed.xml', { auth: false });
    assert.match(feed.headers.get('content-type'), /rss\+xml/);
    assert.match(feed.data, /<title>Neue Funktion<\/title>/);
    assert.match(feed.data, /<description>Kurz &amp; knapp<\/description>/);
    assert.match((await t.get('/blog', { auth: false })).data, /post-card/);
  });

  test('geplante Beiträge erscheinen erst zum Zeitpunkt', async () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const post = (await t.post('/api/posts', { title: 'Zukunft', status: 'published', published_at: future })).data;
    assert.equal((await t.get('/blog/zukunft', { auth: false })).status, 404);
    assert.equal((await t.get('/api/posts?status=scheduled')).data.total, 1);
    assert.doesNotMatch((await t.get('/blog/feed.xml', { auth: false })).data, /Zukunft/);
    await t.put(`/api/posts/${post.id}`, { published_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await t.get('/blog/zukunft', { auth: false })).status, 200);
  });

  test('Slug-Konflikte und Entwürfe', async () => {
    assert.equal((await t.post('/api/posts', { title: 'Neue Funktion' })).status, 409);
    const draft = (await t.post('/api/posts', { title: 'Entwurf' })).data;
    assert.equal((await t.get(`/blog/${draft.slug}`, { auth: false })).status, 404);
    assert.equal((await t.post('/api/posts', { title: 'X', slug: 'kategorie' })).status, 400);
  });

  test('Shortcode [recent_posts] auf Seiten', async () => {
    await t.post('/api/pages', { title: 'News', status: 'published', content: '<p>[recent_posts limit="1" category="technik-tipps"]</p>' });
    const html = (await t.get('/news', { auth: false })).data;
    assert.match(html, /Neue Funktion/);
    assert.doesNotMatch(html, /\[recent_posts/);
  });

  test('Newsletter-Integration: Kampagne aus Beitrag und Auto-Entwurf', async () => {
    const post = (await t.get('/api/posts?q=Neue')).data.items[0];
    const campaign = await t.post(`/api/campaigns/from-post/${post.id}`);
    assert.equal(campaign.status, 201);
    assert.equal(campaign.data.subject, 'Neue Funktion');
    assert.match(campaign.data.content_html, /http:\/\/test.local\/blog\/neue-funktion/);
    assert.ok(campaign.data.list_ids.length);

    await t.put('/api/settings', { newsletter_auto_campaign: true });
    const before = (await t.get('/api/campaigns')).data.length;
    const draft = (await t.post('/api/posts', { title: 'Auto-News' })).data;
    assert.equal((await t.get('/api/campaigns')).data.length, before, 'Entwürfe lösen nichts aus');
    await t.put(`/api/posts/${draft.id}`, { status: 'published' });
    await new Promise((r) => setTimeout(r, 20));
    const campaigns = (await t.get('/api/campaigns')).data;
    assert.equal(campaigns.length, before + 1);
    assert.ok(campaigns.some((c) => c.name === 'Blog: Auto-News'));
  });
});

describe('Medien', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('Upload, Auslieferung, Metadaten, Löschen', async () => {
    const res = await t.request('POST', '/api/media', { raw: PNG, headers: { 'Content-Type': 'image/png', 'X-Filename': encodeURIComponent('Mein Bild.png') } });
    assert.equal(res.status, 201);
    const media = res.data;
    assert.match(media.url, /^\/uploads\/\d{4}\/\d{2}\/mein-bild-[0-9a-f]{8}\.png$/);
    assert.equal(media.width, 1);
    assert.equal(media.original_name, 'Mein Bild.png');

    const file = await fetch(t.base + media.url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.match(file.headers.get('content-security-policy'), /sandbox/);

    assert.equal((await t.put(`/api/media/${media.id}`, { alt: 'Ein Pixel' })).data.alt, 'Ein Pixel');
    assert.equal((await t.get('/api/media?type=image')).data.total, 1);
    assert.equal((await t.get('/api/media?type=document')).data.total, 0);

    await t.del(`/api/media/${media.id}`);
    assert.equal((await fetch(t.base + media.url)).status, 404);
  });

  test('gefährliche Dateitypen werden abgelehnt', async () => {
    for (const body of ['<svg onload="alert(1)"></svg>', '<html><script>alert(1)</script></html>', '']) {
      const res = await t.request('POST', '/api/media', { raw: Buffer.from(body), headers: { 'Content-Type': 'image/png', 'X-Filename': 'x.png' } });
      assert.equal(res.status, 400);
    }
  });

  test('Upload erfordert Anmeldung', async () => {
    const res = await t.request('POST', '/api/media', { raw: PNG, headers: { 'Content-Type': 'image/png' }, auth: false });
    assert.equal(res.status, 401);
  });
});

describe('Menüs & Website', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('Menü mit Untereinträgen; Entwürfe werden ausgeblendet', async () => {
    const draft = (await t.post('/api/pages', { title: 'Bald' })).data;
    const pub = (await t.post('/api/pages', { title: 'Kontakt', status: 'published' })).data;
    const saved = await t.put('/api/menus/main', {
      items: [
        { type: 'home', label: 'Start' },
        { type: 'page', label: 'Kontakt', target_id: pub.id, children: [{ type: 'custom', label: 'Extern', url: 'https://example.org', new_tab: true }] },
        { type: 'page', label: 'Bald', target_id: draft.id },
      ],
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data[1].children.length, 1);
    const html = (await t.get('/', { auth: false })).data;
    assert.match(html, /href="\/kontakt"/);
    assert.match(html, /class="submenu".*href="https:\/\/example.org" target="_blank" rel="noopener noreferrer"/s);
    assert.doesNotMatch(html, />Bald</);
  });

  test('Menü-Validierung', async () => {
    assert.equal((await t.put('/api/menus/main', { items: [{ type: 'custom', label: 'X', url: 'javascript:alert(1)' }] })).status, 400);
    assert.equal((await t.put('/api/menus/main', { items: [{ type: 'custom', label: '', url: '/' }] })).status, 400);
    assert.equal((await t.put('/api/menus/sidebar', { items: [] })).status, 404);
  });

  test('Einstellungen der Website erscheinen im Theme', async () => {
    assert.equal((await t.put('/api/settings', { theme_accent_color: 'red;}body{' })).status, 400);
    await t.put('/api/settings', { site_tagline: 'Gute Arbeit', theme_accent_color: '#ff6600', company_address: 'Musterstr. 1\n12345 Musterstadt', imprint_url: '/impressum' });
    const html = (await t.get('/', { auth: false })).data;
    assert.match(html, /--accent:#ff6600/);
    assert.match(html, /Musterstr\. 1<br>12345 Musterstadt/);
    assert.match(html, /href="\/impressum">Impressum/);
  });

  test('Systemseiten: 404, robots.txt, Suche, Newsletter-Seiten im Theme', async () => {
    const notFound = await t.get('/gibt/es/nicht', { auth: false });
    assert.equal(notFound.status, 404);
    assert.match(notFound.data, /Seite nicht gefunden/);
    assert.match(notFound.data, /site-header/);
    assert.match((await t.get('/robots.txt', { auth: false })).data, /Sitemap: http:\/\/test.local\/sitemap.xml/);
    assert.match((await t.get('/suche?q=a', { auth: false })).data, /mindestens zwei Zeichen/);
    const subscribe = (await t.get('/subscribe', { auth: false })).data;
    assert.match(subscribe, /site-header/);
    assert.match(subscribe, /Newsletter abonnieren/);
    assert.equal((await t.get('/api/gibtsnicht')).status, 404);
  });
});

describe('Eigene Module (Beispiel Hinweisbanner)', () => {
  let t;
  before(async () => {
    t = await startTestServer({ modulesDir: path.join(import.meta.dirname, '..', 'examples', 'modules') });
    await t.setupAdmin();
  });
  after(() => t.close());

  test('wird aus dem Modulordner geladen und funktioniert', async () => {
    const mod = (await t.get('/api/system/modules')).data.find((m) => m.name === 'hinweisbanner');
    assert.ok(mod?.enabled);
    assert.equal(mod.admin_entry, '/admin/modules/hinweisbanner/index.js');
    assert.equal((await t.get(mod.admin_entry, { auth: false })).status, 200);

    assert.doesNotMatch((await t.get('/', { auth: false })).data, /notice-banner/);
    assert.equal((await t.put('/api/settings', { banner_link_url: 'javascript:alert(1)' })).status, 400);
    await t.put('/api/settings', { banner_text: 'Sommeraktion <jetzt>', banner_link_url: '/aktion' });
    const home = (await t.get('/', { auth: false })).data;
    assert.match(home, /class="notice-banner" role="note">Sommeraktion &lt;jetzt&gt;/);

    const click = await t.get('/banner/klick', { auth: false });
    assert.equal(click.status, 302);
    assert.equal(click.headers.get('location'), '/aktion');
    assert.deepEqual((await t.get('/api/hinweisbanner/stats')).data, { clicks: 1 });
    assert.deepEqual((await t.get('/api/system/dashboard')).data.hinweisbanner, { clicks: 1 });

    await t.put('/api/system/modules/hinweisbanner', { enabled: false });
    assert.doesNotMatch((await t.get('/', { auth: false })).data, /notice-banner/);
    assert.equal((await t.get('/banner/klick', { auth: false })).status, 404);
  });
});

describe('Migration bestehender Installationen', () => {
  test('Datenbank aus der Zeit vor dem Modulsystem wird übernommen', async () => {
    const file = path.join(os.tmpdir(), `cms-legacy-${process.pid}-${Date.now()}.db`);
    // Alte Installation: alles in schema_migrations Version 1
    const raw = new DatabaseSync(file);
    raw.exec(coreMigrations[0].sql);
    raw.exec(newsletterMigrations[0].sql);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    raw.exec("INSERT INTO schema_migrations VALUES (1, '2026-01-01T00:00:00.000Z')");
    raw.exec(`INSERT INTO subscribers (email, status, token, created_at, updated_at) VALUES ('alt@example.com', 'active', 'tok', '2026-01-01', '2026-01-01')`);
    raw.close();

    const config = loadConfig({ skipDotEnv: true, baseUrl: 'http://test.local' });
    config.worker = { ...config.worker, enabled: false };
    config.modulesDir = null;
    config.uploadsDir = path.join(os.tmpdir(), `cms-legacy-up-${process.pid}`);
    const db = openDatabase(file);
    const { ctx } = await createCms({ db, config, mailer: createMemoryMailer(), logger: { log() {}, warn() {}, error() {} } });
    assert.equal(ctx.subscribers.findByEmail('alt@example.com').status, 'active');
    const migrated = db.all('SELECT module FROM module_migrations ORDER BY module').map((r) => r.module);
    assert.deepEqual(migrated, ['blog', 'media', 'menus', 'newsletter', 'pages']);
    assert.ok(db.get("SELECT 1 AS ok FROM sqlite_master WHERE name = 'content_revisions'"));
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  });
});
