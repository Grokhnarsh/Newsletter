// Admin-Oberfläche des Seiten-Moduls
import { del, get, post, put } from '/admin/js/api.js';
import {
  bindCover, bindReview, bindRevisions, bindTranslations, coverField, langBadge, languageCard, makeReadOnly, openPreview, reviewNotice, revisionsCard,
  seoCard, siteLanguages, slugify, statusBadge, statusField, submitButton,
} from '/admin/js/content-ui.js';
import { richEditor } from '/admin/js/editor.js';
import { ctx, navigate } from '/admin/js/state.js';
import { $, confirmDialog, fmtDateTime, fmtNum, formData, html, raw, setHtml, toast, toastError, setText } from '/admin/js/ui.js';

const TEMPLATES = { default: 'Standard', full: 'Volle Breite', landing: 'Landingpage (ohne Titel)' };

async function pagesView(el) {
  const [pages, langs] = await Promise.all([get('/pages'), siteLanguages()]);
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Seiten</h1><div class="sub">Statische Inhalte deiner Website, hierarchisch organisiert</div></div>
        <div class="toolbar"><a class="btn btn-primary" href="#/pages/new">+ Neue Seite</a></div>
      </div>
      ${!ctx.isAuthor && pages.some((p) => p.status === 'draft' && p.review_requested_at)
        ? html`<div class="callout warn">${pages.filter((p) => p.status === 'draft' && p.review_requested_at).length} Seite(n) warten auf deine Prüfung.</div>`
        : ''}
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Titel</th><th>Adresse</th><th>Status</th><th>Geändert</th><th></th></tr></thead>
        <tbody>${
          pages.length
            ? pages.map(
                (p) => html`<tr class="clickable" data-id="${p.id}">
                  <td><span class="tree-indent">${'— '.repeat(p.depth)}</span><strong>${p.title}</strong> ${langBadge(p.lang, langs)} ${p.is_home ? html`<span class="badge badge-info">Startseite</span>` : ''}</td>
                  <td class="small"><code>${p.url}</code></td>
                  <td>${statusBadge(p.status, false, Boolean(p.review_requested_at))}</td>
                  <td class="small nowrap">${fmtDateTime(p.updated_at)}<div class="muted">${p.author || ''}</div></td>
                  <td class="right nowrap">
                    ${p.status === 'published' ? html`<a class="btn btn-sm" href="${p.url}" target="_blank" rel="noopener">Ansehen ↗</a>` : ''}
                    ${p.can_edit ? html`<button class="btn btn-sm btn-ghost" data-del="${p.id}" aria-label="Löschen">🗑</button>` : ''}
                  </td>
                </tr>`,
              )
            : html`<tr><td colspan="5" class="empty">Noch keine Seiten. <a href="#/pages/new">Erste Seite anlegen</a></td></tr>`
        }</tbody>
      </table></div></div>`,
  );
  $('tbody', el).addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      e.stopPropagation();
      const page = pages.find((p) => p.id === Number(delBtn.dataset.del));
      if (!(await confirmDialog('Seite löschen', `„${page.title}“ löschen? Unterseiten rücken eine Ebene nach oben.`, { submitLabel: 'Löschen' }))) return;
      try {
        await del(`/pages/${page.id}`);
        toast('Seite gelöscht');
        pagesView(el);
      } catch (err) {
        toastError(err);
      }
      return;
    }
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) navigate(`#/pages/${tr.dataset.id}`);
  });
}

