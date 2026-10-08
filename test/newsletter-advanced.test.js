import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { pathOf, startTestServer, urls } from './helpers.js';

describe('Segmente', () => {
  let t;
  let listId;
  let otherList;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    listId = (await t.get('/api/lists')).data[0].id;
    otherList = (await t.post('/api/lists', { name: 'VIP' })).data.id;
    const people = [
      ['anna@berlin.example', { stadt: 'Berlin', plan: 'pro' }, [listId]],
      ['ben@hamburg.example', { stadt: 'Hamburg', plan: 'pro' }, [listId, otherList]],
      ['cleo@berlin.example', { stadt: 'berlin' }, [otherList]],
      ['dora@firma.example', {}, [listId]],
    ];
    for (const [email, attributes, list_ids] of people) await t.post('/api/subscribers', { email, attributes, list_ids });
    await t.post('/api/subscribers', { email: 'weg@berlin.example', status: 'unsubscribed', attributes: { stadt: 'Berlin' } });
  });
  after(() => t.close());

  test('Regeln: eigene Felder, Listen, E-Mail, „alle“ und „eine“', async () => {
    const preview = (rules, match = 'all') => t.post('/api/segments/preview', { rules, match }).then((r) => r.data);
    assert.equal((await preview([{ field: 'attribute', key: 'stadt', op: 'equals', value: 'BERLIN' }])).count, 2, 'nur aktive, ohne Groß-/Kleinschreibung');
    assert.equal((await preview([{ field: 'list', op: 'in', value: otherList }, { field: 'attribute', key: 'plan', op: 'not_empty' }])).count, 1);
    assert.equal((await preview([{ field: 'email', op: 'ends_with', value: '@firma.example' }, { field: 'list', op: 'in', value: otherList }], 'any')).count, 3);
    assert.equal((await preview([{ field: 'created_at', op: 'within_days', value: 7 }])).count, 4);
    assert.equal((await preview([{ field: 'opened', op: 'not_within_days', value: 30 }])).count, 4);
    // Platzhalter im Suchtext werden nicht als Joker behandelt
    assert.equal((await preview([{ field: 'email', op: 'contains', value: '%' }])).count, 0);

    assert.equal((await t.post('/api/segments/preview', { rules: [{ field: 'gibts_nicht', op: 'equals' }] })).status, 400);
    assert.equal((await t.post('/api/segments/preview', { rules: [{ field: 'attribute', key: "x') OR 1=1 --", op: 'empty' }] })).status, 400);
    assert.equal((await t.post('/api/segments/preview', { rules: [{ field: 'list', op: 'in', value: 999 }] })).status, 404);
  });

  test('Kampagne an ein Segment (mit und ohne Listen)', async () => {
    const seg = (await t.post('/api/segments', { name: 'Berlin', rules: [{ field: 'attribute', key: 'stadt', op: 'equals', value: 'berlin' }] })).data;
    assert.equal((await t.get('/api/segments')).data.find((s) => s.id === seg.id).count, 2);
    assert.equal((await t.post('/api/campaigns/audience', { segment_id: seg.id })).data.count, 2);
    assert.equal((await t.post('/api/campaigns/audience', { segment_id: seg.id, list_ids: [listId] })).data.count, 1);

    const c = (await t.post('/api/campaigns', { name: 'Berlin', subject: 'Hallo Berlin', content_html: '<p>Hi</p>', segment_id: seg.id })).data;
    const started = (await t.post(`/api/campaigns/${c.id}/send`)).data;
    assert.equal(started.recipient_count, 2);
    await t.flush();
    assert.deepEqual(t.mailer.sent.map((m) => m.to).sort(), ['anna@berlin.example', 'cleo@berlin.example']);

    // Segment entfernen setzt die Kampagne zurück auf „keine Zielgruppe“
    const draft = (await t.post('/api/campaigns', { name: 'X', subject: 'x', content_html: 'x', segment_id: seg.id })).data;
    assert.equal((await t.put(`/api/campaigns/${draft.id}`, { segment_id: null })).data.segment_id, null);
    assert.equal((await t.post(`/api/campaigns/${draft.id}/send`)).status, 400);
  });
});

