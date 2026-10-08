// Kleine UI-Hilfsfunktionen: sicheres HTML-Templating, Modale, Toasts, Formatierung.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}
/** Markiert einen String als vertrauenswürdiges HTML (wird nicht escaped). */
export const raw = (v) => new Raw(String(v ?? ''));

function render(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === false || value === null || value === undefined) return '';
  return esc(value);
}

/** Tagged Template: escaped alle Werte außer raw()/verschachtelte html``-Ergebnisse. */
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1];
  });
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Setzt Text, falls das Element (noch) existiert – z. B. nach einem Seitenwechsel. */
export function setText(node, text) {
  if (node) node.textContent = text;
}

export function setHtml(el, content) {
  el.innerHTML = render(content);
  return el;
}

// ---- Formatierung ----

const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const numFmt = new Intl.NumberFormat('de-DE');

export const fmtDate = (iso) => (iso ? dateFmt.format(new Date(iso)) : '–');
export const fmtDateTime = (iso) => (iso ? dateTimeFmt.format(new Date(iso)) : '–');
export const fmtNum = (n) => (n === null || n === undefined ? '–' : numFmt.format(n));
export const fmtPct = (n) => (n === null || n === undefined ? '–' : `${numFmt.format(n)} %`);

/** ISO-String → Wert für <input type="datetime-local"> in Ortszeit. */
export function toLocalInput(iso) {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const SUBSCRIBER_STATUS = {
  active: 'Aktiv',
  pending: 'Unbestätigt',
  unsubscribed: 'Abgemeldet',
  bounced: 'Bounce',
  complained: 'Beschwerde',
};

export const CAMPAIGN_STATUS = {
  draft: 'Entwurf',
  scheduled: 'Geplant',
  sending: 'Wird versendet',
  paused: 'Pausiert',
  sent: 'Versendet',
  cancelled: 'Abgebrochen',
};

export const RECIPIENT_STATUS = {
  queued: 'Wartend',
  held: 'Wartet auf A/B-Ergebnis',
  sent: 'Zugestellt',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
};

const BADGE_TONE = {
  active: 'good', sent: 'good', pending: 'warn', scheduled: 'info', sending: 'info', paused: 'warn',
  unsubscribed: 'muted', draft: 'muted', cancelled: 'muted', bounced: 'bad', complained: 'bad', failed: 'bad',
  queued: 'info', skipped: 'muted', held: 'warn',
};

export function badge(status, labels = {}) {
  return html`<span class="badge badge-${BADGE_TONE[status] || 'muted'}">${labels[status] || status}</span>`;
}

// ---- Toasts ----

export function toast(message, tone = 'ok') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.classList.add('hide'), 3500);
  setTimeout(() => el.remove(), 4000);
}

export function errorMessage(err) {
  if (err?.details && typeof err.details === 'object' && !Array.isArray(err.details)) {
    const parts = Object.entries(err.details)
      .filter(([k]) => k !== 'problems')
      .map(([k, v]) => `${k}: ${v}`);
    if (parts.length) return `${err.message} (${parts.join(', ')})`;
  }
  return err?.message || 'Unbekannter Fehler';
}

export const toastError = (err) => toast(errorMessage(err), 'error');

// ---- Modal ----

/**
 * Öffnet einen Dialog. `body` ist html``-Inhalt; `onSubmit(form)` wird beim Absenden
 * aufgerufen – gibt sie `false` zurück, bleibt der Dialog offen.
 */
export function modal({ title, body, submitLabel = 'Speichern', danger = false, wide = false, onSubmit, onOpen, cancelLabel = 'Abbrechen' }) {
  const dialog = document.createElement('dialog');
  dialog.className = wide ? 'modal wide' : 'modal';
  setHtml(
    dialog,
    html`<form method="dialog" novalidate>
      <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Schließen">✕</button></header>
      <div class="modal-body">${body}</div>
      <footer>
        <button type="button" class="btn" data-close>${cancelLabel}</button>
        ${onSubmit ? html`<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${submitLabel}</button>` : ''}
      </footer>
    </form>`,
  );
  document.body.append(dialog);
  const form = $('form', dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  $$('[data-close]', dialog).forEach((b) => b.addEventListener('click', close));
  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    if (!form.reportValidity()) return;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const result = await onSubmit(form);
      if (result !== false) close();
    } catch (err) {
      toastError(err);
    } finally {
      btn.disabled = false;
    }
  });
  dialog.showModal();
  onOpen?.(dialog);
  return { dialog, close };
}

export function confirmDialog(title, message, { submitLabel = 'Bestätigen', danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const { dialog } = modal({
      title,
      body: html`<p>${message}</p>`,
      submitLabel,
      danger,
      onSubmit: () => {
        done = true;
        resolve(true);
      },
    });
    dialog.addEventListener('close', () => !done && resolve(false));
  });
}

/** Liest Formularfelder als Objekt (Checkbox-Gruppen mit gleichem Namen → Array). */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    if (el.type === 'checkbox') {
      const group = form.querySelectorAll(`input[type=checkbox][name="${el.name}"]`);
      if (group.length > 1 || el.dataset.array !== undefined) {
        out[el.name] ??= [];
        if (el.checked) out[el.name].push(el.value);
      } else {
        out[el.name] = el.checked;
      }
    } else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else if (el.tagName === 'SELECT' && el.multiple) {
      out[el.name] = [...el.selectedOptions].map((o) => o.value);
    } else {
      out[el.name] = el.value;
    }
  }
  return out;
}

export function pager({ page, pages, total }, onPage) {
  const wrap = document.createElement('div');
  wrap.className = 'pager';
  setHtml(
    wrap,
    html`<span class="muted">${fmtNum(total)} Einträge · Seite ${page} von ${pages}</span>
      <button class="btn btn-sm" data-p="${page - 1}" ${page <= 1 ? raw('disabled') : ''}>‹ Zurück</button>
      <button class="btn btn-sm" data-p="${page + 1}" ${page >= pages ? raw('disabled') : ''}>Weiter ›</button>`,
  );
  $$('button', wrap).forEach((b) => b.addEventListener('click', () => onPage(Number(b.dataset.p))));
  return wrap;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function download(filename, content, type = 'text/plain') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
