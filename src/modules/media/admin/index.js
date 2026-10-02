// Admin-Oberfläche des Medien-Moduls
import { ApiError, del, get, put, session } from '/admin/js/api.js';
import { $, confirmDialog, debounce, fmtDateTime, fmtNum, html, modal, pager, setHtml, toast, toastError } from '/admin/js/ui.js';

const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,application/pdf,video/mp4,audio/mpeg';

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${fmtNum(Math.round(bytes / 102.4) / 10)} KB`;
  return `${fmtNum(Math.round(bytes / 104857.6) / 10)} MB`;
}

async function upload(file) {
  const headers = { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) };
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch('/api/media', { method: 'POST', headers, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, `${file.name}: ${data.error || `Fehler ${res.status}`}`);
  return data;
}

async function uploadAll(files) {
  const done = [];
  for (const file of files) {
    try {
      done.push(await upload(file));
    } catch (err) {
      toastError(err);
    }
  }
  if (done.length) toast(`${done.length} Datei(en) hochgeladen`);
  return done;
}

function thumb(m) {
  return m.is_image
    ? html`<img src="${m.url}" alt="${m.alt}" loading="lazy">`
    : html`<span class="file-ext">${m.path.split('.').pop()}</span>`;
}

function grid(items, selectedId) {
  return items.length
    ? html`<div class="media-grid">${items.map(
        (m) => html`<button type="button" class="media-item ${m.id === selectedId ? 'selected' : ''}" data-id="${m.id}" title="${m.original_name}">
          <div class="media-thumb">${thumb(m)}</div><div class="media-name">${m.original_name}</div></button>`,
      )}</div>`
    : html`<div class="empty">Keine Dateien gefunden.</div>`;
}

/** Drag & Drop + Dateiauswahl. */
function bindDropzone(zone, onFiles) {
  const input = $('input[type=file]', zone);
  $('[data-browse]', zone).addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
  });
}

const dropzoneHtml = html`<div class="dropzone" data-dropzone>
  <input type="file" multiple accept="${ACCEPT}" class="hidden">
  Dateien hierher ziehen oder <button type="button" class="linklike" data-browse>auswählen</button>
  <div class="small">JPG, PNG, GIF, WebP, PDF, MP4, MP3 · max. 20 MB</div>
