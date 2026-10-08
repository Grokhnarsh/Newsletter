import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SearchService } from '../src/core/search.js';
import { startTestServer } from './helpers.js';

describe('Volltextsuche', () => {
  let t;
  const search = async (q) => (await t.get(`/suche?q=${encodeURIComponent(q)}`, { auth: false })).data;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    await t.post('/api/pages', { title: 'Öffnungszeiten', status: 'published', content: '<p>Montag bis Freitag geöffnet. Fahrradständer vorhanden.</p>' });
    await t.post('/api/pages', { title: 'Anfahrt', status: 'published', content: '<p>Mit dem Fahrrad erreichst du uns über die Öffnungszeiten-Straße &lt;script&gt;.</p>' });
    await t.post('/api/pages', { title: 'Geheimer Entwurf', content: '<p>Fahrrad</p>' });
  });
  after(() => t.close());

  test('toMatch baut sichere Präfix-Anfragen', () => {
    assert.equal(SearchService.toMatch('Fahr rad'), '"Fahr"* "rad"*');
    assert.equal(SearchService.toMatch('"; DROP TABLE x --'), '"DROP"* "TABLE"* "x"*');
    assert.equal(SearchService.toMatch('***'), '');
  });

  test('Präfixe, Umlaute ohne Akzent, Titel zuerst, Entwürfe nicht', async () => {
    const r1 = await search('offnungszeit');
    const firstHit = r1.indexOf('href="/oeffnungszeiten"');
    const secondHit = r1.indexOf('href="/anfahrt"');
    assert.ok(firstHit > 0 && secondHit > 0, 'beide Seiten gefunden');
    assert.ok(firstHit < secondHit, 'Treffer im Titel stehen vorne');
    const r2 = await search('Fahrr');
    assert.match(r2, /2 Treffer/);
    assert.doesNotMatch(r2, /Geheimer Entwurf/);
  });

  test('Ausschnitte heben Treffer hervor und sind sicher escaped', async () => {
    const html = await search('Straße');
    assert.match(html, /<mark>Straße<\/mark>/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  test('Änderungen, Löschungen und geplante Beiträge', async () => {
    const page = (await t.get('/api/pages')).data.find((p) => p.title === 'Anfahrt');
    await t.put(`/api/pages/${page.id}`, { content: '<p>Neu: Straßenbahn Linie 4</p>' });
    assert.match(await search('Straßenbahn'), /href="\/anfahrt"/);
    assert.doesNotMatch(await search('Fahrrad'), /href="\/anfahrt"/);
    await t.put(`/api/pages/${page.id}`, { status: 'draft' });
    assert.doesNotMatch(await search('Straßenbahn'), /anfahrt/);

    const future = new Date(Date.now() + 86400_000).toISOString();
    const post = (await t.post('/api/posts', { title: 'Zukunftsmusik', status: 'published', published_at: future })).data;
    assert.match(await search('Zukunftsmusik'), /Keine Treffer/);
    await t.put(`/api/posts/${post.id}`, { published_at: new Date(Date.now() - 1000).toISOString() });
    assert.match(await search('Zukunftsmusik'), /href="\/blog\/zukunftsmusik"/);
    await t.del(`/api/posts/${post.id}`);
    assert.match(await search('Zukunftsmusik'), /Keine Treffer/);
  });

  test('deaktivierte Module erscheinen nicht; Neuaufbau des Index', async () => {
    await t.put('/api/system/modules/blog', { enabled: false });
    assert.doesNotMatch(await search('Hallo Welt'), /Beitrag/);
    await t.put('/api/system/modules/blog', { enabled: true });
    t.db.run('DELETE FROM search_index');
    assert.match(await search('Hallo'), /Keine Treffer/);
    const res = await t.post('/api/system/search/rebuild');
    assert.ok(res.data.documents >= 3);
    assert.match(await search('Hallo'), /href="\/blog\/hallo-welt"/);
  });
});
