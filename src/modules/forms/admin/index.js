// Admin-Oberfläche des Formular-Moduls
import { api, del, get, post, put } from '/admin/js/api.js';
import { saveSettings } from '/admin/js/settings.js';
import { ctx, navigate } from '/admin/js/state.js';
import {
  $, confirmDialog, download, fmtDateTime, fmtNum, formData, html, modal, pager, raw, setHtml, toast, toastError,
} from '/admin/js/ui.js';

let cmsRef = null;
const TYPE_LABELS = {
  text: 'Textzeile', email: 'E-Mail', textarea: 'Mehrzeiliger Text', tel: 'Telefon', number: 'Zahl', date: 'Datum',
  select: 'Auswahlliste', radio: 'Optionsfelder', checkbox: 'Kontrollkästchen', consent: 'Einwilligung (Pflicht)',
};

async function formsView(el) {
  const forms = await get('/forms');
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Formulare</h1><div class="sub">Kontakt- und Anfrageformulare – einbinden mit dem Baustein <code>[form id="…"]</code></div></div>
        <div class="toolbar"><a class="btn btn-primary" href="#/forms/new">+ Neues Formular</a></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Baustein</th><th class="right">Einsendungen</th><th>Benachrichtigung</th><th></th></tr></thead>
        <tbody>${
          forms.length
            ? forms.map(
                (f) => html`<tr>
                  <td><a href="#/forms/${f.id}"><strong>${f.name}</strong></a><div class="muted small">${f.fields.length} Felder</div></td>
                  <td><code>[form id="${f.id}"]</code></td>
                  <td class="right"><a href="#/forms/${f.id}/submissions">${fmtNum(f.submission_count)}</a>${f.unread_count ? html` <span class="badge badge-info">${f.unread_count} neu</span>` : ''}</td>
                  <td class="small">${f.notify_emails || html`<span class="muted">–</span>`}</td>
                  <td class="right nowrap"><a class="btn btn-sm" href="#/forms/${f.id}/submissions">Einsendungen</a><a class="btn btn-sm" href="#/forms/${f.id}">Bearbeiten</a></td>
                </tr>`,
              )
            : html`<tr><td colspan="5" class="empty">Noch keine Formulare. <a href="#/forms/new">Erstes Formular anlegen</a></td></tr>`
        }</tbody>
      </table></div></div>`,
  );
}

function fieldRow(f, i, count) {
  const hasOptions = ['select', 'radio'].includes(f.type);
  return html`<li class="menu-item" data-i="${i}" style="align-items:flex-start">
    <div class="grow">
      <div class="inline-fields">
        <div class="field" style="margin-bottom:6px"><label>Beschriftung</label><input type="text" data-k="label" value="${f.label}" required></div>
        <div class="field" style="margin-bottom:6px;max-width:220px"><label>Typ</label><select data-k="type">${Object.entries(TYPE_LABELS).map(
          ([k, v]) => html`<option value="${k}" ${f.type === k ? raw('selected') : ''}>${v}</option>`,
        )}</select></div>
      </div>
      ${hasOptions ? html`<div class="field" style="margin-bottom:6px"><label>Optionen (eine pro Zeile)</label><textarea data-k="options" style="min-height:70px">${(f.options || []).join('\n')}</textarea></div>` : ''}
      ${
        ['checkbox', 'consent', 'select', 'radio'].includes(f.type)
          ? ''
          : html`<div class="field" style="margin-bottom:6px"><label>Platzhalter</label><input type="text" data-k="placeholder" value="${f.placeholder || ''}"></div>`
      }
      ${f.type === 'consent' ? html`<div class="muted small">Pflicht-Kontrollkästchen, z. B. für die Einwilligung in die Datenverarbeitung.</div>` : html`<label class="checkline"><input type="checkbox" data-k="required" ${f.required ? raw('checked') : ''}> Pflichtfeld</label>`}
    </div>
    <button type="button" class="icon-btn" data-act="up" title="Nach oben" ${i === 0 ? raw('disabled') : ''}>↑</button>
    <button type="button" class="icon-btn" data-act="down" title="Nach unten" ${i === count - 1 ? raw('disabled') : ''}>↓</button>
    <button type="button" class="icon-btn" data-act="del" title="Entfernen">✕</button>
  </li>`;
}

async function formEditorView(el, id) {
  const isNew = id === 'new';
  const [form, lists] = await Promise.all([
    isNew
      ? Promise.resolve({ name: '', fields: [{ label: 'Name', type: 'text', required: true }, { label: 'E-Mail', type: 'email', required: true }, { label: 'Nachricht', type: 'textarea', required: true }], submit_label: 'Absenden', success_message: 'Vielen Dank! Deine Nachricht ist bei uns angekommen.', notify_emails: ctx.user.email, store: true, newsletter_optin: false })
      : get(`/forms/${id}`),
    cmsRef.isEnabled('newsletter') ? get('/lists') : Promise.resolve(null),
  ]);
  const fields = form.fields.map((f) => ({ ...f }));

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/forms" class="small">‹ Formulare</a><h1>${isNew ? 'Neues Formular' : form.name}</h1>${!isNew ? html`<div class="sub">Einbinden mit <code>[form id="${form.id}"]</code></div>` : ''}</div>
        <div class="toolbar">${!isNew ? html`<button class="btn btn-ghost" id="delete">Löschen</button><a class="btn" href="#/forms/${form.id}/submissions">Einsendungen</a>` : ''}<button class="btn btn-primary" id="save">Speichern</button></div>
      </div>
      <form id="form-form" class="content-editor" novalidate>
        <div class="card">
          <div class="field"><label for="ff-name">Name *</label><input id="ff-name" name="name" type="text" required value="${form.name}" placeholder="z. B. Kontakt"></div>
          <h3>Felder</h3>
          <ul class="menu-items" id="fields"></ul>
          <button type="button" class="btn btn-sm" id="add-field">+ Feld hinzufügen</button>
        </div>
        <div class="stack">
          <div class="card side-card">
            <h3>Nach dem Absenden</h3>
            <div class="field"><label for="ff-btn">Beschriftung des Knopfs</label><input id="ff-btn" name="submit_label" type="text" value="${form.submit_label}"></div>
            <div class="field"><label for="ff-msg">Erfolgsmeldung</label><textarea id="ff-msg" name="success_message" style="min-height:70px">${form.success_message}</textarea></div>
            <div class="field"><label for="ff-notify">Benachrichtigung an</label><input id="ff-notify" name="notify_emails" type="text" value="${form.notify_emails}" placeholder="a@example.com, b@example.com"><div class="help">Mehrere Adressen mit Komma trennen. Antworten gehen an die eingegebene E-Mail-Adresse.</div></div>
            <label class="checkline"><input type="checkbox" name="store" ${form.store ? raw('checked') : ''}> Einsendungen speichern</label>
          </div>
          ${
            lists
              ? html`<div class="card side-card"><h3>Newsletter</h3>
                  <label class="checkline"><input type="checkbox" name="newsletter_optin" ${form.newsletter_optin ? raw('checked') : ''}> Häkchen „Newsletter abonnieren“ anbieten</label>
                  <div class="field"><label for="ff-list">Liste</label><select id="ff-list" name="newsletter_list_id"><option value="">Alle öffentlichen Listen</option>${lists.map(
                    (l) => html`<option value="${l.id}" ${form.newsletter_list_id === l.id ? raw('selected') : ''}>${l.name}</option>`,
                  )}</select><div class="help">Anmeldung mit Double-Opt-in. Das Formular braucht ein E-Mail-Feld.</div></div></div>`
              : ''
          }
        </div>
      </form>`,
  );

  const list = $('#fields', el);
  const render = () => {
    setHtml(list, fields.map((f, i) => fieldRow(f, i, fields.length)));
  };
  // Eingaben direkt in das Feld-Array übernehmen
  list.addEventListener('input', (e) => {
    const row = e.target.closest('[data-i]');
    const key = e.target.dataset.k;
    if (!row || !key) return;
    const f = fields[Number(row.dataset.i)];
    if (key === 'required') f.required = e.target.checked;
    else if (key === 'options') f.options = e.target.value.split('\n');
    else f[key] = e.target.value;
  });
  list.addEventListener('change', (e) => {
    if (e.target.dataset.k === 'type') {
      fields[Number(e.target.closest('[data-i]').dataset.i)].type = e.target.value;
      render();
    }
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const i = Number(btn.closest('[data-i]').dataset.i);
    if (btn.dataset.act === 'up' && i > 0) [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]];
    if (btn.dataset.act === 'down' && i < fields.length - 1) [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]];
    if (btn.dataset.act === 'del') fields.splice(i, 1);
    render();
  });
  $('#add-field', el).addEventListener('click', () => {
    fields.push({ label: '', type: 'text', required: false });
    render();
    list.lastElementChild?.querySelector('input')?.focus();
  });
  render();

  $('#save', el).addEventListener('click', async () => {
    const d = formData($('#form-form', el));
    const data = {
      name: d.name,
      fields: fields.map(({ name, label, type, required, placeholder, options }) => ({ name, label, type, required, placeholder, options })),
      submit_label: d.submit_label,
      success_message: d.success_message,
      notify_emails: d.notify_emails,
      store: d.store,
      newsletter_optin: Boolean(d.newsletter_optin),
      newsletter_list_id: d.newsletter_list_id ? Number(d.newsletter_list_id) : null,
    };
    try {
      const saved = isNew ? await post('/forms', data) : await put(`/forms/${id}`, data);
      toast('Formular gespeichert');
      if (isNew) navigate(`#/forms/${saved.id}`);
      else formEditorView(el, id);
    } catch (err) {
      toastError(err);
    }
  });
  $('#delete', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Formular löschen', `„${form.name}“ und alle Einsendungen löschen? Seiten mit dem Baustein zeigen das Formular dann nicht mehr an.`, { submitLabel: 'Löschen' }))) return;
    await del(`/forms/${id}`);
    toast('Formular gelöscht');
    navigate('#/forms');
  });
}

