import { get } from './api.js';
import { registry } from './registry.js';
import { $, esc, html, modal, setHtml } from './ui.js';

const KEEP_ATTRS = { a: ['href', 'target'], img: ['src', 'alt', 'width', 'height'], iframe: ['src', 'width', 'height', 'allowfullscreen'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] };
const UNWRAP = new Set(['SPAN', 'FONT', 'O:P', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN']);
const DROP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'XML', 'BUTTON', 'INPUT', 'FORM', 'SELECT', 'TEXTAREA']);

/** Bereinigt eingefügtes HTML (z. B. aus Word oder Webseiten). */
function cleanPasted(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (DROP.has(child.tagName)) {
        child.remove();
        continue;
      }
      walk(child);
      const keep = KEEP_ATTRS[child.tagName.toLowerCase()] || [];
      for (const attr of [...child.attributes]) if (!keep.includes(attr.name)) child.removeAttribute(attr.name);
      if (UNWRAP.has(child.tagName)) child.replaceWith(...child.childNodes);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
}

function youtubeEmbed(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  const v = url.match(/vimeo\.com\/(\d+)/);
  if (v) return `https://player.vimeo.com/video/${v[1]}`;
  return null;
}

/**
 * Einfacher WYSIWYG-Editor mit HTML-Quelltextansicht.
 * Rückgabe: { getValue(), setValue(html) }
 */
