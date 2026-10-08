// Admin-Oberfläche des Weiterleitungs-Moduls
import { del, get, post, put } from '/admin/js/api.js';
import { $, $$, confirmDialog, debounce, fmtDateTime, fmtNum, formData, html, modal, pager, raw, setHtml, toast, toastError } from '/admin/js/ui.js';

const CODE_LABELS = { 301: '301 dauerhaft', 302: '302 vorübergehend', 410: '410 entfernt' };

function redirectDialog(item, onSaved, preset = {}) {
  const r = item || { source: preset.source || '', target: '', code: 301, note: '' };
  modal({
    title: item ? 'Weiterleitung bearbeiten' : 'Neue Weiterleitung',
    body: html`
      <div class="field"><label for="r-src">Von (alte Adresse)</label><input id="r-src" name="source" type="text" required value="${r.source}" placeholder="/alte-seite">
        <div class="help">Mit <code>/*</code> am Ende werden alle Unterseiten weitergeleitet, z. B. <code>/alt/*</code> → <code>/neu/*</code>.</div></div>
      <div class="field" id="r-target-field"><label for="r-tgt">Nach (Ziel)</label><input id="r-tgt" name="target" type="text" value="${r.target}" placeholder="/neue-seite oder https://…"></div>
      <div class="field"><label for="r-code">Art</label><select id="r-code" name="code">${Object.entries(CODE_LABELS).map(
        ([k, v]) => html`<option value="${k}" ${String(r.code) === k ? raw('selected') : ''}>${v}</option>`,
      )}</select><div class="help">301 für dauerhaft umgezogene Inhalte (gut für Suchmaschinen), 410 für bewusst entfernte Seiten.</div></div>
      <div class="field"><label for="r-note">Notiz</label><input id="r-note" name="note" type="text" value="${r.note}"></div>`,
    onOpen: (d) => {
      const sync = () => $('#r-target-field', d).classList.toggle('hidden', $('#r-code', d).value === '410');
      $('#r-code', d).addEventListener('change', sync);
      sync();
    },
    onSubmit: async (f) => {
      const data = { ...formData(f), code: Number(f.code.value) };
      if (item) await put(`/redirects/${item.id}`, data);
      else await post('/redirects', data);
      toast('Weiterleitung gespeichert');
      onSaved();
    },
  });
}

