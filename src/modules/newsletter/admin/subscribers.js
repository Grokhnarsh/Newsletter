import { api, del, get, post, put } from '/admin/js/api.js';
import { ctx, navigate } from '/admin/js/state.js';
import {
  $, $$, RECIPIENT_STATUS, SUBSCRIBER_STATUS, badge, confirmDialog, debounce, download, fmtDate, fmtDateTime, formData,
  html, modal, pager, raw, setHtml, toast, toastError, setText,
} from '/admin/js/ui.js';

const EVENT_LABELS = {
  created: 'Angelegt',
  subscribed: 'Angemeldet / bestätigt',
  pending: 'Wartet auf Bestätigung',
  unsubscribed: 'Abgemeldet',
  bounced: 'Bounce',
  soft_bounce: 'Soft-Bounce',
  complained: 'Spam-Beschwerde',
  open: 'Geöffnet',
  click: 'Link geklickt',
  preferences_updated: 'Einstellungen geändert',
  tracking_consent_given: 'Tracking-Einwilligung erteilt',
  tracking_consent_withdrawn: 'Tracking-Einwilligung widerrufen',
};

function subscriberForm(lists, s = {}) {
  const attrs = s.attributes && Object.keys(s.attributes).length ? JSON.stringify(s.attributes, null, 2) : '';
  return html`
    <div class="field"><label for="f-email">E-Mail *</label><input id="f-email" name="email" type="email" required value="${s.email || ''}"></div>
    <div class="inline-fields">
      <div class="field"><label for="f-first">Vorname</label><input id="f-first" name="first_name" type="text" value="${s.first_name || ''}"></div>
      <div class="field"><label for="f-last">Nachname</label><input id="f-last" name="last_name" type="text" value="${s.last_name || ''}"></div>
    </div>
    <div class="field"><label for="f-status">Status</label>
      <select id="f-status" name="status">${Object.entries(SUBSCRIBER_STATUS).map(
        ([k, v]) => html`<option value="${k}" ${(s.status || 'active') === k ? raw('selected') : ''}>${v}</option>`,
      )}</select>
      <div class="help">Manuell angelegte Abonnenten sollten nachweislich eingewilligt haben (DSGVO).</div>
    </div>
    <div class="field"><label>Listen</label>
      <div class="checks">${
        lists.length
          ? lists.map(
              (l) => html`<label class="checkline"><input type="checkbox" name="list_ids" data-array value="${l.id}" ${(s.list_ids || []).includes(l.id) ? raw('checked') : ''}> ${l.name}</label>`,
            )
          : html`<span class="muted">Noch keine Listen vorhanden.</span>`
      }</div>
    </div>
    <div class="field"><label for="f-attrs">Eigene Felder (JSON)</label>
      <textarea id="f-attrs" name="attributes" class="code" style="min-height:90px" placeholder='{"firma": "Beispiel GmbH"}'>${attrs}</textarea>
      <div class="help">Im Newsletter nutzbar als <code>{{attributes.firma}}</code></div>
    </div>`;
}

function readSubscriberForm(form) {
  const data = formData(form);
  data.list_ids = (data.list_ids || []).map(Number);
  if (data.attributes?.trim()) {
    try {
      data.attributes = JSON.parse(data.attributes);
    } catch {
      throw new Error('Eigene Felder: ungültiges JSON');
    }
  } else data.attributes = {};
  return data;
}

export async function openSubscriberDialog(existing, onSaved) {
  const lists = await ctx.getLists();
  modal({
    title: existing ? 'Abonnent bearbeiten' : 'Abonnent hinzufügen',
    body: subscriberForm(lists, existing || {}),
    onSubmit: async (form) => {
      const data = readSubscriberForm(form);
      const saved = existing ? await put(`/subscribers/${existing.id}`, data) : await post('/subscribers', data);
      toast(existing ? 'Gespeichert' : 'Abonnent hinzugefügt');
      ctx.invalidateLists();
      onSaved?.(saved);
    },
  });
}

