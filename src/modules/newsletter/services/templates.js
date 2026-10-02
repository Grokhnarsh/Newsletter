import { badRequest, notFound } from '../../../lib/errors.js';
import { CONTENT_TAG_RE, DEFAULT_LAYOUT } from '../../../lib/render.js';
import { now } from '../../../lib/time.js';

export class TemplateService {
  constructor(db) {
    this.db = db;
  }

  list() {
    return this.db.all(
      `SELECT t.id, t.name, t.created_at, t.updated_at,
         (SELECT COUNT(*) FROM campaigns c WHERE c.template_id = t.id) AS campaign_count
       FROM templates t ORDER BY t.name`,
    );
  }

  find(id) {
    const row = this.db.get('SELECT * FROM templates WHERE id = ?', id);
    if (!row) throw notFound('Vorlage nicht gefunden');
    return row;
  }

  findOptional(id) {
    return id ? this.db.get('SELECT * FROM templates WHERE id = ?', id) : undefined;
  }

  assertValid(html) {
    if (!CONTENT_TAG_RE.test(html)) throw badRequest('Die Vorlage muss den Platzhalter {{{content}}} enthalten');
  }

  create({ name, html }) {
    this.assertValid(html);
    const t = now();
    const { lastInsertRowid } = this.db.run('INSERT INTO templates (name, html, created_at, updated_at) VALUES (?, ?, ?, ?)', name, html, t, t);
    return this.find(lastInsertRowid);
  }

  update(id, { name, html }) {
    this.find(id);
    if (html !== undefined) this.assertValid(html);
    this.db.run('UPDATE templates SET name = COALESCE(?, name), html = COALESCE(?, html), updated_at = ? WHERE id = ?', name ?? null, html ?? null, now(), id);
    return this.find(id);
  }

  remove(id) {
    this.find(id);
    this.db.run('DELETE FROM templates WHERE id = ?', id);
  }

  duplicate(id) {
    const t = this.find(id);
    return this.create({ name: `${t.name} (Kopie)`, html: t.html });
  }

  seedDefault() {
    if (this.db.get('SELECT COUNT(*) AS n FROM templates').n === 0) {
      return this.create({ name: 'Standard', html: DEFAULT_LAYOUT });
    }
  }
}