export function richEditor(container, { value = '', onChange = () => {} } = {}) {
  setHtml(
    container,
    html`<div class="rte">
      <div class="rte-toolbar" role="toolbar" aria-label="Formatierung">
        <select data-block aria-label="Absatzformat">
          <option value="p">Absatz</option><option value="h2">Überschrift 2</option><option value="h3">Überschrift 3</option>
          <option value="h4">Überschrift 4</option><option value="blockquote">Zitat</option><option value="pre">Code</option>
        </select>
        <span class="sep"></span>
        <button type="button" data-cmd="bold" title="Fett (Strg+B)"><strong>F</strong></button>
        <button type="button" data-cmd="italic" title="Kursiv (Strg+I)"><em>K</em></button>
        <button type="button" data-cmd="underline" title="Unterstrichen"><u>U</u></button>
        <button type="button" data-cmd="strikeThrough" title="Durchgestrichen"><s>S</s></button>
        <span class="sep"></span>
        <button type="button" data-cmd="insertUnorderedList" title="Aufzählung">• Liste</button>
        <button type="button" data-cmd="insertOrderedList" title="Nummerierung">1. Liste</button>
        <button type="button" data-cmd="justifyCenter" title="Zentrieren">≡</button>
        <span class="sep"></span>
        <button type="button" data-act="link" title="Link einfügen">Link</button>
        <button type="button" data-cmd="unlink" title="Link entfernen">Link ✕</button>
        <button type="button" data-act="image" title="Bild einfügen">Bild</button>
        <button type="button" data-act="video" title="YouTube/Vimeo einbetten">Video</button>
        <button type="button" data-act="table" title="Tabelle einfügen">Tabelle</button>
        <button type="button" data-act="hr" title="Trennlinie">―</button>
        <select data-shortcode aria-label="Shortcode einfügen"><option value="">Baustein …</option></select>
        <span class="sep"></span>
        <button type="button" data-cmd="removeFormat" title="Formatierung entfernen">⌫ Format</button>
        <button type="button" data-cmd="undo" title="Rückgängig">↶</button>
        <button type="button" data-cmd="redo" title="Wiederholen">↷</button>
        <button type="button" data-act="source" title="HTML-Quelltext">&lt;/&gt;</button>
      </div>
      <div class="rte-area" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Inhalt"></div>
      <textarea class="rte-source code hidden" spellcheck="false" aria-label="HTML-Quelltext"></textarea>
      <div class="rte-status"><span data-words></span><span>Strg+B/I · Bausteine wie [newsletter_form] werden auf der Website ersetzt</span></div>
    </div>`,
  );

  const area = $('.rte-area', container);
  const source = $('.rte-source', container);
  const words = $('[data-words]', container);
  let sourceMode = false;
  let savedRange = null;
  area.innerHTML = value;
  document.execCommand('defaultParagraphSeparator', false, 'p');

  const getValue = () => (sourceMode ? source.value : area.innerHTML).replace(/<p><br><\/p>$/, '').trim();
  const changed = () => {
    const text = (sourceMode ? source.value.replace(/<[^>]+>/g, ' ') : area.innerText).trim();
    words.textContent = `${text ? text.split(/\s+/).length : 0} Wörter`;
    onChange(getValue());
  };
  changed();

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && area.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    area.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  };
  // Einfügen erst, wenn offene Dialoge geschlossen sind (sonst ist der Editor inaktiv)
  const insertHtml = (markup) =>
    setTimeout(() => {
      if (sourceMode) {
        source.setRangeText(markup, source.selectionStart, source.selectionEnd, 'end');
        return changed();
      }
      restoreSelection();
      document.execCommand('insertHTML', false, markup);
      changed();
    }, 0);

  area.addEventListener('input', changed);
  area.addEventListener('keyup', saveSelection);
  area.addEventListener('mouseup', saveSelection);
  area.addEventListener('blur', saveSelection);
  source.addEventListener('input', changed);
  area.addEventListener('paste', (e) => {
    const data = e.clipboardData;
    const htmlData = data?.getData('text/html');
    if (!htmlData) return;
    e.preventDefault();
    document.execCommand('insertHTML', false, cleanPasted(htmlData));
  });

  const toolbar = $('.rte-toolbar', container);
  // Fokus im Editor halten, wenn Schaltflächen geklickt werden
  toolbar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.cmd) {
      if (sourceMode) return;
      area.focus();
      document.execCommand(btn.dataset.cmd, false, null);
      changed();
      return;
    }
    actions[btn.dataset.act]?.();
  });
  $('[data-block]', container).addEventListener('change', (e) => {
    restoreSelection();
    document.execCommand('formatBlock', false, e.target.value);
    e.target.value = 'p';
    changed();
  });

  const scSelect = $('[data-shortcode]', container);
  get('/system/shortcodes')
    .then((list) => {
      scSelect.insertAdjacentHTML('beforeend', list.map((s) => `<option value="${esc(s.example)}">${esc(s.description || s.name)}</option>`).join(''));
    })
    .catch(() => scSelect.remove());
  scSelect.addEventListener('change', () => {
    if (scSelect.value) insertHtml(`<p>${esc(scSelect.value)}</p>`);
    scSelect.value = '';
  });

  const actions = {
    link() {
      saveSelection();
      const selected = window.getSelection().toString();
      modal({
        title: 'Link einfügen',
        submitLabel: 'Einfügen',
        body: html`<div class="field"><label for="l-url">Adresse</label><input id="l-url" name="url" type="text" required placeholder="https://… oder /seite"></div>
          <div class="field"><label for="l-text">Text</label><input id="l-text" name="text" type="text" value="${selected}"></div>
          <label class="checkline"><input type="checkbox" name="blank"> In neuem Tab öffnen</label>`,
        onSubmit: (f) => {
          const url = f.url.value.trim();
          if (!/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(url)) throw new Error('Bitte eine gültige Adresse angeben (https://…, /pfad, mailto:)');
          insertHtml(`<a href="${esc(url)}"${f.blank.checked ? ' target="_blank"' : ''}>${esc(f.text.value || url)}</a>`);
        },
      });
    },
    async image() {
      saveSelection();
      const picker = registry.services.mediaPicker;
      if (picker) {
        const media = await picker({ type: 'image' });
        if (media) insertHtml(`<figure><img src="${esc(media.url)}" alt="${esc(media.alt)}"${media.width ? ` width="${media.width}" height="${media.height}"` : ''}></figure><p></p>`);
        return;
      }
      modal({
        title: 'Bild einfügen',
        submitLabel: 'Einfügen',
        body: html`<div class="field"><label for="i-url">Bild-URL</label><input id="i-url" name="url" type="url" required></div>
          <div class="field"><label for="i-alt">Alternativtext</label><input id="i-alt" name="alt" type="text"></div>`,
        onSubmit: (f) => insertHtml(`<figure><img src="${esc(f.url.value)}" alt="${esc(f.alt.value)}"></figure><p></p>`),
      });
    },
    video() {
      saveSelection();
      modal({
        title: 'Video einbetten',
        submitLabel: 'Einbetten',
        body: html`<div class="field"><label for="v-url">YouTube- oder Vimeo-Adresse</label><input id="v-url" name="url" type="url" required placeholder="https://www.youtube.com/watch?v=…"></div>
          <p class="muted small">YouTube-Videos werden datenschutzfreundlich über youtube-nocookie.com eingebunden.</p>`,
        onSubmit: (f) => {
          const src = youtubeEmbed(f.url.value);
          if (!src) throw new Error('Keine gültige YouTube- oder Vimeo-Adresse');
          insertHtml(`<p><iframe src="${esc(src)}" width="560" height="315" allowfullscreen title="Video"></iframe></p><p></p>`);
        },
      });
    },
    table() {
      saveSelection();
      modal({
        title: 'Tabelle einfügen',
        submitLabel: 'Einfügen',
        body: html`<div class="inline-fields"><div class="field"><label for="t-r">Zeilen</label><input id="t-r" name="rows" type="number" min="1" max="30" value="3"></div>
          <div class="field"><label for="t-c">Spalten</label><input id="t-c" name="cols" type="number" min="1" max="10" value="3"></div></div>`,
        onSubmit: (f) => {
          const rows = Math.min(30, Number(f.rows.value) || 3);
          const cols = Math.min(10, Number(f.cols.value) || 3);
          const head = `<tr>${'<th>Überschrift</th>'.repeat(cols)}</tr>`;
          const body = `<tr>${'<td>&nbsp;</td>'.repeat(cols)}</tr>`.repeat(Math.max(1, rows - 1));
          insertHtml(`<table><thead>${head}</thead><tbody>${body}</tbody></table><p></p>`);
        },
      });
    },
    hr() {
      insertHtml('<hr><p></p>');
    },
    source() {
      sourceMode = !sourceMode;
      if (sourceMode) source.value = area.innerHTML;
      else area.innerHTML = source.value;
      area.classList.toggle('hidden', sourceMode);
      source.classList.toggle('hidden', !sourceMode);
      toolbar.querySelectorAll('[data-cmd], [data-block]').forEach((b) => (b.disabled = sourceMode));
      $('[data-act="source"]', container).classList.toggle('on', sourceMode);
      changed();
    },
  };

  return {
    getValue,
    /** Nur lesen (z. B. fremde Inhalte für Autoren). */
    setReadOnly() {
      area.contentEditable = 'false';
      source.readOnly = true;
      container.querySelectorAll('.rte-toolbar button, .rte-toolbar select').forEach((c) => {
        c.disabled = true;
      });
    },
    setValue(v) {
      if (sourceMode) source.value = v;
      else area.innerHTML = v;
      changed();
    },
  };
}
