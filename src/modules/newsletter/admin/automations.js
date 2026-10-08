import { del, get, post, put } from '/admin/js/api.js';
import { richEditor } from '/admin/js/editor.js';
import { ctx, navigate } from '/admin/js/state.js';
import { $, $$, confirmDialog, fmtNum, html, raw, setHtml, toast, toastError } from '/admin/js/ui.js';

const STATUS = { draft: 'Entwurf', active: 'Aktiv', paused: 'Pausiert' };
const TONE = { draft: 'muted', active: 'good', paused: 'warn' };

function delayText(hours) {
  if (!hours) return 'sofort';
  if (hours % 24 === 0) return `nach ${hours / 24} ${hours === 24 ? 'Tag' : 'Tagen'}`;
  return `nach ${hours} ${hours === 1 ? 'Stunde' : 'Stunden'}`;
}

export async function automationsView(el) {
  const items = await get('/automations');
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Automationen</h1><div class="sub">E-Mail-Serien, die nach der Anmeldung automatisch starten – z. B. eine Willkommensstrecke</div></div>
        <div class="toolbar"><a class="btn btn-primary" href="#/automations/new">+ Neue Automation</a></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Status</th><th>Auslöser</th><th class="right">Schritte</th><th class="right">Laufend</th><th class="right">Abgeschlossen</th><th class="right">Versendet</th></tr></thead>
        <tbody>${
          items.length
            ? items.map(
                (a) => html`<tr class="clickable" data-id="${a.id}">
                  <td><strong>${a.name}</strong></td>
                  <td><span class="badge badge-${TONE[a.status]}">${STATUS[a.status]}</span></td>
                  <td class="small">Anmeldung${a.list_name ? html` zur Liste „${a.list_name}“` : ''}</td>
                  <td class="right num">${fmtNum(a.step_count)}</td>
                  <td class="right num">${fmtNum(a.active_runs)}</td>
                  <td class="right num">${fmtNum(a.completed_runs)}</td>
                  <td class="right num">${fmtNum(a.sent)}</td></tr>`,
              )
            : html`<tr><td colspan="7" class="empty">Noch keine Automationen. <a href="#/automations/new">Willkommensserie anlegen</a></td></tr>`
        }</tbody></table></div></div>`,
  );
  $('tbody', el).addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) navigate(`#/automations/${tr.dataset.id}`);
  });
}

const NEW_AUTOMATION = {
  name: 'Willkommensserie',
  status: 'draft',
  list_id: null,
  steps: [
    { subject: 'Willkommen bei {{site_name}}!', delay_hours: 0, content_html: '<p>Hallo {{first_name | "zusammen"}},</p><p>schön, dass du dabei bist! Das erwartet dich …</p>' },
    { subject: 'Unsere beliebtesten Beiträge', delay_hours: 72, content_html: '<p>Hallo {{first_name | "zusammen"}},</p><p>hier sind ein paar Lesetipps für den Einstieg …</p>' },
  ],
  runs: { active: 0, done: 0, cancelled: 0 },
};