async function pageEditorView(el, id) {
  const isNew = id === 'new';
  const [page, all, langs] = await Promise.all([
    isNew ? Promise.resolve({ title: '', slug: '', content: '', status: 'draft', template: 'default', parent_id: null, position: 0, revisions: [] }) : get(`/pages/${id}`),
    get('/pages'),
    siteLanguages(),
  ]);
  // Mögliche Elternseiten: nicht die Seite selbst und nicht ihre Unterseiten
  const excluded = new Set();
  if (!isNew) {
    excluded.add(page.id);
    for (const p of all) if (p.parent_id && excluded.has(p.parent_id)) excluded.add(p.id);
  }
  const parents = all.filter((p) => !excluded.has(p.id));
  let slugTouched = !isNew;
  let dirty = false;

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/pages" class="small">‹ Seiten</a><h1>${isNew ? 'Neue Seite' : page.title}</h1>
          <div class="sub">${statusBadge(page.status, false, Boolean(page.review_requested_at))} ${page.is_home ? html`<span class="badge badge-info">Startseite</span>` : ''} <span id="dirty" class="muted small"></span></div></div>
        <div class="toolbar">
          <button class="btn" id="preview">Vorschau</button>
          ${!isNew && page.status === 'published' ? html`<a class="btn" href="${page.url}" target="_blank" rel="noopener">Ansehen ↗</a>` : ''}
          ${submitButton(page, isNew)}
          <button class="btn btn-primary" id="save">Speichern</button>
        </div>
      </div>
      ${reviewNotice(page, isNew)}
      <form id="page-form" class="content-editor" novalidate>
        <div class="stack">
          <div class="card">
            <input class="title-input" name="title" type="text" value="${page.title}" placeholder="Titel der Seite" aria-label="Titel" required>
            <div class="slug-line"><span>Adresse:</span><code id="slug-base"></code><input name="slug" type="text" value="${page.slug}" aria-label="Slug"></div>
            <div id="editor"></div>
          </div>
        </div>
        <div class="stack">
          <div class="card side-card">
            <h3>Veröffentlichung</h3>
            ${statusField(page)}
            ${page.published_at ? html`<p class="muted small">Erstmals veröffentlicht: ${fmtDateTime(page.published_at)}</p>` : ''}
            ${!isNew ? html`<button type="button" class="btn btn-sm btn-ghost" id="delete" style="color:var(--danger)">Seite löschen</button>` : ''}
          </div>
          ${languageCard(page, isNew, langs, '/pages')}
          <div class="card side-card">
            <h3>Seitenattribute</h3>
            <div class="field"><label for="p-parent">Übergeordnete Seite</label><select id="p-parent" name="parent_id">
              <option value="">– keine (oberste Ebene) –</option>
              ${parents.map((p) => html`<option value="${p.id}" data-path="${p.path}" ${page.parent_id === p.id ? raw('selected') : ''}>${'– '.repeat(p.depth)}${p.title}${langs.length > 1 ? ` (${String(p.lang).toUpperCase()})` : ''}</option>`)}
            </select></div>
            <div class="field"><label for="p-template">Vorlage</label><select id="p-template" name="template">
              ${Object.entries(TEMPLATES).map(([k, v]) => html`<option value="${k}" ${page.template === k ? raw('selected') : ''}>${v}</option>`)}
            </select></div>
            <div class="field"><label for="p-pos">Reihenfolge</label><input id="p-pos" name="position" type="number" min="0" value="${page.position}"></div>
          </div>
          <div class="card side-card">${coverField(page.cover_url)}</div>
          ${seoCard(page)}
          ${revisionsCard(page.revisions)}
        </div>
      </form>`,
  );

  const form = $('#page-form', el);
  const markDirty = () => {
    dirty = true;
    const d = $('#dirty', el);
    if (d) d.textContent = '· Ungespeicherte Änderungen';
  };
  let ready = false;
  const editor = richEditor($('#editor', el), { value: page.content, onChange: () => ready && markDirty() });
  ready = true;
  const updateBase = () => {
    const opt = form.parent_id.selectedOptions[0];
    setText($('#slug-base', el), `${opt?.dataset.path || ''}/`);
  };
  updateBase();
  form.addEventListener('input', (e) => {
    markDirty();
    if (e.target.name === 'title' && !slugTouched) form.slug.value = slugify(e.target.value);
    if (e.target.name === 'slug') slugTouched = true;
  });
  form.addEventListener('change', (e) => {
    markDirty();
    if (e.target.name === 'parent_id') updateBase();
  });
  bindCover(el, markDirty);

  const collect = () => {
    const d = formData(form);
    return {
      ...d,
      content: editor.getValue(),
      parent_id: d.parent_id ? Number(d.parent_id) : null,
      position: Number(d.position) || 0,
    };
  };

  // Speichert und liefert die gespeicherte Seite (oder false bei Fehlern)
  const save = async () => {
    const data = collect();
    if (!data.title.trim()) {
      toastError(new Error('Bitte einen Titel angeben'));
      return false;
    }
    try {
      const saved = isNew ? await post('/pages', data) : await put(`/pages/${id}`, data);
      dirty = false;
      return saved;
    } catch (err) {
      toastError(err);
      return false;
    }
  };
  $('#save', el)?.addEventListener('click', async () => {
    const saved = await save();
    if (!saved) return;
    toast('Seite gespeichert');
    if (isNew) navigate(`#/pages/${saved.id}`);
    else pageEditorView(el, id);
  });
  $('#preview', el).addEventListener('click', () => openPreview('/pages/preview', collect()));
  $('#delete', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Seite löschen', `„${page.title}“ endgültig löschen?`, { submitLabel: 'Löschen' }))) return;
    try {
      await del(`/pages/${id}`);
      dirty = false;
      toast('Seite gelöscht');
      navigate('#/pages');
    } catch (err) {
      toastError(err);
    }
  });
  if (!isNew) {
    bindRevisions(el, `/pages/${id}`, () => pageEditorView(el, id));
    bindReview(el, `/pages/${id}`, { save: () => (dirty ? save() : true), reload: () => pageEditorView(el, id) });
    bindTranslations(el, `/pages/${id}`, '/pages', { save: () => (dirty ? save() : true) });
    if (!page.can_edit) makeReadOnly(el, form, editor);
  }

  const beforeUnload = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => window.removeEventListener('beforeunload', beforeUnload);
}

export default function register(cms) {
  cms.nav({ href: '#/pages', label: 'Seiten', icon: 'pages', group: 'Inhalte', order: 10 });
  cms.route(/^\/pages$/, pagesView);
  cms.route(/^\/pages\/(new|\d+)$/, pageEditorView);
  cms.widget({
    id: 'pages',
    size: 'tile',
    order: 10,
    render(el, data) {
      const p = data.pages || {};
      setHtml(
        el,
        html`<div class="label">Seiten</div><div class="value">${fmtNum(p.total || 0)}</div>
          <div class="hint">${fmtNum(p.drafts || 0)} Entwürfe${p.review && !ctx.isAuthor ? html` · <a href="#/pages"><strong>${fmtNum(p.review)} zur Prüfung</strong></a>` : ''} · <a href="#/pages/new">Neue Seite</a></div>`,
      );
    },
  });
}
