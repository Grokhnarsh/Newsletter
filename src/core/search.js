import { escapeHtml } from '../lib/render.js';
import { now } from '../lib/time.js';
import { stripTags } from './content.js';

/**
 * Volltextsuche mit SQLite FTS5 (Relevanz nach BM25, Titel stärker gewichtet,
 * Umlaute/Akzente werden normalisiert). Module legen Dokumente über `index()` ab
 * und liefern für einen Neuaufbau ihre Dokumente über den Hook `search.documents`.
 */
export class SearchService {
  constructor({ db, hooks }) {
    this.db = db;
    this.hooks = hooks;
    this.types = new Map();
  }

  registerType(entity, label, module) {
    this.types.set(entity, { label, module });
  }

  index(entity, id, { title, html = '', text = '', url, published_at = null, lang = '' }) {
    this.db.transaction(() => {
      this.db.run('DELETE FROM search_index WHERE entity = ? AND entity_id = ?', entity, id);
      this.db.run(
        'INSERT INTO search_index (entity, entity_id, url, published_at, lang, title, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
        entity,
        id,
        url,
        published_at,
        lang,
        title,
        `${text} ${stripTags(html)}`.trim(),
      );
    });
  }

  remove(entity, id) {
    this.db.run('DELETE FROM search_index WHERE entity = ? AND entity_id = ?', entity, id);
  }

  /** Index komplett neu aus den Dokumenten aller aktiven Module aufbauen. */
  rebuild() {
    const docs = this.hooks.collect('search.documents');
    this.db.transaction(() => {
      this.db.run('DELETE FROM search_index');
      for (const d of docs) this.index(d.entity, d.id, d);
    });
    return docs.length;
  }

  isEmpty() {
    return !this.db.get('SELECT 1 FROM search_index LIMIT 1');
  }

  /** Suchanfrage → FTS5-Ausdruck: jedes Wort als Präfix, alle Wörter müssen vorkommen. */
  static toMatch(q) {
    const terms = String(q ?? '').match(/[\p{L}\p{N}]+/gu) || [];
    return terms
      .slice(0, 8)
      .map((t) => `"${t.replace(/"/g, '')}"*`)
      .join(' ');
  }

  query(q, { limit = 30, lang } = {}) {
    const match = SearchService.toMatch(q);
    if (!match) return [];
    const enabled = [...this.types.entries()].filter(([, t]) => !t.module || this.hooks.isEnabled(t.module)).map(([e]) => e);
    if (!enabled.length) return [];
    const rows = this.db.all(
      `SELECT entity, entity_id, url, title,
         snippet(search_index, 6, char(1), char(2), ' … ', 24) AS snippet,
         bm25(search_index, 0, 0, 0, 0, 0, 8.0, 1.0) AS score
       FROM search_index
       WHERE search_index MATCH ? AND (published_at IS NULL OR published_at <= ?)
         AND entity IN (${enabled.map(() => '?').join(',')}) ${lang ? 'AND (lang = ? OR lang = \'\')' : ''}
       ORDER BY score LIMIT ?`,
      match,
      now(),
      ...enabled,
      ...(lang ? [lang] : []),
      limit,
    );
    return rows.map((r) => ({
      type: this.types.get(r.entity)?.label || r.entity,
      title: r.title,
      url: r.url,
      // Treffer hervorheben – Text sicher escapen, nur die Markierungen als HTML
      excerptHtml: escapeHtml(r.snippet).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>'),
    }));
  }
}