function importDialog(onDone) {
  ctx.getLists().then((lists) =>
    modal({
      title: 'Abonnenten importieren',
      wide: true,
      submitLabel: 'Importieren',
      body: html`
        <p class="muted">CSV-Datei mit Kopfzeile. Erkannte Spalten: <code>email</code>, <code>first_name</code>/<code>vorname</code>,
        <code>last_name</code>/<code>nachname</code>, <code>name</code>, <code>status</code>. Alle weiteren Spalten werden als eigene Felder gespeichert.
        Trennzeichen (Komma, Semikolon, Tab) werden automatisch erkannt.</p>
        <div class="field"><label for="imp-file">CSV-Datei</label><input id="imp-file" type="file" accept=".csv,text/csv,text/plain"></div>
        <div class="field"><label for="imp-csv">… oder Inhalt einfügen</label><textarea id="imp-csv" name="csv" class="code" style="min-height:160px" placeholder="email;vorname;nachname&#10;anna@example.com;Anna;Schmidt"></textarea></div>
        <div class="inline-fields">
          <div class="field"><label>Zu Listen hinzufügen</label><div class="checks">${lists.map(
            (l) => html`<label class="checkline"><input type="checkbox" name="list_ids" data-array value="${l.id}"> ${l.name}</label>`,
          )}</div></div>
          <div class="field">
            <label for="imp-status">Status neuer Abonnenten</label>
            <select id="imp-status" name="status"><option value="active">Aktiv (Einwilligung liegt vor)</option><option value="unsubscribed">Abgemeldet (Sperrliste)</option></select>
            <label class="checkline" style="margin-top:12px"><input type="checkbox" name="update_existing" checked> Bestehende Abonnenten aktualisieren</label>
          </div>
        </div>
        <div id="imp-result"></div>`,
      onOpen: (dialog) => {
        $('#imp-file', dialog).addEventListener('change', async (e) => {
          const file = e.target.files[0];
          if (file) $('#imp-csv', dialog).value = await file.text();
        });
      },
      onSubmit: async (form) => {
        const data = formData(form);
        if (!data.csv.trim()) throw new Error('Bitte eine CSV-Datei auswählen oder Inhalt einfügen');
        const res = await post('/subscribers/import', { ...data, list_ids: (data.list_ids || []).map(Number) });
        setHtml(
          $('#imp-result', form),
          html`<div class="callout ${res.errors.length ? 'warn' : ''}"><strong>Import abgeschlossen:</strong> ${res.created} neu, ${res.updated} aktualisiert, ${res.skipped} übersprungen, ${res.errors.length} Fehler.
          ${res.errors.length ? html`<ul class="small">${res.errors.slice(0, 20).map((e) => html`<li>Zeile ${e.row}: ${e.error}</li>`)}</ul>` : ''}</div>`,
        );
        ctx.invalidateLists();
        onDone();
        return res.errors.length ? false : undefined;
      },
    }),
  );
}

