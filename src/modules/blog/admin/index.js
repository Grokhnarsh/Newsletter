// Admin-Oberfläche des Blog-Moduls
import { del, get, post, put } from '/admin/js/api.js';
import { bindCover, bindRevisions, coverField, openPreview, revisionsCard, seoCard, slugify, statusBadge } from '/admin/js/content-ui.js';
import { richEditor } from '/admin/js/editor.js';
import { saveSettings } from '/admin/js/settings.js';
import { ctx, navigate } from '/admin/js/state.js';
import {
  $, confirmDialog, debounce, fmtDateTime, fmtNum, formData, html, modal, pager, raw, setHtml, toLocalInput, toast, toastError, setText,
} from '/admin/js/ui.js';

let cmsRef = null;

async function postsView(el) {
  const state = { q: '', status: '', category_id: '', page: 1 };
  const categories = await get('/categories');
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Beiträge</h1><div class="sub">Blog-Artikel schreiben, planen und veröffentlichen</div></div>
        <div class="toolbar"><a class="btn" href="#/categories">Kategorien</a><a class="btn btn-primary" href="#/posts/new">+ Neuer Beitrag</a></div>
      </div>
      <div class="card">
        <div class="toolbar" style="margin-bottom:12px">
          <input type="search" id="q" placeholder="Suchen …" style="max-width:260px" aria-label="Suche">
          <select id="status" style="max-width:180px" aria-label="Status"><option value="">Alle</option><option value="published">Veröffentlicht</option><option value="scheduled">Geplant</option><option value="draft">Entwürfe</option></select>
          <select id="cat" style="max-width:200px" aria-label="Kategorie"><option value="">Alle Kategorien</option>${categories.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select>
        </div>
        <div id="rows"></div>
      </div>`,
  );
  const load = async () => {
    const qs = new URLSearchParams({ page: state.page, per_page: 20 });
    for (const k of ['q', 'status', 'category_id']) if (state[k]) qs.set(k, state[k]);
    const data = await get(`/posts?${qs}`);
    const box = $('#rows', el);
    setHtml(
      box,
      html`<div class="table-wrap"><table>
        <thead><tr><th>Titel</th><th>Kategorien</th><th>Status</th><th>Datum</th><th></th></tr></thead>
        <tbody>${
          data.items.length
            ? data.items.map(
                (p) => html`<tr class="clickable" data-id="${p.id}">
                  <td><strong>${p.title}</strong><div class="muted small">/blog/${p.slug}</div></td>
                  <td>${p.categories.map((c) => html`<span class="chip">${c.name}</span>`)}</td>
                  <td>${statusBadge(p.status, p.scheduled)}</td>
                  <td class="small nowrap">${fmtDateTime(p.published_at || p.updated_at)}<div class="muted">${p.author || ''}</div></td>
                  <td class="right">${p.status === 'published' && !p.scheduled ? html`<a class="btn btn-sm" href="/blog/${p.slug}" target="_blank" rel="noopener">Ansehen ↗</a>` : ''}</td>
                </tr>`,
              )
            : html`<tr><td colspan="5" class="empty">Keine Beiträge gefunden.</td></tr>`
        }</tbody></table></div>`,
    );
    box.append(
      pager(data, (p) => {
        state.page = p;
        load();
      }),
    );
    box.querySelectorAll('tr[data-id]').forEach((tr) =>
      tr.addEventListener('click', (e) => {
        if (!e.target.closest('a')) navigate(`#/posts/${tr.dataset.id}`);
      }),
    );
  };
  $('#q', el).addEventListener('input', debounce((e) => ((state.q = e.target.value.trim()), (state.page = 1), load())));
  $('#status', el).addEventListener('change', (e) => ((state.status = e.target.value), (state.page = 1), load()));
  $('#cat', el).addEventListener('change', (e) => ((state.category_id = e.target.value), (state.page = 1), load()));
  await load();
}