async function submissionsView(el, id) {
  const form = await get(`/forms/${id}`);
  const state = { page: 1, unread: false };
  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/forms" class="small">‹ Formulare</a><h1>Einsendungen: ${form.name}</h1></div>
        <div class="toolbar"><label class="checkline" style="margin:0"><input type="checkbox" id="unread"> nur ungelesene</label><button class="btn" id="export">CSV exportieren</button></div>
      </div>
      <div class="card" id="rows"></div>`,
  );
  const box = $('#rows', el);
  const label = (name) => form.fields.find((f) => f.name === name)?.label || name;
  const load = async () => {
    const qs = new URLSearchParams({ page: state.page, per_page: 30 });
    if (state.unread) qs.set('unread', '1');
    const data = await get(`/forms/${id}/submissions?${qs}`);
    const preview = (s) => form.fields.slice(0, 3).map((f) => s.data[f.name]).filter(Boolean).join(' · ');
    setHtml(
      box,
      html`<div class="table-wrap"><table><thead><tr><th>Eingang</th><th>Inhalt</th><th></th></tr></thead><tbody>${
        data.items.length
          ? data.items.map(
              (s) => html`<tr class="clickable" data-id="${s.id}">
                <td class="nowrap small">${s.read_at ? '' : html`<span class="badge badge-info">neu</span> `}${fmtDateTime(s.created_at)}</td>
                <td style="overflow-wrap:anywhere">${preview(s).slice(0, 160)}</td>
                <td class="right"><button class="btn btn-sm btn-ghost" data-del="${s.id}" aria-label="Löschen">🗑</button></td></tr>`,
            )
          : html`<tr><td colspan="3" class="empty">Keine Einsendungen.</td></tr>`
      }</tbody></table></div>`,
    );
    box.append(pager(data, (p) => ((state.page = p), load())));
    box.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', async (e) => {
        const s = data.items.find((x) => x.id === Number(tr.dataset.id));
        if (e.target.closest('[data-del]')) {
          if (!(await confirmDialog('Einsendung löschen', 'Diese Einsendung endgültig löschen?', { submitLabel: 'Löschen' }))) return;
          await post(`/forms/${id}/submissions/delete`, { ids: [s.id] });
          return load();
        }
        if (!s.read_at) post(`/forms/${id}/submissions/read`, { ids: [s.id] }).then(load).catch(() => null);
        const emailField = form.fields.find((f) => f.type === 'email');
        const email = emailField && s.data[emailField.name];
        modal({
          title: `Einsendung vom ${fmtDateTime(s.created_at)}`,
          wide: true,
          cancelLabel: 'Schließen',
          body: html`<dl class="summary-list">${Object.entries(s.data).map(([k, v]) => html`<dt>${label(k)}</dt><dd style="white-space:pre-wrap">${v || '–'}</dd>`)}</dl>
            <p class="muted small" style="margin-top:14px">Seite: ${s.page || '–'} · IP: ${s.ip || '–'}</p>
            ${email ? html`<a class="btn btn-sm" href="mailto:${email}">Antworten</a>` : ''}`,
        });
      }),
    );
  };
  $('#unread', el).addEventListener('change', (e) => ((state.unread = e.target.checked), (state.page = 1), load()));
  $('#export', el).addEventListener('click', async () => {
    try {
      const res = await api(`/forms/${id}/export`, { raw: true });
      download(`formular-${id}.csv`, await res.blob());
    } catch (err) {
      toastError(err);
    }
  });
  await load();
}

async function formsSettingsTab(box) {
  const s = await ctx.getSettings(true);
  setHtml(
    box,
    html`<form class="card" id="forms-settings">
      <h2>Formulare</h2>
      <div class="field"><label for="fs-ret">Einsendungen automatisch löschen nach (Tagen)</label><input id="fs-ret" name="forms_retention_days" type="number" min="0" max="3650" value="${s.forms_retention_days}"><div class="help">0 = nie löschen. Datensparsamkeit nach DSGVO: nur so lange speichern wie nötig.</div></div>
      <button class="btn btn-primary" type="submit">Speichern</button>
    </form>`,
  );
  $('#forms-settings', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveSettings({ forms_retention_days: Number(e.target.forms_retention_days.value) });
    } catch (err) {
      toastError(err);
    }
  });
}

export default function register(cms) {
  cmsRef = cms;
  cms.nav({ href: '#/forms', label: 'Formulare', icon: 'forms', group: 'Inhalte', order: 35 });
  cms.route(/^\/forms$/, formsView);
  cms.route(/^\/forms\/(new|\d+)$/, formEditorView);
  cms.route(/^\/forms\/(\d+)\/submissions$/, submissionsView);
  cms.settingsTab({ id: 'forms', label: 'Formulare', order: 35, adminOnly: true, render: formsSettingsTab });
  cms.widget({
    id: 'forms',
    size: 'tile',
    order: 25,
    render(el, data) {
      const n = data.forms?.unread ?? 0;
      setHtml(el, html`<div class="label">Neue Formular-Einsendungen</div><div class="value">${fmtNum(n)}</div><div class="hint"><a href="#/forms">Formulare ansehen</a></div>`);
    },
  });
}