export async function automationEditorView(el, id) {
  const isNew = id === 'new';
  const [lists, templates, automation] = await Promise.all([ctx.getLists(true), get('/templates'), isNew ? structuredClone(NEW_AUTOMATION) : get(`/automations/${id}`)]);
  let steps = automation.steps.map((s) => ({ ...s }));
  let editors = [];
  let dirty = false;

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/automations" class="small">‹ Automationen</a><h1>${isNew ? 'Neue Automation' : automation.name}</h1>
          <div class="sub">${isNew ? '' : html`${fmtNum(automation.runs.active)} laufend · ${fmtNum(automation.runs.done)} abgeschlossen · ${fmtNum(automation.runs.cancelled)} abgebrochen`}</div></div>
        <div class="toolbar">${isNew ? '' : html`<button class="btn btn-ghost" id="delete">Löschen</button>`}<button class="btn btn-primary" id="save">Speichern</button></div>
      </div>
      <div class="card">
        <div class="inline-fields">
          <div class="field"><label for="a-name">Name *</label><input id="a-name" type="text" value="${automation.name}" required></div>
          <div class="field"><label for="a-list">Startet bei Anmeldung</label><select id="a-list">
            <option value="">zu einer beliebigen Liste</option>${lists.map((l) => html`<option value="${l.id}" ${automation.list_id === l.id ? raw('selected') : ''}>zur Liste „${l.name}“</option>`)}
          </select></div>
          <div class="field"><label for="a-status">Status</label><select id="a-status">${Object.entries(STATUS).map(
            ([k, v]) => html`<option value="${k}" ${automation.status === k ? raw('selected') : ''}>${v}</option>`,
          )}</select></div>
        </div>
        <p class="muted small">Neue Abonnenten werden aufgenommen, sobald sie ihre Anmeldung bestätigt haben (bzw. direkt, wenn Double-Opt-in aus ist). Abgemeldete Abonnenten verlassen die Serie automatisch.
        Pausierte Automationen nehmen niemanden auf und versenden nichts.</p>
      </div>
      <div id="steps"></div>
      <button class="btn" id="add-step">+ Schritt hinzufügen</button>`,
  );

  // Aktuelle Eingaben aus dem DOM übernehmen (vor jedem Neuaufbau)
  const collect = () => {
    $$('[data-step]', el).forEach((card, i) => {
      Object.assign(steps[i], {
        subject: $('[name=subject]', card).value,
        preheader: $('[name=preheader]', card).value,
        delay_hours: Number($('[name=delay]', card).value) * Number($('[name=unit]', card).value),
        template_id: Number($('[name=template]', card).value) || null,
        content_html: editors[i].getValue(),
      });
    });
    return steps;
  };

  const renderSteps = () => {
    const box = $('#steps', el);
    setHtml(
      box,
      html`${steps.map((s, i) => {
        const days = s.delay_hours && s.delay_hours % 24 === 0;
        return html`<div class="card" data-step="${i}">
          <div class="card-head"><h2>Schritt ${i + 1} <span class="muted small" style="font-weight:400">· ${delayText(s.delay_hours)} ${i === 0 ? 'nach der Anmeldung' : 'nach Schritt ' + i}</span></h2>
            <div class="toolbar">
              ${s.sent !== undefined ? html`<span class="muted small">${fmtNum(s.sent)} versendet · ${fmtNum(s.waiting)} warten</span>` : ''}
              <button type="button" class="btn btn-sm btn-ghost" data-move="${i}" data-dir="-1" ${i === 0 ? raw('disabled') : ''} aria-label="Nach oben">↑</button>
              <button type="button" class="btn btn-sm btn-ghost" data-move="${i}" data-dir="1" ${i === steps.length - 1 ? raw('disabled') : ''} aria-label="Nach unten">↓</button>
              <button type="button" class="btn btn-sm btn-ghost" data-remove="${i}" aria-label="Schritt entfernen">🗑</button>
            </div></div>
          <div class="inline-fields">
            <div class="field"><label>Wartezeit</label><div style="display:flex;gap:6px">
              <input name="delay" type="number" min="0" max="8760" value="${days ? s.delay_hours / 24 : s.delay_hours}" style="max-width:100px" aria-label="Wartezeit">
              <select name="unit" aria-label="Einheit" style="width:auto"><option value="1" ${days ? '' : raw('selected')}>Stunden</option><option value="24" ${days ? raw('selected') : ''}>Tage</option></select></div></div>
            <div class="field"><label>Vorlage</label><select name="template"><option value="">Standardvorlage</option>${templates.map(
              (t) => html`<option value="${t.id}" ${s.template_id === t.id ? raw('selected') : ''}>${t.name}</option>`,
            )}</select></div>
          </div>
          <div class="field"><label>Betreff *</label><input name="subject" type="text" value="${s.subject}" required></div>
          <div class="field"><label>Vorschautext</label><input name="preheader" type="text" value="${s.preheader || ''}"></div>
          <div data-editor></div>
        </div>`;
      })}${steps.length ? '' : html`<div class="card empty">Noch keine Schritte.</div>`}`,
    );
    editors = $$('[data-step]', el).map((card, i) => richEditor($('[data-editor]', card), { value: steps[i].content_html, onChange: () => (dirty = true) }));
  };

  $('#steps', el).addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    const remove = e.target.closest('[data-remove]');
    if (!move && !remove) return;
    collect();
    if (move) {
      const i = Number(move.dataset.move);
      const j = i + Number(move.dataset.dir);
      [steps[i], steps[j]] = [steps[j], steps[i]];
    } else {
      steps.splice(Number(remove.dataset.remove), 1);
    }
    dirty = true;
    renderSteps();
  });
  el.addEventListener('input', () => (dirty = true));
  $('#add-step', el).addEventListener('click', () => {
    collect();
    steps.push({ subject: '', delay_hours: 24, content_html: '<p>Hallo {{first_name | "zusammen"}},</p><p></p>' });
    renderSteps();
    $$('[data-step]', el).at(-1).scrollIntoView({ behavior: 'smooth' });
  });
  $('#save', el).addEventListener('click', async () => {
    const data = {
      name: $('#a-name', el).value.trim(),
      list_id: Number($('#a-list', el).value) || null,
      status: $('#a-status', el).value,
      steps: collect(),
    };
    if (!data.name) return toastError(new Error('Bitte einen Namen angeben'));
    try {
      const saved = isNew ? await post('/automations', data) : await put(`/automations/${id}`, data);
      dirty = false;
      toast(saved.status === 'active' ? 'Gespeichert – die Automation ist aktiv' : 'Automation gespeichert');
      if (isNew) navigate(`#/automations/${saved.id}`);
      else automationEditorView(el, id);
    } catch (err) {
      toastError(err);
    }
  });
  $('#delete', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Automation löschen', `„${automation.name}“ löschen? Laufende Serien werden beendet.`, { submitLabel: 'Löschen' }))) return;
    await del(`/automations/${id}`);
    dirty = false;
    toast('Automation gelöscht');
    navigate('#/automations');
  });

  renderSteps();
  const beforeUnload = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => window.removeEventListener('beforeunload', beforeUnload);
}