async function postEditorView(el, id) {
  const isNew = id === 'new';
  const [post0, categories] = await Promise.all([
    isNew ? Promise.resolve({ title: '', slug: '', excerpt: '', content: '', status: 'draft', category_ids: [], revisions: [] }) : get(`/posts/${id}`),
    get('/categories'),
  ]);
  const p = post0;
  const scheduled = p.status === 'published' && p.published_at && new Date(p.published_at) > new Date();
  let slugTouched = !isNew;
  let dirty = false;
  const newsletter = cmsRef?.isEnabled('newsletter');

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/posts" class="small">‹ Beiträge</a><h1>${isNew ? 'Neuer Beitrag' : p.title}</h1>
          <div class="sub">${statusBadge(p.status, scheduled)} <span id="dirty" class="muted small"></span></div></div>
        <div class="toolbar">
          <button class="btn" id="preview">Vorschau</button>
          ${!isNew && p.status === 'published' && !scheduled ? html`<a class="btn" href="/blog/${p.slug}" target="_blank" rel="noopener">Ansehen ↗</a>` : ''}
          <button class="btn btn-primary" id="save">Speichern</button>
        </div>
      </div>
      <form id="post-form" class="content-editor" novalidate>
        <div class="stack">
          <div class="card">
            <input class="title-input" name="title" type="text" value="${p.title}" placeholder="Titel des Beitrags" aria-label="Titel" required>
            <div class="slug-line"><span>Adresse:</span><code>/blog/</code><input name="slug" type="text" value="${p.slug}" aria-label="Slug"></div>
            <div class="field"><label for="b-excerpt">Kurzfassung (Teaser)</label><textarea id="b-excerpt" name="excerpt" style="min-height:70px" maxlength="1000" placeholder="Erscheint in Übersichten, im RSS-Feed und im Newsletter">${p.excerpt}</textarea></div>
            <div id="editor"></div>
          </div>
        </div>
        <div class="stack">
          <div class="card side-card">
            <h3>Veröffentlichung</h3>
            <div class="field"><label for="b-status">Status</label><select id="b-status" name="status">
              <option value="draft" ${p.status === 'draft' ? raw('selected') : ''}>Entwurf</option>
              <option value="published" ${p.status === 'published' ? raw('selected') : ''}>Veröffentlicht</option>
            </select></div>
            <div class="field"><label for="b-date">Veröffentlichungsdatum</label><input id="b-date" name="published_at" type="datetime-local" value="${p.published_at ? toLocalInput(p.published_at) : ''}">
              <div class="help">Ein Datum in der Zukunft plant den Beitrag. Leer = beim Veröffentlichen.</div></div>
            ${!isNew ? html`<button type="button" class="btn btn-sm btn-ghost" id="delete" style="color:var(--danger)">Beitrag löschen</button>` : ''}
          </div>
          <div class="card side-card">
            <h3>Kategorien</h3>
            ${
              categories.length
                ? html`<div class="checks">${categories.map(
                    (c) => html`<label class="checkline"><input type="checkbox" name="category_ids" data-array value="${c.id}" ${p.category_ids.includes(c.id) ? raw('checked') : ''}> ${c.name}</label>`,
                  )}</div>`
                : html`<p class="muted small">Noch keine Kategorien. <a href="#/categories">Anlegen</a></p>`
            }
          </div>
          <div class="card side-card">${coverField(p.cover_url)}</div>
          ${seoCard(p)}
          ${
            newsletter && !isNew
              ? html`<div class="card side-card"><h3>Newsletter</h3><p class="muted small">Erstellt einen Kampagnenentwurf mit Teaser, Titelbild und Link zum Beitrag.</p>
                  <button type="button" class="btn btn-sm" id="to-newsletter">Als Newsletter-Entwurf anlegen</button></div>`
              : ''
          }
          ${revisionsCard(p.revisions)}
        </div>
      </form>`,
  );

  const form = $('#post-form', el);
  const markDirty = () => {
    dirty = true;
    setText($('#dirty', el), '· Ungespeicherte Änderungen');
  };
  let ready = false;
  const editor = richEditor($('#editor', el), { value: p.content, onChange: () => ready && markDirty() });
  ready = true;
  form.addEventListener('input', (e) => {
    markDirty();
    if (e.target.name === 'title' && !slugTouched) form.slug.value = slugify(e.target.value);
    if (e.target.name === 'slug') slugTouched = true;
  });
  form.addEventListener('change', markDirty);
  bindCover(el, markDirty);

  const collect = () => {
    const d = formData(form);
    return {
      ...d,
      content: editor.getValue(),
      category_ids: (d.category_ids || []).map(Number),
      published_at: d.published_at ? new Date(d.published_at).toISOString() : null,
    };
  };

  $('#save', el).addEventListener('click', async () => {
    const data = collect();
    if (!data.title.trim()) return toastError(new Error('Bitte einen Titel angeben'));
    try {
      const saved = isNew ? await post('/posts', data) : await put(`/posts/${id}`, data);
      dirty = false;
      toast('Beitrag gespeichert');
      if (isNew) navigate(`#/posts/${saved.id}`);
      else postEditorView(el, id);
    } catch (err) {
      toastError(err);
    }
  });
  $('#preview', el).addEventListener('click', () => {
    const d = collect();
    openPreview('/posts/preview', { ...d, published_at: d.published_at || undefined });
  });
  $('#delete', el)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Beitrag löschen', `„${p.title}“ endgültig löschen?`, { submitLabel: 'Löschen' }))) return;
    await del(`/posts/${id}`);
    dirty = false;
    toast('Beitrag gelöscht');
    navigate('#/posts');
  });
  $('#to-newsletter', el)?.addEventListener('click', async () => {
    try {
      if (dirty) return toastError(new Error('Bitte den Beitrag zuerst speichern'));
      const campaign = await post(`/campaigns/from-post/${id}`);
      toast('Kampagnenentwurf angelegt');
      navigate(`#/campaigns/${campaign.id}`);
    } catch (err) {
      toastError(err);
    }
  });
  if (!isNew) bindRevisions(el, `/posts/${id}`, () => postEditorView(el, id));

  const beforeUnload = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  return () => window.removeEventListener('beforeunload', beforeUnload);
}

