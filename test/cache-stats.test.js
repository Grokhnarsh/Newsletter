import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { deviceOf } from '../src/modules/stats/index.js';
import { startTestServer } from './helpers.js';

const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';

describe('Seiten-Cache', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('zweiter Aufruf kommt aus dem Cache, Änderungen leeren ihn', async () => {
    const page = (await t.post('/api/pages', { title: 'Cache-Test', content: '<p>Version eins</p>', status: 'published' })).data;
    const r1 = await t.get('/cache-test', { auth: false });
    assert.equal(r1.headers.get('x-cache'), 'MISS');
    const r2 = await t.get('/cache-test', { auth: false });
    assert.equal(r2.headers.get('x-cache'), 'HIT');
    assert.equal(r2.data, r1.data);

    await t.put(`/api/pages/${page.id}`, { content: '<p>Version zwei</p>' });
    const r3 = await t.get('/cache-test', { auth: false });
    assert.equal(r3.headers.get('x-cache'), 'MISS');
    assert.match(r3.data, /Version zwei/);
  });

  test('nicht indexierte Seiten, Fehlerseiten und Abfragen der Suche werden nicht gespeichert', async () => {
    await t.get('/gibt-es-nicht', { auth: false });
    assert.equal((await t.get('/gibt-es-nicht', { auth: false })).headers.get('x-cache'), null);
    await t.get('/suche?q=cache', { auth: false });
    assert.equal((await t.get('/suche?q=cache', { auth: false })).headers.get('x-cache'), null);
  });

  test('Statusabfrage, manuelles Leeren und TTL 0 schaltet ab', async () => {
    await t.get('/cache-test', { auth: false });
    assert.ok((await t.get('/api/system/cache')).data.entries >= 1);
    assert.equal((await t.del('/api/system/cache')).status, 204);
    assert.equal((await t.get('/api/system/cache')).data.entries, 0);

    await t.put('/api/settings', { cache_ttl_seconds: 0 });
    await t.get('/cache-test', { auth: false });
    assert.equal((await t.get('/cache-test', { auth: false })).headers.get('x-cache'), null);
    assert.equal((await t.put('/api/settings', { cache_ttl_seconds: -5 })).status, 400);
  });
});

describe('Besucherstatistik', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  const visit = (path, headers = {}) => t.get(path, { auth: false, headers: { 'User-Agent': UA_DESKTOP, ...headers } });

  test('Geräteerkennung', () => {
    assert.equal(deviceOf(UA_DESKTOP), 'Desktop');
    assert.equal(deviceOf(UA_PHONE), 'Smartphone');
    assert.equal(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)'), 'Tablet');
  });

  test('zählt Aufrufe, Besucher, Herkunft und Geräte – ohne Bots und ohne IP-Adressen', async () => {
    await visit('/');
    await visit('/', { Referer: 'https://www.suchmaschine.example/?q=x' });
    await visit('/ueber-uns', { Referer: 'http://test.local/' });
    await visit('/', { 'User-Agent': UA_PHONE });
    await visit('/', { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    await visit('/gibt-es-nicht');
    await visit('/admin/');
    await wait(30);

    const r = (await t.get('/api/analytics?days=7')).data;
    assert.equal(r.days.length, 7);
    assert.deepEqual(r.totals, { views: 4, visitors: 2 });
    assert.deepEqual(r.pages.map((p) => [p.key, p.n]), [['/', 3], ['/ueber-uns', 1]]);
    assert.deepEqual(r.referrers, [{ key: 'suchmaschine.example', n: 1 }]);
    assert.deepEqual(r.devices.map((d) => d.key).sort(), ['Desktop', 'Smartphone']);

    const dump = JSON.stringify(t.db.all('SELECT * FROM stats_visitors'));
    assert.doesNotMatch(dump, /127\.0\.0\.1/);

    const dash = (await t.get('/api/system/dashboard')).data;
    assert.equal(dash.stats.views, 4);
  });

  test('Aufrufe aus dem Seiten-Cache werden ebenfalls gezählt', async () => {
    const before = (await t.get('/api/analytics')).data.totals.views;
    await visit('/ueber-uns');
    await wait(30);
    assert.equal((await t.get('/api/analytics')).data.totals.views, before + 1);
  });
});
