import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pathOf, startTestServer, urls } from './helpers.js';

describe('Authentifizierung & Einrichtung', () => {
  let t;
  before(async () => {
    t = await startTestServer();
  });
  after(() => t.close());

  test('Einrichtung nur einmal möglich', async () => {
    assert.deepEqual((await t.get('/api/auth/status')).data, { needs_setup: true });
    const account = { email: 'fremd@example.com', password: 'sehrgeheim123' };
    assert.equal((await t.post('/api/auth/setup', account)).status, 400, 'ohne Einrichtungscode');
    assert.equal((await t.post('/api/auth/setup', { ...account, setup_token: 'geraten' })).status, 400, 'falscher Einrichtungscode');
    assert.deepEqual((await t.get('/api/auth/status')).data, { needs_setup: true });
    const res = await t.setupAdmin();
    assert.equal(res.status, 201);
    assert.equal(res.data.user.role, 'admin');
    assert.deepEqual((await t.get('/api/auth/status')).data, { needs_setup: false });
    const again = await t.post('/api/auth/setup', { email: 'x@example.com', password: 'sehrgeheim123' });
    assert.equal(again.status, 403);
    // Standardliste und -vorlage wurden angelegt
    const lists = (await t.get('/api/lists')).data;
    assert.equal(lists.length, 1);
    assert.equal(lists[0].is_public, true);
    assert.equal((await t.get('/api/templates')).data.length, 1);
  });

  test('geschützte Endpunkte verlangen Anmeldung', async () => {
    const res = await t.get('/api/subscribers', { auth: false });
    assert.equal(res.status, 401);
    const bad = await t.get('/api/subscribers', { headers: { Authorization: 'Bearer falsch' } });
    assert.equal(bad.status, 401);
  });

  test('Login, falsches Passwort, Logout', async () => {
    const wrong = await t.post('/api/auth/login', { email: 'admin@example.com', password: 'falsch12345' }, { auth: false });
    assert.equal(wrong.status, 401);
    const ok = await t.post('/api/auth/login', { email: 'ADMIN@example.com', password: 'sehrgeheim123' }, { auth: false });
    assert.equal(ok.status, 200);
    const token = ok.data.token;
    assert.equal((await t.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).data.email, 'admin@example.com');
    await t.post('/api/auth/logout', {}, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await t.get('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  });

  test('Redakteure dürfen keine Benutzer oder Einstellungen verwalten', async () => {
    const created = await t.post('/api/users', { email: 'red@example.com', password: 'redakteur123', role: 'editor' });
    assert.equal(created.status, 201);
    const login = await t.post('/api/auth/login', { email: 'red@example.com', password: 'redakteur123' }, { auth: false });
    const h = { Authorization: `Bearer ${login.data.token}` };
    assert.equal((await t.get('/api/users', { headers: h })).status, 403);
    assert.equal((await t.put('/api/settings', { site_name: 'x' }, { headers: h })).status, 403);
    assert.equal((await t.get('/api/subscribers', { headers: h })).status, 200);
  });

  test('letzter Administrator kann nicht gelöscht oder herabgestuft werden', async () => {
    const me = (await t.get('/api/auth/me')).data;
    assert.equal((await t.del(`/api/users/${me.id}`)).status, 400);
    assert.equal((await t.put(`/api/users/${me.id}`, { role: 'editor' })).status, 400);
  });

  test('Login-Sperre zählt nur Fehlversuche (pro Konto)', async () => {
    for (let i = 0; i < 25; i++) {
      assert.equal((await t.post('/api/auth/login', { email: 'admin@example.com', password: 'sehrgeheim123' }, { auth: false })).status, 200);
    }
    await t.post('/api/users', { email: 'sperre@example.com', password: 'sperrkonto123', role: 'editor' });
    for (let i = 0; i < 10; i++) await t.post('/api/auth/login', { email: 'sperre@example.com', password: 'falsch12345' }, { auth: false });
    const locked = await t.post('/api/auth/login', { email: 'sperre@example.com', password: 'sperrkonto123' }, { auth: false });
    assert.equal(locked.status, 429);
    assert.equal((await t.post('/api/auth/login', { email: 'admin@example.com', password: 'sehrgeheim123' }, { auth: false })).status, 200, 'andere Konten bleiben nutzbar');
  });

  test('E-Mail-Adresse nur mit aktuellem Passwort änderbar', async () => {
    await t.post('/api/users', { email: 'konto@example.com', password: 'kontopasswort1', role: 'editor' });
    const h = { Authorization: `Bearer ${(await t.post('/api/auth/login', { email: 'konto@example.com', password: 'kontopasswort1' }, { auth: false })).data.token}` };
    assert.equal((await t.put('/api/auth/me', { email: 'neu@example.com' }, { headers: h })).status, 400);
    assert.equal((await t.put('/api/auth/me', { name: 'Nur Name' }, { headers: h })).status, 200);
    const ok = await t.put('/api/auth/me', { email: 'neu@example.com', current_password: 'kontopasswort1' }, { headers: h });
    assert.equal(ok.data.email, 'neu@example.com');
  });

  test('große Anfragen ohne Anmeldung werden nicht gelesen', async () => {
    const big = JSON.stringify({ csv: 'x'.repeat(500_000) });
    const res = await t.request('POST', '/api/subscribers/import', { raw: big, headers: { 'Content-Type': 'application/json' }, auth: false });
    assert.equal(res.status, 413);
  });

  test('API-Schlüssel eines gelöschten Benutzers werden ungültig', async () => {
    await t.post('/api/users', { email: 'admin2@example.com', password: 'sehrgeheim123', role: 'admin' });
    const login = await t.post('/api/auth/login', { email: 'admin2@example.com', password: 'sehrgeheim123' }, { auth: false });
    const key = (await t.post('/api/api-keys', { name: 'Alt' }, { headers: { Authorization: `Bearer ${login.data.token}` } })).data;
    const h = { Authorization: `Bearer ${key.key}` };
    assert.equal((await t.get('/api/lists', { headers: h })).status, 200);
    await t.del(`/api/users/${login.data.user.id}`);
    assert.equal((await t.get('/api/lists', { headers: h })).status, 401);
  });

  test('API-Schlüssel', async () => {
    const key = (await t.post('/api/api-keys', { name: 'Shop' })).data;
    assert.match(key.key, /^nlk_/);
    const h = { Authorization: `Bearer ${key.key}` };
    assert.equal((await t.get('/api/lists', { headers: h })).status, 200);
    assert.equal((await t.get('/api/api-keys', { headers: h })).status, 403);
    assert.equal((await t.get('/api/lists', { headers: { 'X-API-Key': key.key }, auth: false })).status, 200);
    await t.del(`/api/api-keys/${key.id}`);
    assert.equal((await t.get('/api/lists', { headers: h })).status, 401);
  });
});

describe('Abonnenten', () => {
  let t;
  let listId;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    listId = (await t.post('/api/lists', { name: 'Intern', is_public: false })).data.id;
  });
  after(() => t.close());

  test('anlegen, Duplikat, bearbeiten, Details', async () => {
    const res = await t.post('/api/subscribers', { email: 'Anna@Example.com', first_name: 'Anna', list_ids: [listId], attributes: { firma: 'ACME' } });
    assert.equal(res.status, 201);
    assert.equal(res.data.email, 'anna@example.com');
    assert.deepEqual(res.data.list_ids, [listId]);
    assert.equal((await t.post('/api/subscribers', { email: 'anna@example.com' })).status, 409);
    assert.equal((await t.post('/api/subscribers', { email: 'kaputt' })).status, 400);
    assert.equal((await t.post('/api/subscribers', { email: 'x@example.com', list_ids: [999] })).status, 404);

    const upd = await t.put(`/api/subscribers/${res.data.id}`, { last_name: 'Schmidt', status: 'unsubscribed' });
    assert.equal(upd.data.last_name, 'Schmidt');
    assert.equal(upd.data.status, 'unsubscribed');
    assert.ok(upd.data.unsubscribed_at);

    const details = (await t.get(`/api/subscribers/${res.data.id}`)).data;
    assert.deepEqual(details.events.map((e) => e.type).sort(), ['created', 'subscribed', 'unsubscribed']);
  });

  test('Import aus CSV mit eigenen Feldern', async () => {
    const csv = 'E-Mail;Vorname;Nachname;Stadt\nbernd@example.com;Bernd;Meier;Berlin\nanna@example.com;Anna;;Köln\nungültig;;;\n';
    const res = await t.post('/api/subscribers/import', { csv, list_ids: [listId] });
    assert.equal(res.status, 200);
    assert.equal(res.data.created, 1);
    assert.equal(res.data.updated, 1);
    assert.equal(res.data.errors.length, 1);
    assert.equal(res.data.errors[0].row, 4);
    const bernd = (await t.get('/api/subscribers?q=bernd')).data.items[0];
    assert.equal(bernd.attributes.stadt, 'Berlin');
    assert.equal(bernd.status, 'active');
    // Abgemeldete werden durch den Import nicht reaktiviert
    const anna = (await t.get('/api/subscribers?q=anna')).data.items[0];
    assert.equal(anna.status, 'unsubscribed');
    assert.equal(anna.attributes.stadt, 'Köln');
  });

  test('Filter, Suche und Paginierung', async () => {
    for (let i = 0; i < 30; i++) await t.post('/api/subscribers', { email: `user${i}@example.com` });
    const page1 = (await t.get('/api/subscribers?per_page=10&status=active')).data;
    assert.equal(page1.items.length, 10);
    assert.equal(page1.total, 31);
    assert.equal(page1.pages, 4);
    assert.equal((await t.get(`/api/subscribers?list_id=${listId}`)).data.total, 2);
    assert.equal((await t.get('/api/subscribers?q=user1')).data.total, 11);
    assert.equal((await t.get('/api/subscribers?q=%25')).data.total, 0);
  });

  test('Massenaktionen', async () => {
    const ids = (await t.get('/api/subscribers?q=user2')).data.items.map((s) => s.id);
    assert.equal((await t.post('/api/subscribers/bulk', { action: 'add_to_list', ids, list_id: listId })).data.affected, ids.length);
    assert.equal((await t.get(`/api/subscribers?list_id=${listId}`)).data.total, 2 + ids.length);
    await t.post('/api/subscribers/bulk', { action: 'delete', ids });
    assert.equal((await t.get('/api/subscribers?q=user2')).data.total, 0);
  });

  test('CSV-Export', async () => {
    const res = await t.get('/api/subscribers/export?q=bernd');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const lines = res.data.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^email,first_name,last_name,status,lists/);
    assert.match(lines[0], /stadt$/);
    assert.match(lines[1], /^bernd@example.com,Bernd,Meier,active,Intern/);
  });

  test('Bounce-Webhook', async () => {
    await t.post('/api/subscribers', { email: 'soft@example.com' });
    for (let i = 0; i < 2; i++) assert.equal((await t.post('/api/webhooks/bounce', { email: 'soft@example.com', type: 'soft' })).data.status, 'active');
    assert.equal((await t.post('/api/webhooks/bounce', { email: 'soft@example.com', type: 'soft' })).data.status, 'bounced');
    assert.equal((await t.post('/api/webhooks/bounce', { email: 'bernd@example.com', type: 'complaint' })).data.status, 'complained');
    assert.equal((await t.post('/api/webhooks/bounce', { email: 'nobody@example.com' })).status, 404);
  });
});

describe('Öffentliche Anmeldung & Double-Opt-in', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('Anmeldung → Bestätigungs-Mail → Bestätigung → Willkommens-Mail', async () => {
    await t.put('/api/settings', { welcome_enabled: true });
    const res = await t.post('/api/public/subscribe', { email: 'Lea@Example.com', first_name: 'Lea', consent: true }, { auth: false });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const sub = (await t.get('/api/subscribers?q=lea')).data.items[0];
    assert.equal(sub.status, 'pending');
    assert.equal(sub.list_ids.length, 1, 'wird allen öffentlichen Listen zugeordnet');

    assert.equal(t.mailer.sent.length, 1);
    const mail = t.mailer.sent[0];
    assert.equal(mail.to, 'lea@example.com');
    assert.match(mail.subject, /Test-News/);
    assert.match(mail.html, /Hallo Lea/);
    const confirmUrl = urls(mail.html).find((u) => u.includes('/confirm/'));
    assert.ok(confirmUrl);

    // GET bestätigt nicht (Link-Scanner), sondern zeigt einen Knopf
    const ask = await t.get(pathOf(confirmUrl), { auth: false });
    assert.equal(ask.status, 200);
    assert.match(ask.data, /Ja, Anmeldung bestätigen/);
    assert.equal((await t.get(`/api/subscribers/${sub.id}`)).data.status, 'pending');
    const page = await t.request('POST', pathOf(confirmUrl), { form: {}, auth: false });
    assert.equal(page.status, 200);
    assert.match(page.data, /Anmeldung bestätigt/);
    assert.equal((await t.get(`/api/subscribers/${sub.id}`)).data.status, 'active');
    assert.equal(t.mailer.sent.length, 2);
    assert.match(t.mailer.sent[1].subject, /Willkommen/);

    // Erneutes Aufrufen ist harmlos
    assert.equal((await t.request('POST', pathOf(confirmUrl), { form: {}, auth: false })).status, 200);
    assert.equal((await t.get(pathOf(confirmUrl), { auth: false })).status, 200);
    assert.equal(t.mailer.sent.length, 2);
  });

  test('gleiche Antwort für bekannte Adressen (keine Enumeration)', async () => {
    const extra = (await t.post('/api/lists', { name: 'Zusatz', is_public: true })).data;
    const res = await t.post('/api/public/subscribe', { email: 'lea@example.com', consent: true, list_ids: [extra.id] }, { auth: false });
    assert.equal(res.status, 200);
    assert.equal(t.mailer.sent.length, 2, 'aktive Abonnenten erhalten keine neue Bestätigung');
    const lea = (await t.get('/api/subscribers?q=lea')).data.items[0];
    assert.ok(!lea.list_ids.includes(extra.id), 'Dritte können aktive Abonnenten keinen weiteren Listen zuordnen');
    await t.del(`/api/lists/${extra.id}`);
  });

  test('Honeypot und Validierung', async () => {
    const before = t.mailer.sent.length;
    const bot = await t.post('/api/public/subscribe', { email: 'bot@example.com', website: 'spam', consent: true }, { auth: false });
    assert.equal(bot.status, 200);
    assert.equal((await t.get('/api/subscribers?q=bot')).data.total, 0);
    assert.equal(t.mailer.sent.length, before);
    assert.equal((await t.post('/api/public/subscribe', { email: 'kaputt', consent: true }, { auth: false })).status, 400);
    const noConsent = await t.post('/api/public/subscribe', { email: 'ohne@example.com' }, { auth: false });
    assert.equal(noConsent.status, 400, 'Einwilligung ist Pflicht');
    assert.equal((await t.get('/api/subscribers?q=ohne')).data.total, 0);
  });

  test('HTML-Formular und nicht-öffentliche Listen', async () => {
    const hidden = (await t.post('/api/lists', { name: 'Geheim', is_public: false })).data;
    const page = await t.get('/subscribe', { auth: false });
    assert.match(page.data, /<form method="post" action="\/subscribe">/);
    const res = await t.request('POST', '/subscribe', { form: { email: 'form@example.com', consent: '1', list_ids: String(hidden.id) }, headers: { Accept: 'text/html' }, auth: false });
    assert.equal(res.status, 200);
    assert.match(res.data, /Fast geschafft/);
    const sub = (await t.get('/api/subscribers?q=form')).data.items[0];
    assert.ok(!sub.list_ids.includes(hidden.id), 'private Listen sind öffentlich nicht wählbar');
  });

  test('ohne Double-Opt-in sofort aktiv', async () => {
    await t.put('/api/settings', { double_opt_in: false });
    await t.post('/api/public/subscribe', { email: 'direkt@example.com', consent: true }, { auth: false });
    const direkt = (await t.get('/api/subscribers?q=direkt')).data.items[0];
    assert.equal(direkt.status, 'active');
    // Abgemeldete Adressen kann niemand ohne Bestätigung wieder aktivieren
    await t.put(`/api/subscribers/${direkt.id}`, { status: 'unsubscribed' });
    const before = t.mailer.sent.length;
    await t.post('/api/public/subscribe', { email: 'direkt@example.com', consent: true }, { auth: false });
    assert.equal((await t.get(`/api/subscribers/${direkt.id}`)).data.status, 'pending');
    assert.equal(t.mailer.sent.length, before + 1);
    assert.match(t.mailer.sent.at(-1).html, /\/confirm\//);
    await t.put('/api/settings', { double_opt_in: true });
  });

  test('höchstens eine Bestätigungs-Mail pro Adresse und Tag', async () => {
    const before = t.mailer.sent.length;
    for (let i = 0; i < 5; i++) await t.post('/api/public/subscribe', { email: 'opfer@example.com', consent: true }, { auth: false });
    assert.equal(t.mailer.sent.filter((m) => m.to === 'opfer@example.com').length, 1);
    assert.equal(t.mailer.sent.length, before + 1);
  });

  test('Präferenzen, Datenexport und Löschung', async () => {
    const sub = (await t.get('/api/subscribers?q=lea')).data.items[0];
    const lists = (await t.get('/api/lists')).data;
    const extra = (await t.post('/api/lists', { name: 'Events', is_public: true })).data;
    const page = await t.get(`/preferences/${sub.token}`, { auth: false });
    assert.match(page.data, /Events/);
    assert.doesNotMatch(page.data, /Geheim/);

    await t.request('POST', `/preferences/${sub.token}`, { form: { first_name: 'Lea M.', list_ids: String(extra.id) }, auth: false });
    const after1 = (await t.get(`/api/subscribers/${sub.id}`)).data;
    assert.equal(after1.first_name, 'Lea M.');
    assert.deepEqual(after1.list_ids, [extra.id]);
    assert.ok(lists.length >= 1);

    // Datenexport nur über den Link aus der E-Mail
    const plain = await t.get(`/preferences/${sub.token}/export`, { auth: false });
    assert.match(plain.data, /Link per E-Mail senden/);
    assert.equal(typeof plain.data, 'string', 'keine JSON-Daten ohne Link');
    let sentBefore = t.mailer.sent.length;
    await t.request('POST', `/preferences/${sub.token}/export`, { form: {}, auth: false });
    assert.equal(t.mailer.sent.length, sentBefore + 1);
    const exportUrl = urls(t.mailer.sent.at(-1).html).find((u) => u.includes('/export?'));
    assert.ok(exportUrl);
    const exp = await t.get(pathOf(exportUrl), { auth: false });
    assert.equal(exp.data.email, 'lea@example.com');
    assert.equal(exp.data.token, undefined);
    const forged = await t.get(pathOf(exportUrl).replace(/sig=[^&]+/, 'sig=falsch'), { auth: false });
    assert.equal(typeof forged.data, 'string', 'gefälschte Signatur liefert keine Daten');

    // Löschen: Rückfrage → Bestätigungs-Mail → Link → endgültig löschen
    const ask = await t.request('POST', `/preferences/${sub.token}/delete`, { form: {}, auth: false });
    assert.match(ask.data, /endgültig/);
    sentBefore = t.mailer.sent.length;
    const mailStep = await t.request('POST', `/preferences/${sub.token}/delete`, { form: { confirm: '1' }, auth: false });
    assert.match(mailStep.data, /E-Mail/);
    assert.equal((await t.get(`/api/subscribers/${sub.id}`)).status, 200, 'ohne Link aus der Mail wird nichts gelöscht');
    assert.equal(t.mailer.sent.length, sentBefore + 1);
    const deleteUrl = urls(t.mailer.sent.at(-1).html).find((u) => u.includes('/delete?'));
    const confirmPage = await t.get(pathOf(deleteUrl), { auth: false });
    assert.match(confirmPage.data, /Endgültig löschen/);
    await t.request('POST', pathOf(deleteUrl), { form: { confirm: '1' }, auth: false });
    assert.equal((await t.get(`/api/subscribers/${sub.id}`)).status, 404);
    assert.equal((await t.get(`/preferences/${sub.token}`, { auth: false })).status, 404);
  });
});

describe('Kampagnen, Versand & Tracking', () => {
  let t;
  let listId;
  let campaign;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    listId = (await t.get('/api/lists')).data[0].id;
    for (const [email, first] of [['a@example.com', 'Anna'], ['b@example.com', 'Ben'], ['c@example.com', '']]) {
      await t.post('/api/subscribers', { email, first_name: first, list_ids: [listId] });
    }
    await t.post('/api/subscribers', { email: 'pending@example.com', status: 'pending', list_ids: [listId] });
    await t.post('/api/subscribers', { email: 'ohneliste@example.com' });
  });
  after(() => t.close());

  test('Entwurf anlegen, Vorschau, Zielgruppe', async () => {
    const res = await t.post('/api/campaigns', {
      name: 'Oktober',
      subject: 'Hallo {{first_name | "Leser"}}',
      preheader: 'Die News',
      content_html: '<p>Hi {{first_name}}! <a href="https://example.org/a?x=1&amp;y=2">Artikel</a> <a href="https://example.org/b">B</a></p>',
      list_ids: [listId],
    });
    assert.equal(res.status, 201);
    campaign = res.data;
    assert.equal(campaign.status, 'draft');
    assert.equal((await t.post('/api/campaigns/audience', { list_ids: [listId] })).data.count, 3);
    const preview = (await t.get(`/api/campaigns/${campaign.id}/preview?format=json`)).data;
    assert.equal(preview.subject, 'Hallo Max');
    assert.match(preview.html, /Hi Max!/);
    assert.doesNotMatch(preview.html, /\/t\/c\//, 'Vorschau ohne Tracking');
  });

  test('Testversand', async () => {
    const res = await t.post(`/api/campaigns/${campaign.id}/test`, { emails: 'a@example.com, test@example.com' });
    assert.equal(res.status, 200);
    assert.equal(t.mailer.sent.length, 2);
    assert.match(t.mailer.sent[0].subject, /^\[TEST\] Hallo Anna/);
    assert.match(t.mailer.sent[1].subject, /^\[TEST\] Hallo Max/);
    t.mailer.sent.length = 0;
    assert.equal((await t.post(`/api/campaigns/${campaign.id}/test`, { emails: 'kaputt' })).status, 400);
  });

  test('Versand ohne Betreff oder Empfänger wird abgelehnt', async () => {
    const empty = (await t.post('/api/campaigns', { name: 'Leer' })).data;
    const res = await t.post(`/api/campaigns/${empty.id}/send`);
    assert.equal(res.status, 400);
    assert.match(res.data.error, /Betreff fehlt/);
    await t.del(`/api/campaigns/${empty.id}`);
  });

  test('Versand an aktive Abonnenten mit Personalisierung und Tracking', async () => {
    const started = await t.post(`/api/campaigns/${campaign.id}/send`);
    assert.equal(started.data.status, 'sending');
    assert.equal(started.data.recipient_count, 3);
    assert.equal((await t.put(`/api/campaigns/${campaign.id}`, { subject: 'x' })).status, 409);

    await t.flush();
    assert.equal(t.mailer.sent.length, 3);
    const toAnna = t.mailer.sent.find((m) => m.to === 'a@example.com');
    const toC = t.mailer.sent.find((m) => m.to === 'c@example.com');
    assert.equal(toAnna.subject, 'Hallo Anna');
    assert.equal(toC.subject, 'Hallo Leser');
    assert.match(toAnna.headers['List-Unsubscribe'], /^<http:\/\/test.local\/unsubscribe\/.+\?r=.+>$/);
    assert.equal(toAnna.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(toAnna.text, /Hi Anna!/);

    const links = urls(toAnna.html);
    assert.equal(links.filter((u) => u.includes('/t/c/')).length, 2);
    assert.ok(!links.some((u) => u.startsWith('https://example.org')), 'Links sind umgeschrieben');
    assert.ok(links.some((u) => /\/t\/o\/[0-9a-f]+\.gif$/.test(u)), 'Öffnungs-Pixel');

    const report = (await t.get(`/api/campaigns/${campaign.id}`)).data;
    assert.equal(report.status, 'sent');
    assert.equal(report.sent_count, 3);
  });

  test('Öffnungen, Klicks und Webansicht', async () => {
    const mail = t.mailer.sent.find((m) => m.to === 'a@example.com');
    const links = urls(mail.html);
    const pixel = links.find((u) => u.includes('/t/o/'));
    const click = links.find((u) => u.includes('/t/c/'));

    const img = await t.get(pathOf(pixel), { auth: false });
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/gif');
    await t.get(pathOf(pixel), { auth: false });

    const redirect = await t.get(pathOf(click), { auth: false });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://example.org/a?x=1&y=2');

    // Unbekannte Link-ID → kein offener Redirect
    assert.equal((await t.get(pathOf(click).replace(/\/\d+$/, '/9999'), { auth: false })).status, 404);

    // Klick ohne vorherige Öffnung zählt als Öffnung
    const benClick = urls(t.mailer.sent.find((m) => m.to === 'b@example.com').html).find((u) => u.includes('/t/c/'));
    await t.get(pathOf(benClick), { auth: false });

    const report = (await t.get(`/api/campaigns/${campaign.id}/report`)).data;
    assert.equal(report.campaign.unique_opens, 2);
    assert.equal(report.campaign.unique_clicks, 2);
    assert.equal(report.campaign.open_rate, 66.7);
    assert.equal(report.totals.total_opens, 3);
    assert.equal(report.links.find((l) => l.url === 'https://example.org/a?x=1&y=2').clicks, 2);

    const recipients = (await t.get(`/api/campaigns/${campaign.id}/recipients?status=clicked`)).data;
    assert.equal(recipients.total, 2);

    const webview = links.find((u) => u.includes('/view/'));
    const view = await t.get(pathOf(webview), { auth: false });
    assert.match(view.data, /Hi Anna!/);
  });

  test('One-Click-Abmeldung wird der Kampagne zugeordnet', async () => {
    const mail = t.mailer.sent.find((m) => m.to === 'c@example.com');
    const unsub = mail.headers['List-Unsubscribe'].slice(1, -1);
    const res = await t.request('POST', pathOf(unsub), { form: { 'List-Unsubscribe': 'One-Click' }, auth: false });
    assert.equal(res.status, 200);
    const c = (await t.get('/api/subscribers?q=c@example')).data.items[0];
    assert.equal(c.status, 'unsubscribed');
    assert.equal((await t.get(`/api/campaigns/${campaign.id}`)).data.unsubscribes, 1);
    const page = await t.get(pathOf(unsub), { auth: false });
    assert.match(page.data, /Bereits abgemeldet/);
  });

  test('Statistik-Übersicht', async () => {
    const stats = (await t.get('/api/stats/overview')).data;
    assert.equal(stats.subscribers.active, 3); // a, b und ohneliste
    assert.equal(stats.subscribers.pending, 1);
    assert.equal(stats.subscribers.unsubscribed, 1);
    assert.equal(stats.campaigns.sent, 1);
    assert.equal(stats.growth.length, 30);
    assert.equal(stats.growth.at(-1).subscribed, 4);
    assert.equal(stats.growth.at(-1).unsubscribed, 1);
  });

  test('Archiv', async () => {
    assert.equal((await t.get(`/archive/${campaign.id}`, { auth: false })).status, 404);
    await t.put(`/api/campaigns/${campaign.id}`, { archive: true });
    const page = await t.get(`/archive/${campaign.id}`, { auth: false });
    assert.equal(page.status, 200);
    assert.match(page.data, /Hi !/);
    assert.match((await t.get('/archive', { auth: false })).data, /Hallo Leser/);
  });

  test('Duplizieren, Planen, Abbrechen der Planung', async () => {
    const copy = (await t.post(`/api/campaigns/${campaign.id}/duplicate`)).data;
    assert.equal(copy.status, 'draft');
    assert.deepEqual(copy.list_ids, [listId]);
    assert.equal((await t.post(`/api/campaigns/${copy.id}/schedule`, { scheduled_at: '2000-01-01T00:00:00Z' })).status, 400);
    const future = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await t.post(`/api/campaigns/${copy.id}/schedule`, { scheduled_at: future })).data.status, 'scheduled');
    assert.equal((await t.post(`/api/campaigns/${copy.id}/unschedule`)).data.status, 'draft');
  });

  test('fällige geplante Kampagnen startet der Worker', async () => {
    const c = (await t.post('/api/campaigns', { name: 'Geplant', subject: 'S', content_html: '<p>x</p>', list_ids: [listId] })).data;
    await t.post(`/api/campaigns/${c.id}/schedule`, { scheduled_at: new Date(Date.now() + 3600_000).toISOString() });
    t.db.run('UPDATE campaigns SET scheduled_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), c.id);
    t.mailer.sent.length = 0;
    await t.flush();
    assert.equal((await t.get(`/api/campaigns/${c.id}`)).data.status, 'sent');
    assert.equal(t.mailer.sent.length, 2);
  });

  test('Pausieren, Fortsetzen, Ratenbegrenzung und Wiederholungen', async () => {
    const c = (await t.post('/api/campaigns', { name: 'Retry', subject: 'S', content_html: '<p>x</p>', list_ids: [listId] })).data;
    await t.post(`/api/campaigns/${c.id}/send`);
    await t.post(`/api/campaigns/${c.id}/pause`);
    t.mailer.sent.length = 0;
    await t.flush();
    assert.equal(t.mailer.sent.length, 0, 'pausierte Kampagnen werden nicht versendet');
    await t.post(`/api/campaigns/${c.id}/resume`);

    // Kontingent von 1 pro Durchlauf
    await t.services.delivery.runOnce({ limit: 1 });
    assert.equal(t.mailer.sent.length, 1);

    t.mailer.failFor.add('b@example.com');
    await t.flush();
    let rec = (await t.get(`/api/campaigns/${c.id}/recipients`)).data.items.find((r) => r.email === 'b@example.com');
    assert.equal(rec.status, 'queued');
    assert.equal(rec.attempts, 1);
    assert.match(rec.error, /Simulierter/);

    // Nächster Versuch nach Ablauf der Wartezeit → endgültig fehlgeschlagen (maxAttempts = 2)
    t.db.run('UPDATE campaign_recipients SET next_attempt_at = ? WHERE campaign_id = ?', new Date(0).toISOString(), c.id);
    await t.flush();
    rec = (await t.get(`/api/campaigns/${c.id}/recipients`)).data.items.find((r) => r.email === 'b@example.com');
    assert.equal(rec.status, 'failed');
    const done = (await t.get(`/api/campaigns/${c.id}`)).data;
    assert.equal(done.status, 'sent');
    assert.equal(done.failed_count, 1);
  });

  test('Abbrechen überspringt offene Empfänger; laufende Kampagnen nicht löschbar', async () => {
    const c = (await t.post('/api/campaigns', { name: 'Stop', subject: 'S', content_html: '<p>x</p>', list_ids: [listId] })).data;
    await t.post(`/api/campaigns/${c.id}/send`);
    assert.equal((await t.del(`/api/campaigns/${c.id}`)).status, 409);
    const cancelled = (await t.post(`/api/campaigns/${c.id}/cancel`)).data;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.queued_count, 0);
    assert.equal((await t.del(`/api/campaigns/${c.id}`)).status, 204);
  });

  test('zwischenzeitlich abgemeldete Empfänger werden übersprungen', async () => {
    const c = (await t.post('/api/campaigns', { name: 'Skip', subject: 'S', content_html: '<p>x</p>', list_ids: [listId] })).data;
    await t.post(`/api/campaigns/${c.id}/send`);
    const anna = (await t.get('/api/subscribers?q=a@example')).data.items[0];
    await t.put(`/api/subscribers/${anna.id}`, { status: 'unsubscribed' });
    t.mailer.sent.length = 0;
    t.mailer.failFor.clear();
    await t.flush();
    assert.deepEqual(t.mailer.sent.map((m) => m.to), ['b@example.com']);
    const rec = (await t.get(`/api/campaigns/${c.id}/recipients?status=skipped`)).data;
    assert.equal(rec.total, 1);
  });

  test('Vorlagen: Platzhalter {{{content}}} ist Pflicht', async () => {
    assert.equal((await t.post('/api/templates', { name: 'X', html: '<p>ohne</p>' })).status, 400);
    const tpl = (await t.post('/api/templates', { name: 'Eigen', html: '<html><body><div class="x">{{{content}}}</div></body></html>' })).data;
    const c = (await t.post('/api/campaigns', { name: 'T', subject: 'S', content_html: '<p>Inhalt</p>', template_id: tpl.id })).data;
    const preview = (await t.get(`/api/campaigns/${c.id}/preview?format=json`)).data;
    assert.match(preview.html, /<div class="x"><p>Inhalt<\/p><\/div>/);
    assert.match(preview.html, /Hier abmelden/, 'Abmeldelink wird ergänzt');
  });
});
