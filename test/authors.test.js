import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startTestServer } from './helpers.js';

describe('Autorenrolle und Freigabe-Workflow', () => {
  let t;
  let adminToken;
  let authorToken;
  let author;
  const as = (token) => ({ headers: { Authorization: `Bearer ${token}` } });

  before(async () => {
    t = await startTestServer();
    adminToken = (await t.setupAdmin()).data.token;
    await t.post('/api/users', { email: 'redaktion@example.com', password: 'redaktion12345', role: 'editor' });
    author = (await t.post('/api/users', { email: 'autorin@example.com', name: 'Alex Autor', password: 'autorin123456', role: 'author' })).data;
    authorToken = (await t.post('/api/auth/login', { email: 'autorin@example.com', password: 'autorin123456' }, { auth: false })).data.token;
  });
  after(() => t.close());

  test('Autoren erreichen nur Seiten, Blog und Medien', async () => {
    const o = as(authorToken);
    assert.equal((await t.get('/api/pages', o)).status, 200);
    assert.equal((await t.get('/api/posts', o)).status, 200);
    assert.equal((await t.get('/api/media', o)).status, 200);
    assert.equal((await t.get('/api/categories', o)).status, 200);
    for (const path of ['/api/subscribers', '/api/campaigns', '/api/menus', '/api/redirects', '/api/forms', '/api/analytics', '/api/users']) {
      assert.equal((await t.get(path, o)).status, 403, path);
    }
    assert.equal((await t.post('/api/categories', { name: 'Neu' }, o)).status, 403);
    assert.equal((await t.post('/api/media/optimize', {}, o)).status, 403);
    // API-Endpunkte, die es nicht gibt, bleiben für Redakteure 404
    assert.equal((await t.get('/api/gibt-es-nicht')).status, 404);

    const dash = (await t.get('/api/system/dashboard', o)).data;
    assert.ok(dash.pages && dash.blog);
    assert.equal(dash.newsletter, undefined);
    assert.equal(dash.stats, undefined);
    const mods = (await t.get('/api/system/modules', o)).data;
    assert.equal(mods.find((m) => m.name === 'pages').authors, true);
    assert.equal(mods.find((m) => m.name === 'newsletter').authors, false);
  });

  test('Autoren schreiben Entwürfe, veröffentlichen aber nicht selbst', async () => {
    const o = as(authorToken);
    assert.equal((await t.post('/api/posts', { title: 'Sofort live', status: 'published' }, o)).status, 403);
    const post = (await t.post('/api/posts', { title: 'Mein Entwurf', content: '<p>Text</p>', published_at: '2020-01-01T00:00:00Z' }, o)).data;
    assert.equal(post.status, 'draft');
    assert.equal(post.author_id, author.id);
    assert.equal(post.published_at, null, 'Erscheinungsdatum setzt die Redaktion');

    assert.equal((await t.put(`/api/posts/${post.id}`, { content: '<p>Überarbeitet</p>' }, o)).status, 200);
    assert.equal((await t.put(`/api/posts/${post.id}`, { status: 'published' }, o)).status, 403);

    // Fremde Inhalte sind sichtbar, aber nicht änderbar
    const hello = (await t.get('/api/posts', o)).data.items.find((p) => p.title === 'Hallo Welt!');
    assert.equal(hello.can_edit, false);
    assert.equal((await t.put(`/api/posts/${hello.id}`, { title: 'Gekapert' }, o)).status, 403);
    assert.equal((await t.del(`/api/posts/${hello.id}`, o)).status, 403);
    const about = (await t.get('/api/pages', o)).data.find((p) => p.slug === 'ueber-uns');
    assert.equal(about.can_edit, false);
    assert.equal((await t.put(`/api/pages/${about.id}`, { content: 'x' }, o)).status, 403);
  });

  test('Einreichen benachrichtigt die Redaktion, Zurückgeben und Veröffentlichen den Autor', async () => {
    const o = as(authorToken);
    const page = (await t.post('/api/pages', { title: 'Team', content: '<p>Wir sind …</p>' }, o)).data;
    t.mailer.sent.length = 0;
    const submitted = await t.post(`/api/pages/${page.id}/submit`, {}, o);
    assert.equal(submitted.status, 200);
    assert.ok(submitted.data.review_requested_at);
    assert.equal(submitted.data.notified, 2);
    assert.deepEqual(t.mailer.sent.map((m) => m.to).sort(), ['admin@example.com', 'redaktion@example.com']);
    assert.match(t.mailer.sent[0].subject, /Zur Prüfung: Team/);
    assert.match(t.mailer.sent[0].html, new RegExp(`/admin/#/pages/${page.id}`));

    // Autoren können nicht selbst zurückgeben; Redaktion gibt mit Hinweis zurück
    assert.equal((await t.post(`/api/pages/${page.id}/decline`, { note: 'x' }, o)).status, 403);
    t.mailer.sent.length = 0;
    const declined = (await t.post(`/api/pages/${page.id}/decline`, { note: 'Bitte ein Foto ergänzen.' })).data;
    assert.equal(declined.review_requested_at, null);
    assert.equal(declined.review_note, 'Bitte ein Foto ergänzen.');
    assert.equal(t.mailer.sent[0].to, 'autorin@example.com');
    assert.match(t.mailer.sent[0].html, /Bitte ein Foto ergänzen\./);

    // Erneut einreichen, dann veröffentlicht die Redaktion
    await t.post(`/api/pages/${page.id}/submit`, {}, o);
    const dash = (await t.get('/api/system/dashboard')).data;
    assert.equal(dash.pages.review, 1);
    t.mailer.sent.length = 0;
    const published = (await t.put(`/api/pages/${page.id}`, { status: 'published' })).data;
    assert.equal(published.status, 'published');
    assert.equal(published.review_requested_at, null);
    assert.equal(t.mailer.sent[0].to, 'autorin@example.com');
    assert.match(t.mailer.sent[0].subject, /Veröffentlicht: Team/);

    // Danach ist die Seite für den Autor schreibgeschützt
    assert.equal((await t.put(`/api/pages/${page.id}`, { title: 'Neu' }, o)).status, 403);
    assert.equal((await t.post(`/api/pages/${page.id}/submit`, {}, o)).status, 403);
  });

  test('Liste der eingereichten Beiträge für die Redaktion', async () => {
    const o = as(authorToken);
    const post = (await t.post('/api/posts', { title: 'Zur Freigabe' }, o)).data;
    await t.post(`/api/posts/${post.id}/submit`, {}, o);
    const list = (await t.get('/api/posts?status=review')).data;
    assert.deepEqual(list.items.map((p) => p.title), ['Zur Freigabe']);
    const mine = (await t.get(`/api/posts?author_id=${author.id}`, o)).data;
    assert.ok(mine.items.every((p) => p.author_id === author.id));
  });

  test('Medien: Autoren ändern nur eigene Dateien', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const upload = (token) =>
      t.request('POST', '/api/media', { raw: png, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png', 'X-Filename': 'punkt.png' } });
    const mine = (await upload(authorToken)).data;
    const theirs = (await upload(adminToken)).data;
    assert.equal((await t.put(`/api/media/${mine.id}`, { alt: 'Punkt' }, as(authorToken))).status, 200);
    assert.equal((await t.put(`/api/media/${theirs.id}`, { alt: 'x' }, as(authorToken))).status, 403);
    assert.equal((await t.del(`/api/media/${theirs.id}`, as(authorToken))).status, 403);
    assert.equal((await t.del(`/api/media/${mine.id}`, as(authorToken))).status, 204);
  });

  test('Einstellungen ohne Geheimnisse, Änderungen nur für Administratoren', async () => {
    const o = as(authorToken);
    const s = await t.get('/api/settings', o);
    assert.equal(s.status, 200);
    assert.ok(s.data.site_name);
    assert.equal((await t.put('/api/settings', { site_name: 'X' }, o)).status, 403);
  });
});