export async function subscribersView(el) {
  const lists = await ctx.getLists(true);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const state = { q: '', status: '', list_id: params.get('list') || '', page: 1, selected: new Set() };

  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Abonnenten</h1><div class="sub">Verwalte deine Empfänger, importiere und exportiere Daten</div></div>
        <div class="toolbar">
          <button class="btn" id="import-btn">Importieren</button>
          <button class="btn" id="export-btn">CSV exportieren</button>
          <button class="btn btn-primary" id="add-btn">+ Abonnent</button>
        </div>
      </div>
      <div class="card">
        <div class="toolbar" style="margin-bottom:12px">
          <input type="search" id="q" placeholder="Suche nach E-Mail oder Name …" style="max-width:300px" aria-label="Suche">
          <select id="status" style="max-width:180px" aria-label="Status"><option value="">Alle Status</option>${Object.entries(SUBSCRIBER_STATUS).map(
            ([k, v]) => html`<option value="${k}">${v}</option>`,
          )}</select>
          <select id="list" style="max-width:220px" aria-label="Liste"><option value="">Alle Listen</option>${lists.map(
            (l) => html`<option value="${l.id}" ${String(l.id) === state.list_id ? raw('selected') : ''}>${l.name}</option>`,
          )}</select>
          <div style="flex:1"></div>
          <div id="bulk" class="toolbar hidden">
            <span class="muted small" id="bulk-count"></span>
            <select id="bulk-action" aria-label="Aktion für Auswahl">
              <option value="">Aktion wählen …</option>
              <optgroup label="Liste">${lists.map((l) => html`<option value="add:${l.id}">Zu „${l.name}“ hinzufügen</option>`)}</optgroup>
              <optgroup label="Liste entfernen">${lists.map((l) => html`<option value="remove:${l.id}">Aus „${l.name}“ entfernen</option>`)}</optgroup>
              <optgroup label="Status">${Object.entries(SUBSCRIBER_STATUS).map(([k, v]) => html`<option value="status:${k}">Status: ${v}</option>`)}</optgroup>
              <option value="delete">Löschen</option>
            </select>
            <button class="btn btn-sm" id="bulk-run">Ausführen</button>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th class="check"><input type="checkbox" id="all" aria-label="Alle auswählen"></th><th>E-Mail</th><th>Name</th><th>Status</th><th>Listen</th><th>Angemeldet</th></tr></thead>
          <tbody id="rows"></tbody>
        </table></div>
        <div id="pager"></div>
      </div>`,
  );

  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const rows = $('#rows', el);

  const updateBulk = () => {
    $('#bulk', el).classList.toggle('hidden', state.selected.size === 0);
    setText($('#bulk-count', el), `${state.selected.size} ausgewählt`);
  };

  async function load() {
    const qs = new URLSearchParams({ page: state.page, per_page: 25 });
    if (state.q) qs.set('q', state.q);
    if (state.status) qs.set('status', state.status);
    if (state.list_id) qs.set('list_id', state.list_id);
    const data = await get(`/subscribers?${qs}`);
    state.selected.clear();
    $('#all', el).checked = false;
    updateBulk();
    setHtml(
      rows,
      data.items.length
        ? data.items.map(
            (s) => html`<tr class="clickable" data-id="${s.id}">
              <td class="check"><input type="checkbox" class="sel" value="${s.id}" aria-label="Auswählen"></td>
              <td><strong>${s.email}</strong></td>
              <td>${[s.first_name, s.last_name].filter(Boolean).join(' ') || html`<span class="muted">–</span>`}</td>
              <td>${badge(s.status, SUBSCRIBER_STATUS)}</td>
              <td>${s.list_ids.map((id) => html`<span class="chip">${listName.get(id) || id}</span>`)}</td>
              <td class="nowrap">${fmtDate(s.created_at)}</td>
            </tr>`,
          )
        : html`<tr><td colspan="6" class="empty">Keine Abonnenten gefunden.</td></tr>`,
    );
    $('#pager', el).replaceChildren(
      pager(data, (p) => {
        state.page = p;
        load();
      }),
    );
  }

  rows.addEventListener('click', (e) => {
    const cb = e.target.closest('input.sel');
    if (cb) {
      if (cb.checked) state.selected.add(Number(cb.value));
      else state.selected.delete(Number(cb.value));
      return updateBulk();
    }
    if (e.target.closest('td.check')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) navigate(`#/subscribers/${tr.dataset.id}`);
  });
  $('#all', el).addEventListener('change', (e) => {
    $$('input.sel', rows).forEach((cb) => {
      cb.checked = e.target.checked;
      if (cb.checked) state.selected.add(Number(cb.value));
      else state.selected.delete(Number(cb.value));
    });
    updateBulk();
  });
  $('#q', el).addEventListener(
    'input',
    debounce((e) => {
      state.q = e.target.value.trim();
      state.page = 1;
      load();
    }),
  );
  $('#status', el).addEventListener('change', (e) => {
    state.status = e.target.value;
    state.page = 1;
    load();
  });
  $('#list', el).addEventListener('change', (e) => {
    state.list_id = e.target.value;
    state.page = 1;
    load();
  });
  $('#bulk-run', el).addEventListener('click', async () => {
    const value = $('#bulk-action', el).value;
    if (!value) return;
    const [action, arg] = value.split(':');
    const ids = [...state.selected];
    const body = { ids };
    if (action === 'delete') {
      if (!(await confirmDialog('Abonnenten löschen', `${ids.length} Abonnent(en) endgültig löschen? Das kann nicht rückgängig gemacht werden.`, { submitLabel: 'Löschen' }))) return;
      body.action = 'delete';
    } else if (action === 'add' || action === 'remove') {
      body.action = action === 'add' ? 'add_to_list' : 'remove_from_list';
      body.list_id = Number(arg);
    } else {
      body.action = 'set_status';
      body.status = arg;
    }
    try {
      const res = await post('/subscribers/bulk', body);
      toast(`${res.affected} Abonnent(en) aktualisiert`);
      ctx.invalidateLists();
      load();
    } catch (err) {
      toastError(err);
    }
  });
  $('#add-btn', el).addEventListener('click', () => openSubscriberDialog(null, load));
  $('#import-btn', el).addEventListener('click', () => importDialog(load));
  $('#export-btn', el).addEventListener('click', async () => {
    const qs = new URLSearchParams();
    if (state.q) qs.set('q', state.q);
    if (state.status) qs.set('status', state.status);
    if (state.list_id) qs.set('list_id', state.list_id);
    try {
      const res = await api(`/subscribers/export?${qs}`, { raw: true });
      download(`abonnenten-${new Date().toISOString().slice(0, 10)}.csv`, await res.blob());
    } catch (err) {
      toastError(err);
    }
  });

  await load();
}

