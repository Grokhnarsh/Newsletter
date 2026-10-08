import { del, get, post, put } from '/admin/js/api.js';
import { ctx, navigate } from '/admin/js/state.js';
import { $, $$, confirmDialog, debounce, fmtDateTime, fmtNum, html, raw, setHtml, setText, toast, toastError } from '/admin/js/ui.js';

// Vergleiche je Feldtyp
const OPS = {
  text: [['equals', 'ist'], ['not_equals', 'ist nicht'], ['contains', 'enthält'], ['not_contains', 'enthält nicht'], ['starts_with', 'beginnt mit'], ['ends_with', 'endet auf'], ['empty', 'ist leer'], ['not_empty', 'ist nicht leer']],
  date: [['within_days', 'in den letzten … Tagen'], ['older_than_days', 'vor mehr als … Tagen'], ['after', 'ab Datum'], ['before', 'vor Datum']],
  list: [['in', 'ist in Liste'], ['not_in', 'ist nicht in Liste']],
  activity: [['within_days', 'in den letzten … Tagen'], ['not_within_days', 'nicht in den letzten … Tagen']],
  bool: [['is_true', 'erteilt'], ['is_false', 'nicht erteilt']],
};
OPS.attribute = OPS.text;
const NO_VALUE = new Set(['empty', 'not_empty', 'is_true', 'is_false']);
const DAY_OPS = new Set(['within_days', 'older_than_days', 'not_within_days']);

export async function segmentsView(el) {
  const segments = await get('/segments');
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Segmente</h1><div class="sub">Dynamische Zielgruppen nach Regeln – werden bei jedem Versand neu berechnet</div></div>
        <div class="toolbar"><a class="btn btn-primary" href="#/segments/new">+ Neues Segment</a></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Regeln</th><th class="right">Aktive Abonnenten</th><th>Geändert</th><th></th></tr></thead>
        <tbody>${
          segments.length
            ? segments.map(
                (s) => html`<tr class="clickable" data-id="${s.id}">
                  <td><strong>${s.name}</strong></td>
                  <td class="small">${s.rules.length} ${s.rules.length === 1 ? 'Regel' : 'Regeln'} · ${s.match === 'any' ? 'mindestens eine' : 'alle'} müssen zutreffen</td>
                  <td class="right num">${fmtNum(s.count)}</td>
                  <td class="small nowrap">${fmtDateTime(s.updated_at)}</td>
                  <td class="right"><button class="btn btn-sm btn-ghost" data-del="${s.id}" aria-label="Löschen">🗑</button></td></tr>`,
              )
            : html`<tr><td colspan="5" class="empty">Noch keine Segmente. Beispiel: alle aus Berlin, die in den letzten 90 Tagen geklickt haben. <a href="#/segments/new">Segment anlegen</a></td></tr>`
        }</tbody></table></div></div>`,
  );
  $('tbody', el).addEventListener('click', async (e) => {
    const d = e.target.closest('[data-del]');
    if (d) {
      e.stopPropagation();
      if (!(await confirmDialog('Segment löschen', 'Kampagnen mit diesem Segment verwenden danach nur noch ihre Listen.', { submitLabel: 'Löschen' }))) return;
      await del(`/segments/${d.dataset.del}`);
      toast('Segment gelöscht');
      return segmentsView(el);
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) navigate(`#/segments/${tr.dataset.id}`);
  });
}

