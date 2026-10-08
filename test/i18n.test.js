import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

describe('Mehrsprachigkeit', () => {
  let t;
  let about;
  let aboutEn;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('einsprachig: keine Präfixe, kein Umschalter', async () => {
    const home = (await t.get('/', { auth: false })).data;
    assert.match(home, /<html lang="de">/);
    assert.doesNotMatch(home, /lang-switch|hreflang/);
    assert.equal((await t.get('/en/ueber-uns', { auth: false })).status, 404);
  });

  test('Sprachen einrichten und validieren', async () => {
    assert.equal((await t.put('/api/settings', { site_languages: 'de; en' })).status, 400);
    assert.equal((await t.put('/api/settings', { site_languages: 'de, en' })).status, 200);
    // Sprachkürzel sind als Seitenadresse reserviert
    assert.equal((await t.post('/api/pages', { title: 'EN', slug: 'en' })).status, 400);
  });

  test('Seite übersetzen: Entwurf mit kopiertem Inhalt, eigene Adresse unter /en', async () => {
    about = (await t.get('/api/pages')).data.find((p) => p.slug === 'ueber-uns');
    assert.equal(about.lang, 'de');
    const res = await t.post(`/api/pages/${about.id}/translate`, { lang: 'en' });
    assert.equal(res.status, 201);
    aboutEn = res.data;
    assert.equal(aboutEn.status, 'draft');
    assert.equal(aboutEn.translation_of, about.id);
    assert.equal((await t.post(`/api/pages/${about.id}/translate`, { lang: 'en' })).status, 409);
    assert.equal((await t.post(`/api/pages/${about.id}/translate`, { lang: 'fr' })).status, 400);

    // Gleicher Slug in anderer Sprache ist erlaubt
    await t.put(`/api/pages/${aboutEn.id}`, { title: 'About us', content: '<p>Who we are.</p>', status: 'published' });
    const en = await t.get('/en/ueber-uns', { auth: false });
    assert.equal(en.status, 200);
    assert.match(en.data, /<html lang="en">/);
    assert.match(en.data, /Who we are\./);
    assert.match(en.data, /<link rel="alternate" hreflang="de" href="http:\/\/test.local\/ueber-uns">/);
    assert.match(en.data, /<link rel="alternate" hreflang="en" href="http:\/\/test.local\/en\/ueber-uns">/);
    assert.match(en.data, /hreflang="x-default"/);
    assert.match(en.data, /Skip to content/);
    assert.match(en.data, /<a href="\/ueber-uns" hreflang="de"/, 'Umschalter verlinkt die deutsche Fassung');

    const de = (await t.get('/ueber-uns', { auth: false })).data;
    assert.match(de, /Erzähle hier/);
    assert.match(de, /<a href="\/en\/ueber-uns" hreflang="en"/);

    const details = (await t.get(`/api/pages/${about.id}`)).data;
    assert.deepEqual(details.translations.map((x) => [x.lang, x.url]), [['de', '/ueber-uns'], ['en', '/en/ueber-uns']]);
  });

  test('Startseite, Menü und Sitemap je Sprache', async () => {
    const homeId = (await t.get('/api/settings')).data.home_page_id;
    const homeEn = (await t.post(`/api/pages/${homeId}/translate`, { lang: 'en' })).data;
    await t.put(`/api/pages/${homeEn.id}`, { title: 'Welcome', content: '<h1>Welcome to our website</h1>', status: 'published' });
    const en = (await t.get('/en', { auth: false })).data;
    assert.match(en, /Welcome to our website/);
    // Menü der Standardsprache, Seiten zeigen auf ihre Übersetzung
    assert.match(en, /href="\/en\/ueber-uns"/);
    assert.match(en, /href="\/en\/blog"/);
    assert.equal((await t.get('/en/willkommen', { auth: false })).headers.get('location'), '/en');

    // Eigenes englisches Menü ersetzt das Standardmenü
    const menus = (await t.get('/api/menus')).data;
    assert.ok(menus.some((m) => m.location === 'main:en'));
    await t.put('/api/menus/main:en', { items: [{ type: 'custom', label: 'Contact', url: '/en/contact' }] });
    const en2 = (await t.get('/en/ueber-uns', { auth: false })).data;
    assert.match(en2, />Contact</);
    assert.doesNotMatch((await t.get('/ueber-uns', { auth: false })).data, />Contact</);

    const sitemap = (await t.get('/sitemap.xml', { auth: false })).data;
    assert.match(sitemap, /<loc>http:\/\/test.local\/en\/ueber-uns<\/loc>/);
    assert.match(sitemap, /<loc>http:\/\/test.local\/en\/blog<\/loc>/);
  });

  test('Blog: Beiträge je Sprache, Übersetzung mit eigener Adresse, Weiterleitung bei falscher Sprache', async () => {
    const hello = (await t.get('/api/posts')).data.items.find((p) => p.title === 'Hallo Welt!');
    const tr = (await t.post(`/api/posts/${hello.id}/translate`, { lang: 'en' })).data;
    assert.equal(tr.slug, 'hallo-welt-en');
    await t.put(`/api/posts/${tr.id}`, { title: 'Hello world!', slug: 'hello-world', status: 'published' });

    const enList = (await t.get('/en/blog', { auth: false })).data;
    assert.match(enList, /Hello world!/);
    assert.doesNotMatch(enList, /Hallo Welt!/);
    const deList = (await t.get('/blog', { auth: false })).data;
    assert.match(deList, /Hallo Welt!/);
    assert.doesNotMatch(deList, /Hello world!/);

    const post = await t.get('/en/blog/hello-world', { auth: false });
    assert.equal(post.status, 200);
    assert.match(post.data, /hreflang="de" href="http:\/\/test.local\/blog\/hallo-welt"/);
    assert.equal((await t.get('/blog/hello-world', { auth: false })).headers.get('location'), '/en/blog/hello-world');

    const feed = (await t.get('/en/blog/feed.xml', { auth: false })).data;
    assert.match(feed, /<language>en<\/language>/);
    assert.match(feed, /http:\/\/test.local\/en\/blog\/hello-world/);
    assert.doesNotMatch(feed, /hallo-welt/);

    const listEn = (await t.get('/api/posts?lang=en')).data.items;
    assert.deepEqual(listEn.map((p) => p.title), ['Hello world!']);
  });

  test('Suche zeigt Treffer der aktuellen Sprache', async () => {
    const en = (await t.get('/en/suche?q=world', { auth: false })).data;
    assert.match(en, /Hello world!/);
    assert.match(en, /results/);
    const de = (await t.get('/suche?q=world', { auth: false })).data;
    assert.doesNotMatch(de, /Hello world!/);
  });

  test('Löschen des Originals hält die Übersetzungen zusammen', async () => {
    const page = (await t.post('/api/pages', { title: 'Team', status: 'published' })).data;
    const en = (await t.post(`/api/pages/${page.id}/translate`, { lang: 'en' })).data;
    await t.del(`/api/pages/${page.id}`);
    const left = (await t.get(`/api/pages/${en.id}`)).data;
    assert.equal(left.translation_of, null);
    assert.deepEqual(left.translations.map((x) => x.id), [en.id]);
  });
});
