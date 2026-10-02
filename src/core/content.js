import sanitizeHtml from 'sanitize-html';
import { notFound } from '../lib/errors.js';
import { escapeHtml } from '../lib/render.js';
import { now } from '../lib/time.js';

const SANITIZE_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'blockquote', 'pre', 'code',
    'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small', 'span', 'div',
    'a', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'img', 'figure', 'figcaption', 'picture', 'source', 'video', 'audio',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'iframe', 'details', 'summary',
  ],
  allowedAttributes: {
    '*': ['class', 'id', 'style', 'title', 'lang'],
    a: ['href', 'target', 'rel', 'name'],
    img: ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading'],
    source: ['src', 'srcset', 'type', 'media'],
    video: ['src', 'controls', 'poster', 'width', 'height', 'muted', 'loop', 'playsinline'],
    audio: ['src', 'controls'],
    iframe: ['src', 'width', 'height', 'allow', 'allowfullscreen', 'loading', 'title'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    ol: ['start', 'type'],
  },
  allowedStyles: {
    '*': {
      'text-align': [/^(left|right|center|justify)$/],
      width: [/^\d+(px|%)$/],
      'max-width': [/^\d+(px|%)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesAppliedToAttributes: ['href', 'src', 'srcset', 'poster'],
  allowProtocolRelative: false,
  allowedIframeHostnames: ['www.youtube-nocookie.com', 'www.youtube.com', 'player.vimeo.com'],
  transformTags: {
    a: (tagName, attribs) => {
      if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer';
      return { tagName, attribs };
    },
  },
};

/** Entfernt Skripte, Event-Handler und gefährliche URLs aus Redakteurs-HTML. */
export function sanitizeContent(html) {
  return sanitizeHtml(String(html ?? ''), SANITIZE_OPTIONS);
}

const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'ae', Ö: 'oe', Ü: 'ue' };

export function slugify(value) {
  return String(value ?? '')
    .replace(/[äöüßÄÖÜ]/g, (c) => UMLAUTS[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function stripTags(html) {
  return String(html ?? '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\[[a-z][a-z0-9_]*(?:\s[^\]]*)?\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function excerpt(html, length = 200) {
  const text = stripTags(html);
  if (text.length <= length) return text;
  return text.slice(0, length).replace(/\s+\S*$/, '') + ' …';
}

const SHORTCODE_RE = /(<p>\s*)?\[([a-z][a-z0-9_]*)((?:\s+[a-z_]+=(?:"[^"]*"|'[^']*'|[^\s\]]+))*)\s*\](\s*<\/p>)?/gi;
const ATTR_RE = /([a-z_]+)=(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/gi;

/**
 * true, wenn `pos` im normalen Text steht – nicht innerhalb eines Tags (z. B. in einem
 * Attributwert) und nicht in <code>/<pre>, wo Shortcodes als Beispiel stehen können.
 */
function isTextPosition(html, pos) {
  const before = html.slice(0, pos);
  if (before.lastIndexOf('<') > before.lastIndexOf('>')) return false;
  for (const tag of ['code', 'pre']) {
    const opened = (before.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
    const closed = (before.match(new RegExp(`</${tag}\\s*>`, 'gi')) || []).length;
    if (opened > closed) return false;
  }
  return true;
}

/**
 * Shortcodes wie `[newsletter_form]` oder `[recent_posts limit="3"]`, die Module
 * registrieren. Die Ausgabe eines Shortcodes gilt als vertrauenswürdiges HTML.
 */
export class ContentService {
  constructor({ db, hooks, isEnabled }) {
    this.db = db;
    this.hooks = hooks;
    this.isEnabled = isEnabled;
    this.shortcodes = new Map();
  }

  registerShortcode(name, render, { module = 'core', description = '', example } = {}) {
    this.shortcodes.set(name, { render, module, description, example: example || `[${name}]` });
  }

  listShortcodes() {
    return [...this.shortcodes.entries()]
      .filter(([, s]) => this.isEnabled(s.module))
      .map(([name, s]) => ({ name, module: s.module, description: s.description, example: s.example }));
  }

  /** Wandelt gespeichertes (bereits bereinigtes) HTML in die Ausgabe für die Website um. */
  render(html, req, depth = 0) {
    const source = String(html ?? '');
    return source.replace(SHORTCODE_RE, (match, pOpen, name, rawAttrs, pClose, offset) => {
      const sc = this.shortcodes.get(name.toLowerCase());
      if (!sc || depth > 2) return match;
      if (!isTextPosition(source, offset + (pOpen?.length || 0))) return match;
      // Shortcodes deaktivierter Module verschwinden aus der Ausgabe
      if (!this.isEnabled(sc.module)) return pOpen && pClose ? '' : (pOpen || '') + (pClose || '');
      const attrs = {};
      for (const m of rawAttrs.matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
      try {
        const out = sc.render(attrs, req) ?? '';
        // <p>[shortcode]</p> → Blockausgabe ohne umschließenden Absatz
        if (pOpen && pClose) return out;
        return (pOpen || '') + out + (pClose || '');
      } catch (err) {
        return `<!-- Shortcode ${escapeHtml(name)}: ${escapeHtml(err.message)} -->`;
      }
    });
  }

  // ---- Revisionen ----

  saveRevision(entity, entityId, { title, content, data = {} }, userId) {
    this.db.run(
      'INSERT INTO content_revisions (entity, entity_id, title, content, data, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      entity,
      entityId,
      title,
      content,
      JSON.stringify(data),
      userId ?? null,
      now(),
    );
    // Nur die letzten 30 Revisionen behalten
    this.db.run(
      `DELETE FROM content_revisions WHERE entity = ? AND entity_id = ? AND id NOT IN (
         SELECT id FROM content_revisions WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 30)`,
      entity,
      entityId,
      entity,
      entityId,
    );
  }

  revisions(entity, entityId) {
    return this.db.all(
      `SELECT r.id, r.title, r.created_at, u.email AS author FROM content_revisions r
       LEFT JOIN users u ON u.id = r.created_by WHERE r.entity = ? AND r.entity_id = ? ORDER BY r.id DESC`,
      entity,
      entityId,
    );
  }

  revision(entity, entityId, revisionId) {
    const row = this.db.get('SELECT * FROM content_revisions WHERE id = ? AND entity = ? AND entity_id = ?', revisionId, entity, entityId);
    if (!row) throw notFound('Revision nicht gefunden');
    return { ...row, data: JSON.parse(row.data) };
  }

  deleteRevisions(entity, entityId) {
    this.db.run('DELETE FROM content_revisions WHERE entity = ? AND entity_id = ?', entity, entityId);
  }
}