export async function segmentEditorView(el, id) {
  const isNew = id === 'new';
  const [fields, lists, segment] = await Promise.all([
    get('/segments/fields'),
    ctx.getLists(true),
    isNew ? { name: '', match: 'all', rules: [{ field: 'attribute', key: '', op: 'equals', value: '' }] } : get(`/segments/${id}`),
  ]);
  const fieldType = Object.fromEntries(fields.map((f) => [f.key, f.type]));
  let rules = segment.rules.map((r) => ({ ...r }));

  const valueInput = (r, i) => {
    if (NO_VALUE.has(r.op)) return '';
    const type = fieldType[r.field];
    if (type === 'list') {
      return html`<select data-i="${i}" data-k="value" aria-label="Liste"><option value="">Liste wählen …</option>${lists.map(
        (l) => html`<option value="${l.id}" ${Number(r.value) === l.id ? raw('selected') : ''}>${l.name}</option>`,
      )}</select>`;
    }
    if (DAY_OPS.has(r.op)) return html`<input data-i="${i}" data-k="value" type="number" min="1" max="3650" value="${r.value || 30}" aria-label="Tage" style="flex:0 0 90px;width:90px">`;
    if (r.op === 'before' || r.op === 'after') return html`<input data-i="${i}" data-k="value" type="date" value="${r.value ? String(r.value).slice(0, 10) : ''}" aria-label="Datum">`;
    return html`<input data-i="${i}" data-k="value" type="text" value="${r.value ?? ''}" aria-label="Wert" placeholder="Wert" style="flex:1 1 140px;width:auto;min-width:0">`;
  };

  const renderRules = () => {
    setHtml(
      $('#rules', el),
      html`${rules.map(
        (r, i) => html`<div class="rule-row" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;padding:8px;border:1px solid var(--border);border-radius:8px">
          <select data-i="${i}" data-k="field" aria-label="Feld" style="flex:0 1 180px;width:auto">${fields.map((f) => html`<option value="${f.key}" ${r.field === f.key ? raw('selected') : ''}>${f.label}</option>`)}</select>
          ${fieldType[r.field] === 'attribute' ? html`<input data-i="${i}" data-k="key" type="text" value="${r.key || ''}" placeholder="Feldname, z. B. stadt" aria-label="Feldname" style="flex:0 1 160px;width:auto;min-width:0">` : ''}
          <select data-i="${i}" data-k="op" aria-label="Vergleich" style="flex:0 1 200px;width:auto">${OPS[fieldType[r.field]].map(([k, label]) => html`<option value="${k}" ${r.op === k ? raw('selected') : ''}>${label}</option>`)}</select>
          ${valueInput(r, i)}
          <button type="button" class="btn btn-sm btn-ghost" data-remove="${i}" aria-label="Regel entfernen">✕</button>
        </div>`,
      )}${rules.length ? '' : html`<p class="muted">Ohne Regeln umfasst das Segment alle aktiven Abonnenten.</p>`}`,
    );
  };

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/segments" class="small">‹ Segmente</a><h1>${isNew ? 'Neues Segment' : segment.name}</h1></div>
        <div class="toolbar"><button class="btn btn-primary" id="save">Speichern</button></div>
      </div>
      <div class="grid grid-2" style="grid-template-columns:2fr 1fr">
        <div class="card">
          <div class="field"><label for="sg-name">Name *</label><input id="sg-name" type="text" value="${segment.name}" required></div>
          <div class="field"><label for="sg-match">Abonnenten, bei denen</label><select id="sg-match" style="max-width:260px">
            <option value="all" ${segment.match === 'all' ? raw('selected') : ''}>alle Regeln zutreffen</option>
            <option value="any" ${segment.match === 'any' ? raw('selected') : ''}>mindestens eine Regel zutrifft</option>
          </select></div>
          <div id="rules"></div>
          <button type="button" class="btn btn-sm" id="add-rule">+ Regel</button>
          <p class="muted small" style="margin-top:12px">Eigene Felder stammen aus den Attributen der Abonnenten (z. B. aus dem CSV-Import oder Formularen). „Hat geöffnet/geklickt“ nutzt die Tracking-Daten.</p>
        </div>
        <div class="card"><h2>Treffer</h2><div class="value num" id="count" style="font-size:2rem;font-weight:700">–</div><div class="muted small">aktive Abonnenten</div>
          <ul id="sample" class="small" style="padding-left:18px;margin-top:12px"></ul></div>
      </div>`,
  );

  const refresh = debounce(async () => {
    try {
      const r = await post('/segments/preview', { match: $('#sg-match', el).value, rules });
      setText($('#count', el), fmtNum(r.count));
      setHtml($('#sample', el), html`${r.sample.map((s) => html`<li><a href="#/subscribers/${s.id}">${s.email}</a></li>`)}${r.count > r.sample.length ? html`<li class="muted">…</li>` : ''}`);
    } catch (err) {
      setText($('#count', el), '–');
      setHtml($('#sample', el), html`<li class="muted">${err.message}</li>`);
    }
  }, 300);

  const update = (e) => {
    const t = e.target;
    if (t.dataset.i === undefined) return;
    const r = rules[Number(t.dataset.i)];
    r[t.dataset.k] = t.value;
    if (t.dataset.k === 'field') {
      r.op = OPS[fieldType[r.field]][0][0];
      r.value = DAY_OPS.has(r.op) ? 30 : '';
      renderRules();
    } else if (t.dataset.k === 'op') {
      if (DAY_OPS.has(r.op) && !(Number(r.value) > 0)) r.value = 30;
      renderRules();
    }
    refresh();
  };
  $('#rules', el).addEventListener('change', update);
  $('#rules', el).addEventListener('input', (e) => e.target.tagName === 'INPUT' && update(e));
  $('#rules', el).addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    rules.splice(Number(b.dataset.remove), 1);
    renderRules();
    refresh();
  });
  $('#add-rule', el).addEventListener('click', () => {
    rules.push({ field: 'email', op: 'contains', value: '' });
    renderRules();
  });
  $('#sg-match', el).addEventListener('change', refresh);
  $('#save', el).addEventListener('click', async () => {
    const data = { name: $('#sg-name', el).value.trim(), match: $('#sg-match', el).value, rules };
    if (!data.name) return toastError(new Error('Bitte einen Namen angeben'));
    try {
      const saved = isNew ? await post('/segments', data) : await put(`/segments/${id}`, data);
      toast('Segment gespeichert');
      if (isNew) navigate(`#/segments/${saved.id}`);
      else rules = saved.rules.map((r) => ({ ...r }));
    } catch (err) {
      toastError(err);
    }
  });
  renderRules();
  refresh();
  $$('input', el)[0]?.focus();
}
