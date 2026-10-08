import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cleanFields } from '../src/modules/forms/index.js';
import { startTestServer } from './helpers.js';

/** Signierter Zeitstempel, der 10 Sekunden alt ist (Mindest-Ausfüllzeit erfüllt). */
function agedStamp(services, formId, time) {
  const realNow = Date.now;
  Date.now = () => time;
  try {
    return services.forms.stamp(formId);
  } finally {
    Date.now = realNow;
  }
}

describe('Formulare', () => {
  let t;
  let form;
  before(async () => {
    t = await startTestServer();
    await t.setupAdmin();
  });
  after(() => t.close());

  test('Ersteinrichtung legt Kontaktformular, Kontaktseite und Menüpunkt an', async () => {
    const forms = (await t.get('/api/forms')).data;
    assert.equal(forms.length, 1);
    form = forms[0];
    assert.equal(form.notify_emails, 'admin@example.com');
    const page = await t.get('/kontakt', { auth: false });
    assert.equal(page.status, 200);
    assert.match(page.data, new RegExp(`<form class="cms-form" id="form-${form.id}" method="post" action="/formular/${form.id}"`));
    assert.match(page.data, /name="_ts"/);
    assert.match((await t.get('/', { auth: false })).data, /href="\/kontakt"/);
  });

  test('Felddefinitionen werden geprüft', () => {
    assert.throws(() => cleanFields([]), /mindestens ein Feld/);
    assert.throws(() => cleanFields([{ label: 'Farbe', type: 'select' }]), /Auswahloptionen/);
    const f = cleanFields([{ label: 'Ihr Name' }, { label: 'Ihr Name' }, { label: 'OK?', type: 'consent' }]);
    assert.deepEqual(f.map((x) => x.name), ['ihr_name', 'ihr_name_2', 'ok']);
    assert.equal(f[2].required, true);
  });

  test('Absenden: Validierung, Speichern, Benachrichtigung, Weiterleitung mit Erfolgsmeldung', async () => {
    const page = (await t.get('/kontakt', { auth: false })).data;
    const stamp = agedStamp(t.services, form.id, Date.now() - 10_000);
    const bad = await t.request('POST', `/formular/${form.id}`, {
      form: { name: '', e_mail: 'kaputt', nachricht: 'Hallo', _page: '/kontakt', _ts: stamp },
      auth: false,
    });
    assert.equal(bad.status, 422);
    assert.match(bad.data, /Bitte prüfe die markierten Felder/);
    assert.match(bad.data, /Bitte eine gültige E-Mail-Adresse angeben/);
    assert.match(bad.data, /value="Hallo"|>Hallo</, 'Eingaben bleiben erhalten');
    assert.ok(page.includes('name="e_mail"'));

    t.mailer.sent.length = 0;
    const consent = form.fields.find((f) => f.type === 'consent').name;
    const ok = await t.request('POST', `/formular/${form.id}`, {
      form: { name: 'Erika Muster', e_mail: 'Erika@Example.com', nachricht: 'Bitte um Rückruf <b>', [consent]: 'ja', _page: '/kontakt', _ts: stamp },
      auth: false,
    });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), `/kontakt?formular=${form.id}#form-${form.id}`);
    const success = (await t.get(`/kontakt?formular=${form.id}`, { auth: false })).data;
    assert.match(success, /class="form-success"/);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(t.mailer.sent.length, 1);
    const mail = t.mailer.sent[0];
    assert.equal(mail.to, 'admin@example.com');
    assert.equal(mail.replyTo, 'erika@example.com');
    assert.match(mail.html, /Bitte um Rückruf &lt;b&gt;/);

    const subs = (await t.get(`/api/forms/${form.id}/submissions`)).data;
    assert.equal(subs.total, 1);
    assert.equal(subs.items[0].data.e_mail, 'erika@example.com');
    assert.equal(subs.items[0].read_at, null);
    await t.post(`/api/forms/${form.id}/submissions/read`, { ids: [subs.items[0].id] });
    assert.equal((await t.get(`/api/forms/${form.id}/submissions?unread=1`)).data.total, 0);
    const csv = await t.get(`/api/forms/${form.id}/export`);
    assert.match(csv.data, /Erika Muster/);
  });

  test('Spamschutz: Honigtopf, fehlender/zu frischer Zeitstempel, fremde Weiterleitungsziele', async () => {
    const before = (await t.get(`/api/forms/${form.id}/submissions`)).data.total;
    const consent = form.fields.find((f) => f.type === 'consent').name;
    const valid = { name: 'Bot', e_mail: 'bot@example.com', nachricht: 'Spam', [consent]: 'ja' };
    const fresh = t.services.forms.stamp(form.id);
    for (const extra of [{ website: 'x', _ts: agedStamp(t.services, form.id, Date.now() - 10_000) }, { _ts: fresh }, { _ts: '123.abc' }, {}]) {
      const res = await t.request('POST', `/formular/${form.id}`, { form: { ...valid, ...extra, _page: '/kontakt' }, auth: false });
      assert.equal(res.status, 303, 'Bots sehen scheinbaren Erfolg');
    }
    assert.equal((await t.get(`/api/forms/${form.id}/submissions`)).data.total, before);

    const evil = await t.request('POST', `/formular/${form.id}`, {
      form: { ...valid, _page: '//evil.example', _ts: agedStamp(t.services, form.id, Date.now() - 10_000) },
      auth: false,
    });
    assert.equal(evil.status, 200, 'kein Redirect auf fremde Domains');
    assert.match(evil.data, /Vielen Dank/);
  });

  test('Newsletter-Opt-in mit Double-Opt-in', async () => {
    const created = await t.post('/api/forms', {
      name: 'Anfrage',
      fields: [{ label: 'Vorname', type: 'text' }, { label: 'E-Mail', type: 'email', required: true }],
      newsletter_optin: true,
      store: false,
    });
    assert.equal(created.status, 201);
    t.mailer.sent.length = 0;
    await t.request('POST', `/formular/${created.data.id}`, {
      form: { vorname: 'Lena', e_mail: 'lena@example.com', _newsletter: '1', _ts: agedStamp(t.services, created.data.id, Date.now() - 10_000) },
      auth: false,
    });
    const sub = (await t.get('/api/subscribers?q=lena')).data.items[0];
    assert.equal(sub.status, 'pending');
    assert.equal(sub.source, `form:${created.data.id}`);
    assert.ok(t.mailer.sent.some((m) => m.to === 'lena@example.com' && /bestätige/i.test(m.subject)));
    assert.equal((await t.get(`/api/forms/${created.data.id}/submissions`)).data.total, 0, 'store: false speichert nichts');
  });

  test('Formular per Baustein; gelöschte Formulare verschwinden', async () => {
    const f = (await t.post('/api/forms', { name: 'Kurz', fields: [{ label: 'Frage', type: 'text', required: true }] })).data;
    await t.post('/api/pages', { title: 'Frage', status: 'published', content: `<p>Vorher</p><p>[form id="${f.id}"]</p>` });
    assert.match((await t.get('/frage', { auth: false })).data, /cms-form/);
    await t.del(`/api/forms/${f.id}`);
    const html = (await t.get('/frage', { auth: false })).data;
    assert.doesNotMatch(html, /cms-form/);
    assert.doesNotMatch(html, /\[form/);
  });
});