async function categoriesView(el) {
  const cats = await get('/categories');
  const dialog = (cat) =>
    modal({
      title: cat ? 'Kategorie bearbeiten' : 'Neue Kategorie',
      body: html`<div class="field"><label for="c-name">Name *</label><input id="c-name" name="name" type="text" required value="${cat?.name || ''}"></div>
        <div class="field"><label for="c-slug">Slug</label><input id="c-slug" name="slug" type="text" value="${cat?.slug || ''}" placeholder="automatisch"></div>
        <div class="field"><label for="c-desc">Beschreibung</label><textarea id="c-desc" name="description" style="min-height:70px">${cat?.description || ''}</textarea></div>`,
      onSubmit: async (f) => {
        const data = formData(f);
        if (cat) await put(`/categories/${cat.id}`, data);
        else await post('/categories', data);
        toast('Kategorie gespeichert');
        categoriesView(el);
      },
    });
  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/posts" class="small">‹ Beiträge</a><h1>Kategorien</h1></div>
        <div class="toolbar"><button class="btn btn-primary" id="add">+ Neue Kategorie</button></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Adresse</th><th class="right">Beiträge</th><th></th></tr></thead>
        <tbody>${
          cats.length
            ? cats.map(
                (c) => html`<tr><td><strong>${c.name}</strong>${c.description ? html`<div class="muted small">${c.description}</div>` : ''}</td>
                  <td class="small"><code>/blog/kategorie/${c.slug}</code></td><td class="right num">${fmtNum(c.post_count)}</td>
                  <td class="right nowrap"><button class="btn btn-sm" data-edit="${c.id}">Bearbeiten</button><button class="btn btn-sm btn-ghost" data-del="${c.id}" aria-label="Löschen">🗑</button></td></tr>`,
              )
            : html`<tr><td colspan="4" class="empty">Noch keine Kategorien.</td></tr>`
        }</tbody>
      </table></div></div>`,
  );
  $('#add', el).addEventListener('click', () => dialog(null));
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => dialog(cats.find((c) => c.id === Number(b.dataset.edit)))));
  el.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Kategorie löschen', 'Kategorie löschen? Die Beiträge bleiben erhalten.', { submitLabel: 'Löschen' }))) return;
      await del(`/categories/${b.dataset.del}`);
      toast('Kategorie gelöscht');
      categoriesView(el);
    }),
  );
}

async function blogSettingsTab(box) {
  const s = await ctx.getSettings(true);
  const disabled = ctx.isAdmin ? '' : raw('disabled');
  setHtml(
    box,
    html`<form id="blog-settings" class="card">
      <h2>Blog</h2>
      <div class="field"><label for="bs-title">Titel der Blogübersicht</label><input id="bs-title" name="blog_title" type="text" value="${s.blog_title}" ${disabled}></div>
      <div class="field"><label for="bs-intro">Einleitungstext</label><textarea id="bs-intro" name="blog_intro" style="min-height:70px" ${disabled}>${s.blog_intro}</textarea></div>
      <div class="field"><label for="bs-pp">Beiträge pro Seite</label><input id="bs-pp" name="blog_posts_per_page" type="number" min="1" max="100" value="${s.blog_posts_per_page}" ${disabled}></div>
      <label class="checkline"><input type="checkbox" name="blog_on_home" ${s.blog_on_home ? raw('checked') : ''} ${disabled}> Neueste Beiträge auf der Startseite zeigen, wenn keine Startseite festgelegt ist</label>
      <p class="muted small">RSS-Feed: <a href="/blog/feed.xml" target="_blank" rel="noopener">/blog/feed.xml</a> · Baustein für Seiten: <code>[recent_posts limit="3"]</code></p>
      ${ctx.isAdmin ? html`<button class="btn btn-primary" type="submit">Speichern</button>` : ''}
    </form>`,
  );
  $('#blog-settings', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    d.blog_posts_per_page = Number(d.blog_posts_per_page);
    try {
      await saveSettings(d);
    } catch (err) {
      toastError(err);
    }
  });
}

export default function register(cms) {
  cmsRef = cms;
  cms.nav({ href: '#/posts', label: 'Blog', icon: 'blog', group: 'Inhalte', order: 20 });
  cms.route(/^\/posts$/, postsView);
  cms.route(/^\/posts\/(new|\d+)$/, postEditorView);
  cms.route(/^\/categories$/, categoriesView);
  cms.settingsTab({ id: 'blog', label: 'Blog', order: 30, render: blogSettingsTab });
  cms.widget({
    id: 'blog',
    size: 'tile',
    order: 20,
    render(el, data) {
      const b = data.blog || {};
      setHtml(
        el,
        html`<div class="label">Blogbeiträge</div><div class="value">${fmtNum(b.total || 0)}</div>
          <div class="hint">${fmtNum(b.drafts || 0)} Entwürfe · ${fmtNum(b.scheduled || 0)} geplant · <a href="#/posts/new">Neuer Beitrag</a></div>`,
      );
    },
  });
}