</div>`;

function detailDialog(m, onChange) {
  const absolute = `${location.origin}${m.url}`;
  modal({
    title: m.original_name,
    wide: true,
    submitLabel: 'Speichern',
    body: html`<div class="grid grid-2">
      <div>${m.is_image ? html`<img src="${m.url}" alt="${m.alt}" style="max-width:100%;border-radius:8px;border:1px solid var(--border)">` : html`<div class="media-thumb" style="border-radius:8px">${thumb(m)}</div>`}</div>
      <div>
        <dl class="summary-list small" style="margin-bottom:16px">
          <dt>Typ</dt><dd>${m.mime}</dd>
          <dt>Größe</dt><dd>${fmtSize(m.size)}${m.width ? ` · ${m.width} × ${m.height} px` : ''}</dd>
          <dt>Hochgeladen</dt><dd>${fmtDateTime(m.created_at)}</dd>
          <dt>URL</dt><dd><a href="${m.url}" target="_blank" rel="noopener">${m.url}</a></dd>
        </dl>
        <div class="field"><label for="m-alt">Alternativtext</label><input id="m-alt" name="alt" type="text" value="${m.alt}"><div class="help">Beschreibt das Bild für Screenreader und Suchmaschinen.</div></div>
        <div class="field"><label for="m-title">Titel</label><input id="m-title" name="title" type="text" value="${m.title}"></div>
        <div class="toolbar"><button type="button" class="btn btn-sm" data-copy>URL kopieren</button><button type="button" class="btn btn-sm btn-ghost" data-delete style="color:var(--danger)">Löschen</button></div>
      </div>
    </div>`,
    onOpen: (d) => {
      $('[data-copy]', d).addEventListener('click', async () => {
        await navigator.clipboard?.writeText(absolute).catch(() => null);
        toast('URL kopiert');
      });
      $('[data-delete]', d).addEventListener('click', async () => {
        if (!(await confirmDialog('Datei löschen', `„${m.original_name}“ löschen? Inhalte, die sie verwenden, zeigen sie danach nicht mehr an.`, { submitLabel: 'Löschen' }))) return;
        await del(`/media/${m.id}`);
        toast('Datei gelöscht');
        d.close();
        d.remove();
        onChange();
      });
    },
    onSubmit: async (f) => {
      await put(`/media/${m.id}`, { alt: f.alt.value, title: f.title.value });
      toast('Gespeichert');
      onChange();
    },
  });
}

async function mediaView(el) {
  const state = { q: '', type: '', page: 1 };
  setHtml(
    el,
    html`<div class="page-head"><div><h1>Medien</h1><div class="sub">Bilder und Dateien für Seiten, Beiträge und Newsletter</div></div></div>
      <div class="card">
        ${dropzoneHtml}
        <div class="toolbar" style="margin-bottom:12px">
          <input type="search" id="q" placeholder="Suchen …" style="max-width:260px" aria-label="Suche">
          <select id="type" style="max-width:180px" aria-label="Typ"><option value="">Alle Dateien</option><option value="image">Bilder</option><option value="document">Dokumente &amp; Medien</option></select>
        </div>
        <div id="grid"></div>
      </div>`,
  );
  let items = [];
  const load = async () => {
    const qs = new URLSearchParams({ page: state.page, per_page: 40 });
    if (state.q) qs.set('q', state.q);
    if (state.type) qs.set('type', state.type);
    const data = await get(`/media?${qs}`);
    items = data.items;
    const box = $('#grid', el);
    setHtml(box, grid(items));
    box.append(pager(data, (p) => ((state.page = p), load())));
  };
  bindDropzone($('[data-dropzone]', el), async (files) => {
    await uploadAll(files);
    state.page = 1;
    load();
  });
  $('#grid', el).addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (item) detailDialog(items.find((m) => m.id === Number(item.dataset.id)), load);
  });
  $('#q', el).addEventListener('input', debounce((e) => ((state.q = e.target.value.trim()), (state.page = 1), load())));
  $('#type', el).addEventListener('change', (e) => ((state.type = e.target.value), (state.page = 1), load()));
  await load();
}

/** Auswahldialog für andere Module. Liefert die gewählte Datei oder null. */
function mediaPicker({ type = '' } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    let confirmed = false;
    let items = [];
    const state = { q: '', page: 1 };
    const { dialog } = modal({
      title: type === 'image' ? 'Bild auswählen' : 'Datei auswählen',
      wide: true,
      submitLabel: 'Übernehmen',
      body: html`${dropzoneHtml}<input type="search" data-q placeholder="Suchen …" style="margin-bottom:12px" aria-label="Suche"><div data-grid></div>`,
      onOpen: (d) => {
        const box = $('[data-grid]', d);
        const load = async () => {
          const qs = new URLSearchParams({ page: state.page, per_page: 24 });
          if (type) qs.set('type', type);
          if (state.q) qs.set('q', state.q);
          const data = await get(`/media?${qs}`);
          items = data.items;
          setHtml(box, grid(items, chosen?.id));
          box.append(pager(data, (p) => ((state.page = p), load())));
        };
        box.addEventListener('click', (e) => {
          const item = e.target.closest('[data-id]');
          if (!item) return;
          chosen = items.find((m) => m.id === Number(item.dataset.id));
          box.querySelectorAll('.media-item').forEach((b) => b.classList.toggle('selected', b === item));
        });
        box.addEventListener('dblclick', (e) => {
          if (e.target.closest('[data-id]')) $('button[type=submit]', d).click();
        });
        $('[data-q]', d).addEventListener('input', debounce((e) => ((state.q = e.target.value.trim()), (state.page = 1), load())));
        bindDropzone($('[data-dropzone]', d), async (files) => {
          const uploaded = await uploadAll(files);
          if (uploaded.length) chosen = uploaded[0];
          state.page = 1;
          load();
        });
        load();
      },
      onSubmit: () => {
        if (!chosen) throw new Error('Bitte eine Datei auswählen');
        confirmed = true;
      },
    });
    // Erst nach dem Schließen auflösen, damit der Aufrufer wieder Fokus setzen kann
    dialog.addEventListener('close', () => setTimeout(() => resolve(confirmed ? chosen : null), 0));
  });
}

export default function register(cms) {
  cms.nav({ href: '#/media', label: 'Medien', icon: 'media', group: 'Inhalte', order: 30 });
  cms.route(/^\/media$/, mediaView);
  cms.provide('mediaPicker', mediaPicker);
  cms.widget({
    id: 'media',
    size: 'tile',
    order: 30,
    render(el, data) {
      const m = data.media || { files: 0, bytes: 0 };
      setHtml(el, html`<div class="label">Medien</div><div class="value">${fmtNum(m.files)}</div><div class="hint">${fmtSize(m.bytes)} belegt · <a href="#/media">Hochladen</a></div>`);
    },
  });
}

