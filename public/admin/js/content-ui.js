// Gemeinsame Bausteine für Inhalts-Editoren (Seiten, Blog, …)
import { api, get, post } from './api.js';
import { registry } from './registry.js';
import { ctx } from './state.js';
import { $, confirmDialog, fmtDateTime, formData, html, modal, raw, toast, toastError } from './ui.js';

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

export function statusBadge(status, scheduled = false, reviewRequested = false) {
  if (scheduled) return html`<span class="badge badge-info">Geplant</span>`;
  if (status === 'draft' && reviewRequested) return html`<span class="badge badge-warn">Zur Prüfung</span>`;
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

/** Statusfeld: Autoren können nur Entwürfe speichern, die Redaktion veröffentlicht. */
export function statusField(item, { scheduledHint = '' } = {}) {
  if (ctx.isAuthor) {
    return html`<input type="hidden" name="status" value="draft">
      <p class="small">Status: <strong>Entwurf</strong></p>
      <p class="muted small">Wenn der Entwurf fertig ist, reiche ihn zur Prüfung ein – die Redaktion veröffentlicht ihn.</p>`;
  }
  return html`<div class="field"><label for="c-status">Status</label><select id="c-status" name="status">
      <option value="draft" ${item.status === 'draft' ? raw('selected') : ''}>Entwurf</option>
      <option value="published" ${item.status === 'published' ? raw('selected') : ''}>Veröffentlicht</option>
    </select>${scheduledHint ? html`<div class="help">${scheduledHint}</div>` : ''}</div>`;
}

/**
 * Hinweise zum Freigabe-Workflow oberhalb des Editors: schreibgeschützte Inhalte,
 * Rückmeldung der Redaktion an Autoren, eingereichte Entwürfe für die Redaktion.
 */
export function reviewNotice(item, isNew) {
  if (isNew) return '';
  if (!item.can_edit) {
    return html`<div class="callout">${
      item.status === 'published' ? 'Dieser Inhalt ist veröffentlicht. Änderungen nimmt die Redaktion vor.' : 'Dieser Entwurf gehört einer anderen Person und kann nur gelesen werden.'
    }</div>`;
  }
  if (item.status !== 'draft') return '';
  if (item.review_requested_at) {
    return ctx.isAuthor
      ? html`<div class="callout">Eingereicht am ${fmtDateTime(item.review_requested_at)} – die Redaktion prüft den Entwurf. Du kannst ihn bis dahin weiter bearbeiten.</div>`
      : html`<div class="callout warn" style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">
          <span>Zur Prüfung eingereicht am ${fmtDateTime(item.review_requested_at)}. Zum Freigeben den Status auf „Veröffentlicht“ setzen und speichern.</span>
          <button type="button" class="btn btn-sm" data-review-decline>Zur Überarbeitung zurückgeben …</button></div>`;
  }
  if (item.review_note && ctx.isAuthor) {
    return html`<div class="callout warn"><strong>Hinweis der Redaktion:</strong> <span style="white-space:pre-wrap">${item.review_note}</span></div>`;
  }
  return '';
}

/** Knopf „Zur Prüfung einreichen“ für Autoren (eigene, noch nicht eingereichte Entwürfe). */
export function submitButton(item, isNew) {
  if (!ctx.isAuthor || isNew || !item.can_edit || item.review_requested_at) return '';
  return html`<button class="btn" id="review-submit">Zur Prüfung einreichen</button>`;
}

/**
 * Verknüpft Einreichen und Zurückgeben. `save` speichert vorher ungesicherte Änderungen
 * (liefert false bei Fehlern), `reload` lädt die Ansicht neu.
 */
export function bindReview(root, base, { save, reload }) {
  $('#review-submit', root)?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      if ((await save()) === false) return;
      const r = await post(`${base}/submit`);
      toast(r.notified ? `Eingereicht – ${r.notified} Person(en) aus der Redaktion benachrichtigt` : 'Zur Prüfung eingereicht');
      reload();
    } catch (err) {
      toastError(err);
    } finally {
      e.target.disabled = false;
    }
  });
  $('[data-review-decline]', root)?.addEventListener('click', () => {
    modal({
      title: 'Zur Überarbeitung zurückgeben',
      submitLabel: 'Zurückgeben',
      body: html`<div class="field"><label for="review-note">Hinweis an die Autorin / den Autor</label>
        <textarea id="review-note" name="note" maxlength="2000" placeholder="Was soll noch geändert werden?"></textarea>
        <div class="help">Wird per E-Mail verschickt und im Editor angezeigt.</div></div>`,
      async onSubmit(form) {
        await post(`${base}/decline`, { note: formData(form).note });
        toast('Entwurf zurückgegeben');
        reload();
      },
    });
  });
}

