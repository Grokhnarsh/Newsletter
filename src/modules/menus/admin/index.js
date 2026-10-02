// Admin-Oberfläche des Menü-Moduls
import { get, put } from '/admin/js/api.js';
import { $, formData, html, modal, raw, setHtml, toast, toastError } from '/admin/js/ui.js';

let cmsRef = null;
const TYPE_LABELS = { home: 'Startseite', blog: 'Blog-Übersicht', page: 'Seite', custom: 'Eigener Link' };

/** Baum → flache Liste mit Ebene (0/1) und zurück. */
const flatten = (items) => items.flatMap((i) => [{ ...i, depth: 0 }, ...(i.children || []).map((c) => ({ ...c, depth: 1 }))]);
function toTree(flat) {
  const tree = [];
  for (const item of flat) {
    const clean = { label: item.label, type: item.type, url: item.url, target_id: item.target_id, new_tab: item.new_tab, children: [] };
    if (item.depth === 1 && tree.length) tree[tree.length - 1].children.push(clean);
    else tree.push(clean);
  }
  return tree;
}

function itemDialog(item, pages, onSave) {
  const types = Object.entries(TYPE_LABELS).filter(([k]) => (k === 'page' ? pages : k !== 'blog' || cmsRef.isEnabled('blog')));
  modal({
    title: item ? 'Menüeintrag bearbeiten' : 'Menüeintrag hinzufügen',
    body: html`
      <div class="field"><label for="mi-type">Art</label><select id="mi-type" name="type">${types.map(
        ([k, v]) => html`<option value="${k}" ${(item?.type || 'page') === k ? raw('selected') : ''}>${v}</option>`,
      )}</select></div>
      ${pages ? html`<div class="field" data-for="page"><label for="mi-page">Seite</label><select id="mi-page" name="target_id">${pages.map(
        (p) => html`<option value="${p.id}" ${item?.target_id === p.id ? raw('selected') : ''}>${'– '.repeat(p.depth)}${p.title}${p.status !== 'published' ? ' (Entwurf)' : ''}</option>`,
      )}</select></div>` : ''}
      <div class="field" data-for="custom"><label for="mi-url">Adresse</label><input id="mi-url" name="url" type="text" value="${item?.url || ''}" placeholder="https://… oder /pfad"></div>
      <div class="field"><label for="mi-label">Beschriftung *</label><input id="mi-label" name="label" type="text" required value="${item?.label || ''}"></div>
      <label class="checkline"><input type="checkbox" name="new_tab" ${item?.new_tab ? raw('checked') : ''}> In neuem Tab öffnen</label>`,
    onOpen: (d) => {
      const typeSel = $('[name=type]', d);
      const sync = () => d.querySelectorAll('[data-for]').forEach((f) => f.classList.toggle('hidden', f.dataset.for !== typeSel.value));
      typeSel.addEventListener('change', () => {
        sync();
        const label = $('[name=label]', d);
        if (!label.value && typeSel.value !== 'custom' && typeSel.value !== 'page') label.value = TYPE_LABELS[typeSel.value].replace('-Übersicht', '');
      });
      $('[name=target_id]', d)?.addEventListener('change', (e) => {
        const label = $('[name=label]', d);
        if (!label.value) label.value = e.target.selectedOptions[0].textContent.replace(/^(– )+/, '').replace(' (Entwurf)', '');
      });
      sync();
    },
    onSubmit: (f) => {
      const d = formData(f);
      const out = { label: d.label.trim(), type: d.type, new_tab: d.new_tab, url: d.type === 'custom' ? d.url.trim() : '', target_id: d.type === 'page' ? Number(d.target_id) : null };
      if (out.type === 'custom' && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(out.url)) throw new Error('Bitte eine gültige Adresse angeben');
      onSave(out);
    },
  });
}

