import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { currentCounter, hotp } from '../src/core/totp.js';
import { startTestServer } from './helpers.js';

const totpNow = (secret, offset = 0) => hotp(secret, currentCounter() + offset);
const linkToken = (mail) => mail.html.match(/#\/reset\/([\w-]+)/)[1];

describe('TOTP', () => {
  test('RFC-6238-Testvektor (SHA1)', () => {
    // Geheimnis "12345678901234567890" in Base32
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');
    assert.equal(hotp(secret, Math.floor(1111111109 / 30)), '081804');
  });
});

describe('Konto & Sicherheit', () => {
  let t;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('Anmeldung setzt ein httpOnly-Cookie; Schreibzugriffe per Cookie brauchen den CSRF-Header', async () => {
    const res = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'sehrgeheim123' }),
    });
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /^cms_sid=[\w-]+;/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/api/);
    const sid = cookie.split(';')[0];

    const me = await fetch(`${t.base}/api/auth/me`, { headers: { Cookie: sid } });
    assert.equal(me.status, 200);
    const noCsrf = await fetch(`${t.base}/api/lists`, { method: 'POST', headers: { Cookie: sid, 'Content-Type': 'application/json' }, body: '{"name":"X"}' });
    assert.equal(noCsrf.status, 403);
    const withCsrf = await fetch(`${t.base}/api/lists`, {
      method: 'POST',
      headers: { Cookie: sid, 'Content-Type': 'application/json', 'X-Requested-With': 'cms-admin' },
      body: '{"name":"X"}',
    });
    assert.equal(withCsrf.status, 201);

    const out = await fetch(`${t.base}/api/auth/logout`, { method: 'POST', headers: { Cookie: sid, 'X-Requested-With': 'cms-admin' } });
    assert.equal(out.status, 204);
    assert.match(out.headers.get('set-cookie'), /cms_sid=;/);
    assert.equal((await fetch(`${t.base}/api/auth/me`, { headers: { Cookie: sid } })).status, 401);
  });

  test('Passwort vergessen und zurücksetzen', async () => {
    t.mailer.sent.length = 0;
    const unknown = await t.post('/api/auth/forgot', { email: 'niemand@example.com' }, { auth: false });
    const known = await t.post('/api/auth/forgot', { email: 'admin@example.com' }, { auth: false });
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.data, known.data, 'gleiche Antwort für unbekannte Adressen');
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0].to, 'admin@example.com');
    const token = linkToken(t.mailer.sent[0]);

    assert.equal((await t.post('/api/auth/reset', { token: 'falsch', password: 'neuesPasswort1' }, { auth: false })).status, 400);
    assert.equal((await t.post('/api/auth/reset', { token, password: 'kurz' }, { auth: false })).status, 400);
    assert.equal((await t.post('/api/auth/reset', { token, password: 'neuesPasswort1' }, { auth: false })).status, 200);
    assert.equal((await t.post('/api/auth/reset', { token, password: 'nochEinPasswort2' }, { auth: false })).status, 400, 'nur einmal verwendbar');
    assert.equal((await t.get('/api/auth/me')).status, 401, 'alte Sitzungen sind beendet');
    assert.equal((await t.post('/api/auth/login', { email: 'admin@example.com', password: 'sehrgeheim123' }, { auth: false })).status, 401);
    const login = await t.post('/api/auth/login', { email: 'admin@example.com', password: 'neuesPasswort1' }, { auth: false });
    assert.equal(login.status, 200);
    t.setToken(login.data.token);
  });

  test('Zwei-Faktor-Anmeldung: Einrichten, Anmelden, Wiederherstellungscode, Deaktivieren', async () => {
    assert.equal((await t.post('/api/auth/2fa/setup', { password: 'falsch' })).status, 400);
    const setup = (await t.post('/api/auth/2fa/setup', { password: 'neuesPasswort1' })).data;
    assert.match(setup.otpauth_url, /^otpauth:\/\/totp\//);
    assert.match(setup.qr, /^data:image\/svg\+xml;base64,/);
    assert.equal((await t.post('/api/auth/2fa/enable', { code: '000000' })).status, 400);
    const enabled = await t.post('/api/auth/2fa/enable', { code: totpNow(setup.secret) });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.recovery_codes.length, 10);
    assert.equal((await t.get('/api/auth/me')).data.totp_enabled, true);

    // Anmeldung jetzt zweistufig
    const step1 = await t.post('/api/auth/login', { email: 'admin@example.com', password: 'neuesPasswort1' }, { auth: false });
    assert.equal(step1.data.two_factor, true);
    assert.equal(step1.data.token, undefined);
    assert.equal((await t.post('/api/auth/login/2fa', { challenge: step1.data.challenge, code: '123456' }, { auth: false })).status, 401);
    // Derselbe Code wie bei der Aktivierung wird nicht zweimal akzeptiert
    const reused = await t.post('/api/auth/login/2fa', { challenge: step1.data.challenge, code: totpNow(setup.secret) }, { auth: false });
    assert.equal(reused.status, 401);
    const ok = await t.post('/api/auth/login/2fa', { challenge: step1.data.challenge, code: totpNow(setup.secret, 1) }, { auth: false });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.token);

    // Wiederherstellungscode funktioniert genau einmal
    const code = enabled.data.recovery_codes[0];
    const s2 = (await t.post('/api/auth/login', { email: 'admin@example.com', password: 'neuesPasswort1' }, { auth: false })).data;
    assert.equal((await t.post('/api/auth/login/2fa', { challenge: s2.challenge, code }, { auth: false })).status, 200);
    const s3 = (await t.post('/api/auth/login', { email: 'admin@example.com', password: 'neuesPasswort1' }, { auth: false })).data;
    assert.equal((await t.post('/api/auth/login/2fa', { challenge: s3.challenge, code }, { auth: false })).status, 401);
    assert.equal((await t.get('/api/auth/me')).data.recovery_codes_left, 9);

    assert.equal((await t.post('/api/auth/2fa/disable', { password: 'neuesPasswort1' })).status, 200);
    const plain = await t.post('/api/auth/login', { email: 'admin@example.com', password: 'neuesPasswort1' }, { auth: false });
    assert.ok(plain.data.token);
  });

  test('Challenge ist nach fünf Fehlversuchen verbraucht', async () => {
    const setup = (await t.post('/api/auth/2fa/setup', { password: 'neuesPasswort1' })).data;
    await t.post('/api/auth/2fa/enable', { code: totpNow(setup.secret) });
    const { challenge } = (await t.post('/api/auth/login', { email: 'admin@example.com', password: 'neuesPasswort1' }, { auth: false })).data;
    for (let i = 0; i < 5; i++) await t.post('/api/auth/login/2fa', { challenge, code: '000000' }, { auth: false });
    const res = await t.post('/api/auth/login/2fa', { challenge, code: totpNow(setup.secret, 1) }, { auth: false });
    assert.equal(res.status, 401);
    assert.match(res.data.error, /abgelaufen/);
    await t.post('/api/auth/2fa/disable', { password: 'neuesPasswort1' });
  });

  test('Benutzer einladen; Admin setzt 2FA zurück', async () => {
    t.mailer.sent.length = 0;
    const invited = await t.post('/api/users', { email: 'autor@example.com', name: 'Alex', role: 'author', invite: true });
    assert.equal(invited.status, 201);
    assert.equal(invited.data.role, 'author');
    assert.equal(t.mailer.sent.length, 1);
    const token = linkToken(t.mailer.sent[0]);
    await t.post('/api/auth/reset', { token, password: 'autorPasswort1' }, { auth: false });
    const login = await t.post('/api/auth/login', { email: 'autor@example.com', password: 'autorPasswort1' }, { auth: false });
    assert.equal(login.status, 200);

    const h = { Authorization: `Bearer ${login.data.token}` };
    const setup = (await t.post('/api/auth/2fa/setup', { password: 'autorPasswort1' }, { headers: h })).data;
    await t.post('/api/auth/2fa/enable', { code: totpNow(setup.secret) }, { headers: h });
    const reset = await t.post(`/api/users/${invited.data.id}/reset-2fa`);
    assert.equal(reset.data.totp_enabled, false);
    assert.equal((await t.get('/api/auth/me', { headers: h })).status, 401, 'Sitzungen wurden beendet');
    assert.equal((await t.post('/api/users', { email: 'x@example.com', role: 'admin' })).status, 400, 'ohne Einladung ist ein Passwort Pflicht');
  });

  test('Änderungsprotokoll', async () => {
    await t.post('/api/pages', { title: 'Protokollierte Seite' });
    const log = (await t.get('/api/system/audit?per_page=100')).data;
    const actions = log.items.map((e) => `${e.action} ${e.target}`);
    assert.ok(actions.includes('POST /pages'));
    assert.ok(actions.includes('login admin@example.com'));
    assert.ok(actions.includes('password_reset admin@example.com'));
    assert.ok(actions.includes('2fa_enabled admin@example.com'));
    assert.ok(actions.some((a) => a.startsWith('login_failed')));
    assert.ok(!actions.some((a) => a.includes('/preview')), 'Vorschauen werden nicht protokolliert');
    assert.equal((await t.get('/api/system/audit?q=Protokoll')).status, 200);
  });
});