describe('A/B-Test des Betreffs', () => {
  let t;
  let campaign;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    const listId = (await t.get('/api/lists')).data[0].id;
    for (let i = 0; i < 20; i++) await t.post('/api/subscribers', { email: `leser${i}@example.com`, list_ids: [listId] });
    campaign = (
      await t.post('/api/campaigns', {
        name: 'AB', subject: 'Betreff A', subject_b: 'Betreff B', ab_test_percent: 50, ab_wait_hours: 2, content_html: '<p>Inhalt</p>', list_ids: [listId],
      })
    ).data;
  });
  after(() => t.close());

  test('ohne Betreff B kein Versand', async () => {
    const c = (await t.post('/api/campaigns', { name: 'X', subject: 'x', content_html: 'x', ab_test_percent: 20, list_ids: campaign.list_ids })).data;
    const r = await t.post(`/api/campaigns/${c.id}/send`);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Betreff B/);
  });

  test('Testgruppe bekommt beide Betreffs, der Rest wartet auf den Gewinner', async () => {
    const started = (await t.post(`/api/campaigns/${campaign.id}/send`)).data;
    assert.equal(started.held_count, 10);
    assert.equal(started.queued_count, 10);
    await t.flush();
    const subjects = t.mailer.sent.map((m) => m.subject);
    assert.equal(subjects.filter((s) => s === 'Betreff A').length, 5);
    assert.equal(subjects.filter((s) => s === 'Betreff B').length, 5);
    assert.equal((await t.get(`/api/campaigns/${campaign.id}`)).data.status, 'sending', 'wartet auf den Test');

    // Betreff B wird häufiger geöffnet
    for (const mail of t.mailer.sent.filter((m) => m.subject === 'Betreff B').slice(0, 3)) {
      const pixel = urls(mail.html).find((u) => u.includes('/t/o/'));
      await t.get(pathOf(pixel), { auth: false });
    }
    await t.get(pathOf(urls(t.mailer.sent.find((m) => m.subject === 'Betreff A').html).find((u) => u.includes('/t/o/'))), { auth: false });
    const report = (await t.get(`/api/campaigns/${campaign.id}/report`)).data;
    assert.equal(report.ab.a.opens, 1);
    assert.equal(report.ab.b.opens, 3);
    assert.equal(report.ab.b.open_rate, 60);

    // Testzeit abgelaufen → Gewinner B, Rest erhält Betreff B
    t.db.run('UPDATE campaigns SET ab_test_ends_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), campaign.id);
    t.mailer.sent.length = 0;
    await t.flush();
    assert.equal(t.mailer.sent.length, 10);
    assert.ok(t.mailer.sent.every((m) => m.subject === 'Betreff B'));
    const done = (await t.get(`/api/campaigns/${campaign.id}`)).data;
    assert.equal(done.ab_winner, 'b');
    assert.equal(done.status, 'sent');
    assert.equal(done.sent_count, 20);
    assert.equal((await t.post(`/api/campaigns/${campaign.id}/ab-winner`, { variant: 'a' })).status, 409);

    // Webansicht zeigt den Betreff der jeweiligen Variante
    const viewUrl = urls(t.mailer.sent[0].html).find((u) => u.includes('/view/'));
    if (viewUrl) assert.match((await t.get(pathOf(viewUrl), { auth: false })).data, /Betreff B/);
  });
});