/** Schaltet einen Editor auf „nur lesen“. */
export function makeReadOnly(root, form, editor) {
  form.querySelectorAll('input, select, textarea, button').forEach((c) => {
    c.disabled = true;
  });
  editor.setReadOnly();
  for (const sel of ['#save', '#delete', '[data-pick-cover]', '[data-clear-cover]', '[data-rev-restore]']) root.querySelectorAll(sel).forEach((b) => b.remove());
}

const LANGUAGE_NAMES = { de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano', nl: 'Nederlands', pl: 'Polski', pt: 'Português' };
export const languageName = (code) => LANGUAGE_NAMES[code] || String(code).toUpperCase();

/** Konfigurierte Sprachen der Website (erste = Standard). */
export async function siteLanguages() {
  const s = await ctx.getSettings();
  return String(s.site_languages || 'de').split(',').map((l) => l.trim()).filter(Boolean);
}

/** Kleines Sprachkürzel für Listen (nur bei mehrsprachigen Websites). */
export function langBadge(lang, langs) {
  return langs.length > 1 ? html`<span class="badge badge-muted" title="${languageName(lang)}">${String(lang || langs[0]).toUpperCase()}</span>` : '';
}

/** Seitenleiste „Sprache & Übersetzungen“ im Editor. */
export function languageCard(item, isNew, langs, editPrefix) {
  if (langs.length < 2) return '';
  const current = item.lang || langs[0];
  const translations = new Map((item.translations || []).filter((t) => t.id !== item.id).map((t) => [t.lang, t]));
  return html`<div class="card side-card">
    <h3>Sprache</h3>
    <div class="field"><label for="c-lang">Sprache dieses Inhalts</label><select id="c-lang" name="lang">${langs.map(
      (l) => html`<option value="${l}" ${l === current ? raw('selected') : ''}>${languageName(l)}</option>`,
    )}</select></div>
    ${
      isNew
        ? html`<p class="muted small">Übersetzungen kannst du nach dem ersten Speichern anlegen.</p>`
        : html`<div class="small">${langs
            .filter((l) => l !== current)
            .map((l) => {
              const t = translations.get(l);
              return html`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
                <span>${languageName(l)}</span>
                ${
                  t
                    ? html`<span><a href="#${editPrefix}/${t.id}">${t.title}</a> ${statusBadge(t.status)}</span>`
                    : html`<button type="button" class="btn btn-sm" data-translate="${l}">Übersetzung anlegen</button>`
                }</div>`;
            })}</div>`
    }
  </div>`;
}

/** „Übersetzung anlegen“: kopiert den Inhalt als Entwurf in die Zielsprache und öffnet ihn. */
export function bindTranslations(root, base, editPrefix, { save } = {}) {
  root.querySelectorAll('[data-translate]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        if (save && (await save()) === false) return;
        const created = await post(`${base}/translate`, { lang: b.dataset.translate });
        toast(`Übersetzung (${languageName(b.dataset.translate)}) als Entwurf angelegt – Inhalt jetzt übersetzen`);
        location.hash = `#${editPrefix}/${created.id}`;
      } catch (err) {
        toastError(err);
      } finally {
        b.disabled = false;
      }
    }),
  );
}
