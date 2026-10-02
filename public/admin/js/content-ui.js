// Gemeinsame Bausteine für Inhalts-Editoren (Seiten, Blog, …)
import { api, get, post } from './api.js';
import { registry } from './registry.js';
import { $, confirmDialog, fmtDateTime, html, modal, raw, toast, toastError } from './ui.js';

export function slugify(value) {
  const map = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };
  return String(value || '')
    .replace(/[äöüßÄÖÜ]/g, (c) => map[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export const STATUS_LABELS = { draft: 'Entwurf', published: 'Veröffentlicht', scheduled: 'Geplant' };

export function statusBadge(status, scheduled = false) {
  if (scheduled) return html`<span class="badge badge-info">Geplant</span>`;
  return status === 'published' ? html`<span class="badge badge-good">Veröffentlicht</span>` : html`<span class="badge badge-muted">Entwurf</span>`;
}

/** Feld für ein Titelbild mit Medienauswahl. */
export function coverField(value) {
  const picker = Boolean(registry.services.mediaPicker);
  return html`<div class="field" data-cover>
    <label for="cover-url">Titelbild</label>
    <img class="cover-preview ${value ? '' : 'hidden'}" src="${value || ''}" alt="">
    <input id="cover-url" name="cover_url" type="text" value="${value || ''}" placeholder="/uploads/… oder https://…">
    <div class="toolbar" style="margin-top:6px">
      ${picker ? html`<button type="button" class="btn btn-sm" data-pick-cover>Aus Medien wählen</button>` : ''}
      <button type="button" class="btn btn-sm btn-ghost" data-clear-cover>Entfernen</button>
    </div>
  </div>`;
}

export function bindCover(root, onChange = () => {}) {
  const box = $('[data-cover]', root);
  const input = $('input', box);
  const img = $('img', box);
  const sync = () => {
    img.src = input.value;
    img.classList.toggle('hidden', !input.value);
    onChange();
  };
  input.addEventListener('change', sync);
  $('[data-pick-cover]', box)?.addEventListener('click', async () => {
    const media = await registry.services.mediaPicker({ type: 'image' });
    if (media) {
      input.value = media.url;
      sync();
    }
  });
  $('[data-clear-cover]', box).addEventListener('click', () => {
    input.value = '';
    sync();
  });
}

export function seoCard(data) {
  return html`<div class="card side-card">
    <h3>Suchmaschinen (SEO)</h3>
    <div class="field"><label for="seo-title">SEO-Titel</label><input id="seo-title" name="seo_title" type="text" maxlength="200" value="${data.seo_title || ''}" placeholder="Standard: Titel"></div>
    <div class="field"><label for="seo-desc">Meta-Beschreibung</label><textarea id="seo-desc" name="seo_description" maxlength="400" style="min-height:80px" placeholder="Kurzbeschreibung für Suchergebnisse (ca. 150 Zeichen)">${data.seo_description || ''}</textarea></div>
  </div>`;
}

/** Revisionsliste mit Vorschau und Wiederherstellen. */
export function revisionsCard(revisions) {
  if (!revisions?.length) return '';
  return html`<div class="card side-card">
    <h3>Revisionen</h3>
    <div class="small">${revisions.slice(0, 10).map(
      (r) => html`<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
        <span>${fmtDateTime(r.created_at)}<br><span class="muted">${r.author || '–'}</span></span>
        <span class="nowrap"><button type="button" class="btn btn-sm btn-ghost" data-rev-view="${r.id}">Ansehen</button><button type="button" class="btn btn-sm" data-rev-restore="${r.id}">Wiederherstellen</button></span>
      </div>`,
    )}</div>
  </div>`;
}

export function bindRevisions(root, base, onRestored) {
  root.querySelectorAll('[data-rev-view]').forEach((b) =>
    b.addEventListener('click', async () => {
      const rev = await get(`${base}/revisions/${b.dataset.revView}`);
      modal({
        title: `Revision: ${rev.title}`,
        wide: true,
        cancelLabel: 'Schließen',
        body: html`<p class="muted small">Gespeichert am ${fmtDateTime(rev.created_at)}</p><div class="rte-area" style="border:1px solid var(--border);border-radius:8px;min-height:0">${raw(rev.content)}</div>`,
      });
    }),
  );
  root.querySelectorAll('[data-rev-restore]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Revision wiederherstellen', 'Der aktuelle Stand wird als neue Revision gesichert und durch diese Version ersetzt.', { submitLabel: 'Wiederherstellen', danger: false }))) return;
      try {
        await post(`${base}/revisions/${b.dataset.revRestore}/restore`);
        toast('Revision wiederhergestellt');
        onRestored();
      } catch (err) {
        toastError(err);
      }
    }),
  );
}

/** Zeigt die Theme-Vorschau ungespeicherter Inhalte in einem Dialog. */
export async function openPreview(endpoint, data) {
  try {
    const res = await api(endpoint, { method: 'POST', body: data, raw: true });
    const markup = await res.text();
    modal({
      title: 'Vorschau',
      wide: true,
      cancelLabel: 'Schließen',
      body: html`<iframe class="preview-frame" sandbox="" title="Vorschau"></iframe>`,
      onOpen: (d) => {
        $('iframe', d).srcdoc = markup;
      },
    });
  } catch (err) {
    toastError(err);
  }
}