describe('Automationen (Willkommensserie)', () => {
  let t;
  let automation;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('anlegen und validieren', async () => {
    assert.equal((await t.post('/api/automations', { name: 'Leer', status: 'active' })).status, 400);
    assert.equal((await t.post('/api/automations', { name: 'X', steps: [{ subject: '', delay_hours: 0 }] })).status, 400);
    const res = await t.post('/api/automations', {
      name: 'Willkommen',
      status: 'active',
      steps: [
        { subject: 'Willkommen, {{first_name | "du"}}!', delay_hours: 0, content_html: '<p>Schön, dass du da bist.</p>' },
        { subject: 'Unsere besten Artikel', delay_hours: 48, content_html: '<p>Lesetipps</p>' },
      ],
    });
    assert.equal(res.status, 201);
    automation = res.data;
    assert.equal(automation.steps.length, 2);
  });

  test('Anmeldung mit Double-Opt-in startet die Serie erst nach der Bestätigung', async () => {
    await t.post('/api/public/subscribe', { email: 'neu@example.com', first_name: 'Nora', consent: true }, { auth: false });
    const confirmUrl = urls(t.mailer.sent[0].html).find((u) => u.includes('/confirm/'));
    t.mailer.sent.length = 0;
    await t.flush();
    assert.equal(t.mailer.sent.length, 0, 'unbestätigt: nichts');

    await t.request('POST', pathOf(confirmUrl), { auth: false });
    await t.flush();
    assert.equal(t.mailer.sent.length, 1);
    assert.equal(t.mailer.sent[0].subject, 'Willkommen, Nora!');
    assert.match(t.mailer.sent[0].headers['List-Unsubscribe'], /\/unsubscribe\//);

    // Zweiter Schritt erst nach der Wartezeit
    await t.flush();
    assert.equal(t.mailer.sent.length, 1);
    t.db.run("UPDATE automation_runs SET next_at = '2000-01-01T00:00:00.000Z'");
    await t.flush();
    assert.equal(t.mailer.sent.length, 2);
    assert.equal(t.mailer.sent[1].subject, 'Unsere besten Artikel');

    const details = (await t.get(`/api/automations/${automation.id}`)).data;
    assert.deepEqual(details.runs, { active: 0, done: 1, cancelled: 0 });
    assert.deepEqual(details.steps.map((s) => s.sent), [1, 1]);
  });

  test('Abmeldung beendet die Serie, Schritte bleiben beim Bearbeiten erhalten', async () => {
    await t.put('/api/settings', { double_opt_in: false });
    await t.post('/api/public/subscribe', { email: 'kurz@example.com', consent: true }, { auth: false });
    t.mailer.sent.length = 0;
    await t.flush();
    assert.equal(t.mailer.sent.length, 1);
    const sub = (await t.get('/api/subscribers?q=kurz')).data.items[0];
    await t.put(`/api/subscribers/${sub.id}`, { status: 'unsubscribed' });
    t.db.run("UPDATE automation_runs SET next_at = '2000-01-01T00:00:00.000Z' WHERE status = 'active'");
    await t.flush();
    assert.equal(t.mailer.sent.length, 1);
    const details = (await t.get(`/api/automations/${automation.id}`)).data;
    assert.equal(details.runs.cancelled, 1);

    const steps = details.steps.map((s) => ({ ...s, subject: `${s.subject}!` }));
    const updated = (await t.put(`/api/automations/${automation.id}`, { steps })).data;
    assert.deepEqual(updated.steps.map((s) => s.id), details.steps.map((s) => s.id));
    assert.equal(updated.steps[0].sent, 2, 'Statistik bleibt erhalten');

    // Pausiert: keine neuen Teilnehmer
    await t.put(`/api/automations/${automation.id}`, { status: 'paused' });
    await t.post('/api/public/subscribe', { email: 'pause@example.com', consent: true }, { auth: false });
    assert.equal((await t.get(`/api/automations/${automation.id}`)).data.runs.active, 0);
  });
});

describe('Bounce-Webhooks der Provider', () => {
  let t;
  let hooks;
  const status = async (email) => (await t.get(`/api/subscribers?q=${encodeURIComponent(email)}`)).data.items[0].status;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    for (const email of ['hart@example.com', 'weich@example.com', 'spam@example.com', 'ses@example.com', 'mg@example.com', 'sg@example.com']) {
      await t.post('/api/subscribers', { email });
    }
    hooks = Object.fromEntries((await t.get('/api/newsletter/bounce-urls')).data.map((h) => [h.provider, pathOf(h.url)]));
  });
  after(() => t.close());

  test('Adresse mit Geheimnis, falsches Geheimnis → 404', async () => {
    assert.match(hooks.postmark, /^\/api\/public\/bounces\/postmark\/[\w-]{20,}$/);
    assert.equal((await t.post(hooks.postmark.replace(/[^/]+$/, 'falsch'), {}, { auth: false })).status, 404);
  });

  test('Postmark, Brevo, Mailgun, SendGrid, Amazon SES', async () => {
    const send = (path, body, opts = {}) => t.post(path, body, { auth: false, ...opts });
    let r = await send(hooks.postmark, { RecordType: 'Bounce', Type: 'HardBounce', Email: 'hart@example.com', Description: 'unknown user' });
    assert.deepEqual(r.data, { ok: true, received: 1, processed: 1 });
    assert.equal(await status('hart@example.com'), 'bounced');

    await send(hooks.brevo, { event: 'spam', email: 'spam@example.com' });
    assert.equal(await status('spam@example.com'), 'complained');

    for (let i = 0; i < 3; i++) await send(hooks.mailgun, { 'event-data': { event: 'failed', severity: 'temporary', recipient: 'weich@example.com' } });
    assert.equal(await status('weich@example.com'), 'bounced', 'drei Soft-Bounces sperren');
    await send(hooks.mailgun, { 'event-data': { event: 'failed', severity: 'permanent', recipient: 'mg@example.com' } });
    assert.equal(await status('mg@example.com'), 'bounced');

    r = await send(hooks.sendgrid, [{ event: 'delivered', email: 'sg@example.com' }, { event: 'bounce', type: 'bounce', email: 'sg@example.com' }, { event: 'bounce', email: 'unbekannt@example.com' }]);
    assert.deepEqual(r.data, { ok: true, received: 2, processed: 1 });
    assert.equal(await status('sg@example.com'), 'bounced');

    // SNS sendet JSON als text/plain, die SES-Meldung steckt als Text in „Message“
    const sns = {
      Type: 'Notification',
      Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'ses@example.com' }] } }),
    };
    r = await t.request('POST', hooks.ses, { raw: JSON.stringify(sns), headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, auth: false });
    assert.equal(r.data.processed, 1);
    assert.equal(await status('ses@example.com'), 'bounced');

    // Bestätigungs-URL muss von AWS stammen
    r = await t.request('POST', hooks.ses, { raw: JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'http://169.254.169.254/' }), headers: { 'Content-Type': 'text/plain' }, auth: false });
    assert.equal(r.status, 400);
  });

  test('Geheimnis erneuern (nur Admin) macht alte Adressen ungültig', async () => {
    const renewed = (await t.post('/api/newsletter/bounce-urls/renew')).data;
    assert.notEqual(pathOf(renewed[0].url), hooks[renewed[0].provider]);
    assert.equal((await t.post(hooks.postmark, { RecordType: 'Bounce', Email: 'x@example.com' }, { auth: false })).status, 404);
  });
});

