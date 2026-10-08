import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadSharp } from '../src/modules/media/index.js';
import { startTestServer } from './helpers.js';

const sharp = await loadSharp();

describe('Bildoptimierung', { skip: !sharp && 'sharp ist nicht installiert' }, () => {
  let t;
  let jpeg;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    // 3000×2000-JPEG mit Metadaten (EXIF, inkl. GPS-ähnlicher Angaben)
    jpeg = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 40, g: 120, b: 210 } } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'Geheim', Artist: 'Kamera' } } })
      .toBuffer();
  });
  after(() => t.close());

  test('Upload wird verkleinert, von Metadaten befreit und in WebP-Varianten abgelegt', async () => {
    const res = await t.request('POST', '/api/media', { raw: jpeg, headers: { 'Content-Type': 'image/jpeg', 'X-Filename': 'foto.jpg' } });
    assert.equal(res.status, 201);
    const m = res.data;
    assert.equal(m.width, 2560);
    assert.equal(m.height, 1707);
    assert.deepEqual(m.variants.map((v) => v.width), [480, 960, 1600]);
    assert.ok(m.variants.every((v) => v.url.endsWith('.webp')));

    const original = Buffer.from(await (await fetch(t.base + m.url)).arrayBuffer());
    const meta = await sharp(original).metadata();
    assert.equal(meta.width, 2560);
    assert.equal(meta.exif, undefined, 'EXIF-Daten wurden entfernt');
    const variant = await fetch(t.base + m.variants[0].url);
    assert.equal(variant.headers.get('content-type'), 'image/webp');

    // Auf der Website: srcset, sizes, Maße und Lazy Loading
    await t.put(`/api/media/${m.id}`, { alt: 'Blaue Fläche' });
    await t.post('/api/pages', { title: 'Galerie', status: 'published', content: `<p><img src="${m.url}"></p>`, cover_url: m.url });
    const html = (await t.get('/galerie', { auth: false })).data;
    const tag = html.match(new RegExp(`<img src="${m.url}"[^>]*>`))[0];
    assert.match(tag, /srcset="[^"]*-w480\.webp 480w, [^"]*-w960\.webp 960w, [^"]*-w1600\.webp 1600w, [^"]* 2560w"/);
    assert.match(tag, /width="2560" height="1707"/);
    assert.match(tag, /loading="lazy"/);
    assert.match(tag, /alt="Blaue Fläche"/);
    assert.match(html, /<img class="cover" src="[^"]+" srcset="[^"]+"[^>]*alt="">/, 'auch Titelbilder');

    await t.del(`/api/media/${m.id}`);
    assert.equal((await fetch(t.base + m.variants[0].url)).status, 404, 'Varianten werden mitgelöscht');
  });

  test('Kleine Bilder bekommen keine größeren Varianten; GIFs bleiben unverändert', async () => {
    const small = await sharp({ create: { width: 600, height: 400, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const m = (await t.request('POST', '/api/media', { raw: small, headers: { 'X-Filename': 'klein.png' } })).data;
    assert.deepEqual(m.variants.map((v) => v.width), [480]);
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const g = (await t.request('POST', '/api/media', { raw: gif, headers: { 'X-Filename': 'a.gif' } })).data;
    assert.deepEqual(g.variants, []);
    assert.equal(g.size, gif.length);
  });

  test('Vorhandene Bilder nachträglich optimieren', async () => {
    const big = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#00ff00' } }).png().toBuffer();
    const m = (await t.request('POST', '/api/media', { raw: big, headers: { 'X-Filename': 'alt.png' } })).data;
    t.db.run("UPDATE media SET variants = '[]' WHERE id = ?", m.id);
    const res = (await t.post('/api/media/optimize')).data;
    assert.equal(res.optimized, 1);
    assert.equal((await t.get(`/api/media/${m.id}`)).data.variants.length, 2);
  });
});