async function menusView(el) {
  const [menus, pages] = await Promise.all([get('/menus'), cmsRef.isEnabled('pages') ? get('/pages') : Promise.resolve(null)]);
  const pageTitle = (id) => pages?.find((p) => p.id === id)?.title || `Seite #${id} (fehlt)`;
  const state = Object.fromEntries(menus.map((m) => [m.location, flatten(m.items)]));

  setHtml(
    el,
    html`<div class="page-head"><div><h1>Menüs</h1><div class="sub">Navigation im Kopf- und Fußbereich der Website</div></div></div>
      <div class="grid grid-2">${menus.map(
        (m) => html`<div class="card" data-menu="${m.location}">
          <div class="card-head"><h2>${m.label}</h2><button class="btn btn-sm" data-add>+ Eintrag</button></div>
          <ul class="menu-items" data-list></ul>
          <div class="toolbar" style="margin-top:12px"><button class="btn btn-primary" data-save>Speichern</button><span class="muted small" data-dirty></span></div>
        </div>`,
      )}</div>
      <p class="muted small" style="margin-top:12px">Einträge mit → eine Ebene einrücken (Untermenü). Entwürfe und gelöschte Seiten werden auf der Website automatisch ausgeblendet.</p>`,
  );

  const renderList = (location) => {
    const card = el.querySelector(`[data-menu="${location}"]`);
    const items = state[location];
    setHtml(
      $('[data-list]', card),
      items.length
        ? items.map(
            (item, i) => html`<li class="menu-item ${item.depth ? 'child' : ''}" data-i="${i}">
              <div class="grow"><strong>${item.label}</strong><small>${TYPE_LABELS[item.type] || item.type}${
                item.type === 'page' ? `: ${pageTitle(item.target_id)}` : item.type === 'custom' ? `: ${item.url}` : ''
              }${item.new_tab ? ' · neuer Tab' : ''}</small></div>
              <button class="icon-btn" data-act="up" title="Nach oben" ${i === 0 ? raw('disabled') : ''}>↑</button>
              <button class="icon-btn" data-act="down" title="Nach unten" ${i === items.length - 1 ? raw('disabled') : ''}>↓</button>
              ${item.depth ? html`<button class="icon-btn" data-act="out" title="Ausrücken">←</button>` : html`<button class="icon-btn" data-act="in" title="Einrücken" ${i === 0 ? raw('disabled') : ''}>→</button>`}
              <button class="icon-btn" data-act="edit" title="Bearbeiten">✎</button>
              <button class="icon-btn" data-act="del" title="Entfernen">✕</button>
            </li>`,
          )
        : html`<li class="empty">Noch keine Einträge.</li>`,
    );
  };
  const markDirty = (location) => {
    el.querySelector(`[data-menu="${location}"] [data-dirty]`).textContent = 'Ungespeicherte Änderungen';
  };

  for (const m of menus) {
    const card = el.querySelector(`[data-menu="${m.location}"]`);
    renderList(m.location);
    $('[data-add]', card).addEventListener('click', () =>
      itemDialog(null, pages, (item) => {
        state[m.location].push({ ...item, depth: 0 });
        renderList(m.location);
        markDirty(m.location);
      }),
    );
    $('[data-list]', card).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const items = state[m.location];
      const i = Number(btn.closest('[data-i]').dataset.i);
      const act = btn.dataset.act;
      if (act === 'up' && i > 0) [items[i - 1], items[i]] = [items[i], items[i - 1]];
      else if (act === 'down' && i < items.length - 1) [items[i + 1], items[i]] = [items[i], items[i + 1]];
      else if (act === 'in' && i > 0) items[i].depth = 1;
      else if (act === 'out') items[i].depth = 0;
      else if (act === 'del') items.splice(i, 1);
      else if (act === 'edit') {
        return itemDialog(items[i], pages, (updated) => {
          items[i] = { ...updated, depth: items[i].depth };
          renderList(m.location);
          markDirty(m.location);
        });
      }
      if (items[0]) items[0].depth = 0;
      renderList(m.location);
      markDirty(m.location);
    });
    $('[data-save]', card).addEventListener('click', async () => {
      try {
        const saved = await put(`/menus/${m.location}`, { items: toTree(state[m.location]) });
        state[m.location] = flatten(saved);
        renderList(m.location);
        el.querySelector(`[data-menu="${m.location}"] [data-dirty]`).textContent = '';
        toast('Menü gespeichert');
      } catch (err) {
        toastError(err);
      }
    });
  }
}

export default function register(cms) {
  cmsRef = cms;
  cms.nav({ href: '#/menus', label: 'Menüs', icon: 'menus', group: 'Inhalte', order: 40 });
  cms.route(/^\/menus$/, menusView);
}
