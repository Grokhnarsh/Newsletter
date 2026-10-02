import { notFound } from '../lib/errors.js';
import { now } from '../lib/time.js';

const LIST_SELECT = `
  SELECT l.*,
    (SELECT COUNT(*) FROM subscriber_lists sl JOIN subscribers s ON s.id = sl.subscriber_id
      WHERE sl.list_id = l.id AND s.status = 'active') AS active_count,
    (SELECT COUNT(*) FROM subscriber_lists sl WHERE sl.list_id = l.id) AS total_count
  FROM lists l`;

function shape(row) {
  return row && { ...row, is_public: Boolean(row.is_public) };
}

export class ListService {
  constructor(db) {
    this.db = db;
  }

  list({ publicOnly = false } = {}) {
    const where = publicOnly ? ' WHERE l.is_public = 1' : '';
    return this.db.all(`${LIST_SELECT}${where} ORDER BY l.name`).map(shape);
  }

  find(id) {
    const row = this.db.get(`${LIST_SELECT} WHERE l.id = ?`, id);
    if (!row) throw notFound('Liste nicht gefunden');
    return shape(row);
  }

  create({ name, description = '', is_public = false }) {
    const t = now();
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO lists (name, description, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      name,
      description,
      is_public ? 1 : 0,
      t,
      t,
    );
    return this.find(lastInsertRowid);
  }

  update(id, data) {
    this.find(id);
    this.db.run(
      `UPDATE lists SET name = COALESCE(?, name), description = COALESCE(?, description),
         is_public = COALESCE(?, is_public), updated_at = ? WHERE id = ?`,
      data.name ?? null,
      data.description ?? null,
      data.is_public === undefined || data.is_public === null ? null : data.is_public ? 1 : 0,
      now(),
      id,
    );
    return this.find(id);
  }

  remove(id) {
    this.find(id);
    this.db.run('DELETE FROM lists WHERE id = ?', id);
  }

  /** Prüft, dass alle IDs existieren; wirft sonst 404. */
  assertExist(ids) {
    for (const id of ids) {
      if (!this.db.get('SELECT 1 FROM lists WHERE id = ?', id)) throw notFound(`Liste ${id} nicht gefunden`);
    }
  }
}