async function redirectsView(el) {
  const state = { q: '', page: 1, tab: new URLSearchParams(location.hash.split('?')[1] || '').get('tab') || 'list' };
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Weiterleitungen</h1><div class="sub">Alte Adressen auf neue Inhalte umleiten – wird bei geänderten Seiten-Adressen automatisch gepflegt</div></div>
        <div class="toolbar"><button class="btn btn-primary" id="add">+ Weiterleitung</button></div>
      </div>
      <div class="tabs" role="tablist"><button data-tab="list">Weiterleitungen</button><button data-tab="misses">Nicht gefunden (404)</button></div>
      <div class="card" id="box"></div>`,
  );
  const box = $('#box', el);

  const loadList = async () => {
    const qs = new URLSearchParams({ page: state.page, per_page: 50 });
    if (state.q) qs.set('q', state.q);
    const data = await get(`/redirects?${qs}`);
    setHtml(
      box,
      html`<input type="search" id="q" value="${state.q}" placeholder="Suchen …" style="max-width:260px;margin-bottom:12px" aria-label="Suche">
      <div class="table-wrap"><table>
        <thead><tr><th>Von</th><th>Nach</th><th>Art</th><th class="right">Aufrufe</th><th></th></tr></thead>
        <tbody>${
          data.items.length
            ? data.items.map(
                (r) => html`<tr>
                  <td><code>${r.source}</code>${r.auto ? html` <span class="badge badge-info" title="Automatisch angelegt, als sich eine Adresse geändert hat">auto</span>` : ''}${r.note ? html`<div class="muted small">${r.note}</div>` : ''}</td>
                  <td style="overflow-wrap:anywhere">${r.code === 410 ? html`<span class="muted">–</span>` : html`<code>${r.target}</code>`}</td>
                  <td class="small nowrap">${CODE_LABELS[r.code]}</td>
                  <td class="right num">${fmtNum(r.hits)}<div class="muted small">${r.last_hit_at ? fmtDateTime(r.last_hit_at) : ''}</div></td>
                  <td class="right nowrap"><button class="btn btn-sm" data-edit="${r.id}">Bearbeiten</button><button class="btn btn-sm btn-ghost" data-del="${r.id}" aria-label="Löschen">🗑</button></td>
                </tr>`,
              )
            : html`<tr><td colspan="5" class="empty">Noch keine Weiterleitungen.</td></tr>`
        }</tbody></table></div>`,
    );
    box.append(pager(data, (p) => ((state.page = p), loadList())));
    $('#q', box).addEventListener('input', debounce((e) => ((state.q = e.target.value.trim()), (state.page = 1), loadList())));
    const byId = (id) => data.items.find((r) => r.id === Number(id));
    $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => redirectDialog(byId(b.dataset.edit), loadList)));
    $$('[data-del]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmDialog('Weiterleitung löschen', `${byId(b.dataset.del).source} löschen?`, { submitLabel: 'Löschen' }))) return;
        await del(`/redirects/${b.dataset.del}`);
        toast('Gelöscht');
        loadList();
      }),
    );
  };

  const loadMisses = async () => {
    const misses = await get('/redirects/misses');
    setHtml(
      box,
      html`<p class="muted small">Adressen, die Besucher aufgerufen haben, die es aber nicht gibt – z. B. alte Links von anderen Websites. Lege für häufige Treffer eine Weiterleitung an.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Adresse</th><th>Herkunft</th><th class="right">Aufrufe</th><th>Zuletzt</th><th></th></tr></thead>
        <tbody>${
          misses.length
            ? misses.map(
                (m) => html`<tr><td><code>${m.path}</code></td><td class="small muted" style="overflow-wrap:anywhere">${m.referrer || '–'}</td>
                  <td class="right num">${fmtNum(m.hits)}</td><td class="small nowrap">${fmtDateTime(m.last_seen)}</td>
                  <td class="right nowrap"><button class="btn btn-sm" data-create="${m.path}">Weiterleiten</button><button class="btn btn-sm btn-ghost" data-ignore="${m.path}">Ignorieren</button></td></tr>`,
              )
            : html`<tr><td colspan="5" class="empty">Keine fehlenden Seiten protokolliert. 🎉</td></tr>`
        }</tbody></table></div>`,
    );
    $$('[data-create]', box).forEach((b) => b.addEventListener('click', () => redirectDialog(null, loadMisses, { source: b.dataset.create })));
    $$('[data-ignore]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        await del(`/redirects/misses?path=${encodeURIComponent(b.dataset.ignore)}`);
        loadMisses();
      }),
    );
  };

  const show = () => {
    $$('[data-tab]', el).forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    (state.tab === 'misses' ? loadMisses : loadList)().catch(toastError);
  };
  $$('[data-tab]', el).forEach((b) => b.addEventListener('click', () => ((state.tab = b.dataset.tab), show())));
  $('#add', el).addEventListener('click', () => redirectDialog(null, show));
  show();
}

export default function register(cms) {
  cms.nav({ href: '#/redirects', label: 'Weiterleitungen', icon: 'redirects', group: 'Inhalte', order: 45 });
  cms.route(/^\/redirects$/, redirectsView);
  cms.widget({
    id: 'redirects',
    size: 'tile',
    order: 60,
    render(el, data) {
      const n = data.redirects?.misses ?? 0;
      setHtml(el, html`<div class="label">Nicht gefundene Seiten</div><div class="value">${fmtNum(n)}</div><div class="hint"><a href="#/redirects?tab=misses">Ansehen &amp; weiterleiten</a></div>`);
    },
  });
}