describe('Tracking-Einwilligung', () => {
  let t;
  let listId;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
    listId = (await t.get('/api/lists')).data[0].id;
    await t.put('/api/settings', { double_opt_in: false, tracking_mode: 'consent' });
  });
  after(() => t.close());

  const sendCampaign = async () => {
    const c = (await t.post('/api/campaigns', { name: 'T', subject: 'T', content_html: '<p><a href="https://example.org/x">Link</a></p>', list_ids: [listId] })).data;
    t.mailer.sent.length = 0;
    await t.post(`/api/campaigns/${c.id}/send`);
    await t.flush();
    return Object.fromEntries(t.mailer.sent.map((m) => [m.to, urls(m.html)]));
  };

  test('Formular fragt die Einwilligung ab, nur Einwilligende werden getrackt', async () => {
    const form = (await t.get('/subscribe', { auth: false })).data;
    assert.match(form, /name="tracking_consent"/);
    await t.post('/api/public/subscribe', { email: 'ja@example.com', consent: true, tracking_consent: true }, { auth: false });
    await t.post('/api/public/subscribe', { email: 'nein@example.com', consent: true }, { auth: false });

    const links = await sendCampaign();
    assert.ok(links['ja@example.com'].some((u) => u.includes('/t/c/')));
    assert.ok(links['ja@example.com'].some((u) => u.includes('/t/o/')));
    assert.ok(!links['nein@example.com'].some((u) => u.includes('/t/')), 'ohne Einwilligung kein Tracking');
    assert.ok(links['nein@example.com'].includes('https://example.org/x'));
  });

  test('Widerruf über die Einstellungsseite, Modus „aus“', async () => {
    const sub = (await t.get('/api/subscribers?q=ja@')).data.items[0];
    assert.equal(sub.tracking_consent, true);
    const token = t.db.get('SELECT token FROM subscribers WHERE id = ?', sub.id).token;
    const prefs = (await t.get(`/preferences/${token}`, { auth: false })).data;
    assert.match(prefs, /name="tracking_consent" value="1" checked/);
    await t.request('POST', `/preferences/${token}`, { form: { list_ids: String(listId) }, auth: false });
    assert.equal((await t.get(`/api/subscribers/${sub.id}`)).data.tracking_consent, false);
    assert.ok((await t.get(`/api/subscribers/${sub.id}`)).data.events.some((e) => e.type === 'tracking_consent_withdrawn'));

    await t.put('/api/settings', { tracking_mode: 'off' });
    t.db.run('UPDATE subscribers SET tracking_consent = 1');
    const links = await sendCampaign();
    assert.ok(Object.values(links).every((l) => !l.some((u) => u.includes('/t/'))));
    assert.doesNotMatch((await t.get('/subscribe', { auth: false })).data, /tracking_consent/);
  });
});