export async function subscriberDetailView(el, id) {
  const [s, lists] = await Promise.all([get(`/subscribers/${id}`), ctx.getLists()]);
  const listName = new Map(lists.map((l) => [l.id, l.name]));

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/subscribers" class="small">‹ Abonnenten</a><h1>${s.email}</h1>
          <div class="sub">${[s.first_name, s.last_name].filter(Boolean).join(' ')} ${badge(s.status, SUBSCRIBER_STATUS)}</div></div>
        <div class="toolbar">
          ${s.status === 'pending' ? html`<button class="btn" id="resend">Bestätigung erneut senden</button>` : ''}
          <button class="btn" id="edit">Bearbeiten</button>
          <button class="btn btn-danger" id="delete">Löschen</button>
        </div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <h2>Stammdaten</h2>
          <dl class="summary-list">
            <dt>Status</dt><dd>${badge(s.status, SUBSCRIBER_STATUS)}</dd>
            <dt>Listen</dt><dd>${s.list_ids.length ? s.list_ids.map((l) => html`<span class="chip">${listName.get(l)}</span>`) : '–'}</dd>
            <dt>Quelle</dt><dd>${s.source || '–'}</dd>
            <dt>Angelegt</dt><dd>${fmtDateTime(s.created_at)}</dd>
            <dt>Einwilligung</dt><dd>${fmtDateTime(s.consent_at)}${s.ip ? ` (IP ${s.ip})` : ''}</dd>
            <dt>Bestätigt</dt><dd>${fmtDateTime(s.confirmed_at)}</dd>
            <dt>Tracking</dt><dd>${s.tracking_consent ? `eingewilligt am ${fmtDateTime(s.tracking_consent_at)}` : s.tracking_consent_at ? `widerrufen am ${fmtDateTime(s.tracking_consent_at)}` : 'keine Einwilligung'}</dd>
            <dt>Abgemeldet</dt><dd>${fmtDateTime(s.unsubscribed_at)}</dd>
            ${Object.entries(s.attributes).map(([k, v]) => html`<dt>${k}</dt><dd>${typeof v === 'object' ? JSON.stringify(v) : v}</dd>`)}
          </dl>
        </div>
        <div class="card">
          <h2>Aktivität</h2>
          ${
            s.events.length
              ? html`<div class="table-wrap"><table><tbody>${s.events.map(
                  (e) => html`<tr><td class="nowrap small">${fmtDateTime(e.created_at)}</td><td>${EVENT_LABELS[e.type] || e.type}${
                    e.campaign_name ? html` <span class="muted small">· ${e.campaign_name}</span>` : ''
                  }${e.data?.url ? html`<div class="muted small" style="overflow-wrap:anywhere">${e.data.url}</div>` : ''}</td></tr>`,
                )}</tbody></table></div>`
              : html`<p class="muted">Keine Aktivität.</p>`
          }
        </div>
      </div>
      <div class="card">
        <h2>Erhaltene Kampagnen</h2>
        ${
          s.campaigns.length
            ? html`<div class="table-wrap"><table><thead><tr><th>Kampagne</th><th>Status</th><th>Gesendet</th><th>Geöffnet</th><th>Geklickt</th></tr></thead><tbody>${s.campaigns.map(
                (c) => html`<tr><td><a href="#/campaigns/${c.id}/report">${c.name}</a></td><td>${badge(c.status, RECIPIENT_STATUS)}</td><td>${fmtDateTime(c.sent_at)}</td>
                  <td>${c.opened_at ? `${fmtDateTime(c.opened_at)} (${c.open_count}×)` : '–'}</td><td>${c.clicked_at ? `${fmtDateTime(c.clicked_at)} (${c.click_count}×)` : '–'}</td></tr>`,
              )}</tbody></table></div>`
            : html`<p class="muted">Noch keine Kampagnen erhalten.</p>`
        }
      </div>`,
  );

  $('#edit', el).addEventListener('click', () => openSubscriberDialog(s, () => subscriberDetailView(el, id)));
  $('#delete', el).addEventListener('click', async () => {
    if (!(await confirmDialog('Abonnent löschen', `${s.email} und alle zugehörigen Daten endgültig löschen?`, { submitLabel: 'Löschen' }))) return;
    try {
      await del(`/subscribers/${id}`);
      toast('Abonnent gelöscht');
      navigate('#/subscribers');
    } catch (err) {
      toastError(err);
    }
  });
  $('#resend', el)?.addEventListener('click', async () => {
    try {
      await post(`/subscribers/${id}/resend-confirmation`);
      toast('Bestätigungs-E-Mail gesendet');
    } catch (err) {
      toastError(err);
    }
  });
}
