import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { normalizePath } from '../src/modules/redirects/index.js';
import { startTestServer } from './helpers.js';

describe('Weiterleitungen', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('normalizePath', () => {
    assert.equal(normalizePath('alt/seite/'), '/alt/seite');
    assert.equal(normalizePath('https://example.org/x/?a=1#b'), '/x');
    assert.equal(normalizePath('//doppelt//pfad'), '/doppelt/pfad');
  });

  test('manuelle Weiterleitungen: 301, Platzhalter, 410, Abfrage bleibt erhalten', async () => {
    assert.equal((await t.post('/api/redirects', { source: '/alt', target: '/ueber-uns', code: 301 })).status, 201);
    assert.equal((await t.post('/api/redirects', { source: '/alt/', target: '/x' })).status, 409, 'normalisierte Quelle ist eindeutig');
    await t.post('/api/redirects', { source: '/archiv/*', target: '/blog/*', code: 302 });
    await t.post('/api/redirects', { source: '/weg', code: 410 });

    const r1 = await t.get('/alt?utm=1', { auth: false });
    assert.equal(r1.status, 301);
    assert.equal(r1.headers.get('location'), '/ueber-uns?utm=1');
    const r2 = await t.get('/archiv/hallo-welt', { auth: false });
    assert.equal(r2.status, 302);
    assert.equal(r2.headers.get('location'), '/blog/hallo-welt');
    assert.equal((await t.get('/weg', { auth: false })).status, 410);

    const list = (await t.get('/api/redirects')).data;
    assert.equal(list.items.find((r) => r.source === '/alt').hits, 1);
  });

  test('Validierung', async () => {
    assert.equal((await t.post('/api/redirects', { source: '/a', target: 'javascript:alert(1)' })).status, 400);
    assert.equal((await t.post('/api/redirects', { source: '/a', target: '//evil.example' })).status, 400);
    assert.equal((await t.post('/api/redirects', { source: '/admin/x', target: '/' })).status, 400);
    assert.equal((await t.post('/api/redirects', { source: '/a', target: '/a' })).status, 400);
  });

  test('vorhandene Seiten haben Vorrang vor Weiterleitungen', async () => {
    await t.post('/api/redirects', { source: '/ueber-uns', target: '/anders' });
    assert.equal((await t.get('/ueber-uns', { auth: false })).status, 200);
  });

  test('geänderte Seiten-Adressen werden automatisch weitergeleitet – auch Unterseiten und Ketten', async () => {
    const parent = (await t.post('/api/pages', { title: 'Leistungen', status: 'published' })).data;
    await t.post('/api/pages', { title: 'Beratung', parent_id: parent.id, status: 'published' });
    await t.put(`/api/pages/${parent.id}`, { slug: 'angebot' });

    let r = await t.get('/leistungen/beratung', { auth: false });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/angebot/beratung');
    assert.equal((await t.get('/leistungen', { auth: false })).headers.get('location'), '/angebot');

    // Zweite Umbenennung: keine Kette, alte Adresse zeigt direkt aufs neue Ziel
    await t.put(`/api/pages/${parent.id}`, { slug: 'services' });
    r = await t.get('/leistungen', { auth: false });
    assert.equal(r.headers.get('location'), '/services');
    // Zurückbenennen entfernt die Weiterleitung, die die Seite überdecken würde
    await t.put(`/api/pages/${parent.id}`, { slug: 'leistungen' });
    assert.equal((await t.get('/leistungen', { auth: false })).status, 200);
    assert.equal((await t.get('/services', { auth: false })).headers.get('location'), '/leistungen');

    const auto = (await t.get('/api/redirects?q=beratung')).data.items;
    assert.ok(auto.every((x) => x.auto));
  });

  test('Entwürfe erzeugen keine Weiterleitungen; Blog-Slugs schon', async () => {
    const draft = (await t.post('/api/pages', { title: 'Entwurf' })).data;
    await t.put(`/api/pages/${draft.id}`, { slug: 'entwurf-neu' });
    assert.equal((await t.get('/api/redirects?q=entwurf')).data.total, 0);

    const post = (await t.get('/api/posts')).data.items[0];
    await t.put(`/api/posts/${post.id}`, { slug: 'hallo-neue-welt' });
    const r = await t.get(`/blog/${post.slug}`, { auth: false });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/blog/hallo-neue-welt');
  });

  test('404-Protokoll', async () => {
    await t.get('/gibt-es-nicht', { auth: false, headers: { Referer: 'https://partner.example/link' } });
    await t.get('/gibt-es-nicht', { auth: false });
    await t.get('/wp-login.php', { auth: false });
    const misses = (await t.get('/api/redirects/misses')).data;
    const miss = misses.find((m) => m.path === '/gibt-es-nicht');
    assert.equal(miss.hits, 2);
    assert.equal(miss.referrer, 'https://partner.example/link');
    assert.ok(!misses.some((m) => m.path.includes('wp-')), 'Scanner-Anfragen werden ignoriert');
    await t.post('/api/redirects', { source: '/gibt-es-nicht', target: '/' });
    assert.ok(!(await t.get('/api/redirects/misses')).data.some((m) => m.path === '/gibt-es-nicht'));
  });
});
