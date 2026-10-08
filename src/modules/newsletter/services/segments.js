import { badRequest, notFound } from '../../../lib/errors.js';
import { now } from '../../../lib/time.js';

const TEXT_OPS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'empty', 'not_empty'];
const DATE_OPS = ['within_days', 'older_than_days', 'before', 'after'];

/** Felder für Segment-Regeln. */
export const SEGMENT_FIELDS = {
  email: { label: 'E-Mail', type: 'text', column: 's.email' },
  first_name: { label: 'Vorname', type: 'text', column: 's.first_name' },
  last_name: { label: 'Nachname', type: 'text', column: 's.last_name' },
  source: { label: 'Quelle', type: 'text', column: 's.source' },
  attribute: { label: 'Eigenes Feld', type: 'attribute' },
  created_at: { label: 'Eingetragen', type: 'date', column: 's.created_at' },
  confirmed_at: { label: 'Bestätigt', type: 'date', column: 's.confirmed_at' },
  list: { label: 'Liste', type: 'list' },
  opened: { label: 'Hat geöffnet', type: 'activity', event: 'open' },
  clicked: { label: 'Hat geklickt', type: 'activity', event: 'click' },
  tracking_consent: { label: 'Tracking-Einwilligung', type: 'bool', column: 's.tracking_consent' },
};

const OPS = {
  text: TEXT_OPS,
  attribute: TEXT_OPS,
  date: DATE_OPS,
  list: ['in', 'not_in'],
  activity: ['within_days', 'not_within_days'],
  bool: ['is_true', 'is_false'],
};

const likeEscape = (v) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`);
const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString();

function textCondition(expr, op, value) {
  const v = String(value ?? '');
  switch (op) {
    case 'equals':
      return [`lower(COALESCE(${expr}, '')) = lower(?)`, [v]];
    case 'not_equals':
      return [`lower(COALESCE(${expr}, '')) != lower(?)`, [v]];
    case 'contains':
      return [`COALESCE(${expr}, '') LIKE ? ESCAPE '\\'`, [`%${likeEscape(v)}%`]];
    case 'not_contains':
      return [`COALESCE(${expr}, '') NOT LIKE ? ESCAPE '\\'`, [`%${likeEscape(v)}%`]];
    case 'starts_with':
      return [`COALESCE(${expr}, '') LIKE ? ESCAPE '\\'`, [`${likeEscape(v)}%`]];
    case 'ends_with':
      return [`COALESCE(${expr}, '') LIKE ? ESCAPE '\\'`, [`%${likeEscape(v)}`]];
    case 'empty':
      return [`COALESCE(${expr}, '') = ''`, []];
    default:
      return [`COALESCE(${expr}, '') != ''`, []];
  }
}

/** Prüft und normalisiert eine Regel; wirft bei ungültigen Angaben. */
export function normalizeRule(rule, index = 0) {
  const where = `Regel ${index + 1}`;
  if (!rule || typeof rule !== 'object') throw badRequest(`${where}: ungültig`);
  const field = SEGMENT_FIELDS[rule.field];
  if (!field) throw badRequest(`${where}: unbekanntes Feld „${rule.field}“`);
  const op = String(rule.op || '');
  if (!OPS[field.type].includes(op)) throw badRequest(`${where}: Vergleich „${op}“ passt nicht zu „${field.label}“`);
  const out = { field: rule.field, op };
  if (field.type === 'attribute') {
    const key = String(rule.key || '').trim();
    if (!/^[\w.-]{1,50}$/.test(key)) throw badRequest(`${where}: ungültiger Feldname`);
    out.key = key;
  }
  const needsValue = !['empty', 'not_empty', 'is_true', 'is_false'].includes(op);
  if (needsValue) {
    if (['within_days', 'older_than_days', 'not_within_days'].includes(op)) {
      const n = Number(rule.value);
      if (!Number.isInteger(n) || n < 1 || n > 3650) throw badRequest(`${where}: Anzahl Tage zwischen 1 und 3650 angeben`);
      out.value = n;
    } else if (op === 'before' || op === 'after') {
      if (Number.isNaN(new Date(rule.value).getTime())) throw badRequest(`${where}: ungültiges Datum`);
      out.value = new Date(rule.value).toISOString();
    } else if (field.type === 'list') {
      const id = Number(rule.value);
      if (!Number.isInteger(id) || id < 1) throw badRequest(`${where}: Liste auswählen`);
      out.value = id;
    } else {
      out.value = String(rule.value ?? '').slice(0, 200);
    }
  }
  return out;
}

/** Übersetzt eine (normalisierte) Regel in eine SQL-Bedingung über `subscribers s`. */
function ruleSql(rule) {
  const field = SEGMENT_FIELDS[rule.field];
  switch (field.type) {
    case 'text':
      return textCondition(field.column, rule.op, rule.value);
    case 'attribute':
      // Schlüssel ist durch normalizeRule auf [\w.-] beschränkt (kein Ausbruch aus dem JSON-Pfad möglich)
      if (!/^[\w.-]{1,50}$/.test(rule.key)) throw badRequest('Ungültiger Feldname');
      return textCondition(`json_extract(s.attributes, '$."${rule.key}"')`, rule.op, rule.value);
    case 'date':
      if (rule.op === 'within_days') return [`${field.column} >= ?`, [daysAgo(rule.value)]];
      if (rule.op === 'older_than_days') return [`${field.column} < ?`, [daysAgo(rule.value)]];
      return [`${field.column} ${rule.op === 'before' ? '<' : '>='} ?`, [rule.value]];
    case 'list':
      return [
        `${rule.op === 'not_in' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM subscriber_lists sl WHERE sl.subscriber_id = s.id AND sl.list_id = ?)`,
        [rule.value],
      ];
    case 'activity':
      return [
        `${rule.op === 'not_within_days' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM events e WHERE e.subscriber_id = s.id AND e.type = '${field.event}' AND e.created_at >= ?)`,
        [daysAgo(rule.value)],
      ];
    default:
      return [`${field.column} = ${rule.op === 'is_true' ? 1 : 0}`, []];
  }
}

/** SQL-Bedingung für Regeln (alle / mindestens eine). Ohne Regeln: alle. */
export function compileRules(rules, match = 'all') {
  if (!rules.length) return { sql: '1 = 1', params: [] };
  const parts = rules.map(ruleSql);
  return { sql: `(${parts.map(([sql]) => sql).join(match === 'any' ? ' OR ' : ' AND ')})`, params: parts.flatMap(([, p]) => p) };
}

/** Regelbasierte, dynamische Zielgruppen: werden bei jedem Versand neu ausgewertet. */
export class SegmentService {
  constructor(db) {
    this.db = db;
  }

  shape(row) {
    return row && { ...row, rules: JSON.parse(row.rules) };
  }

  list() {
    return this.db.all('SELECT * FROM segments ORDER BY name').map((r) => {
      const s = this.shape(r);
      return { ...s, count: this.count(s) };
    });
  }

  find(id) {
    const row = this.db.get('SELECT * FROM segments WHERE id = ?', id);
    if (!row) throw notFound('Segment nicht gefunden');
    return this.shape(row);
  }

  normalize({ name, match = 'all', rules = [] }) {
    if (!Array.isArray(rules)) throw badRequest('rules muss eine Liste sein');
    if (rules.length > 20) throw badRequest('Höchstens 20 Regeln pro Segment');
    if (!['all', 'any'].includes(match)) throw badRequest('match muss „all“ oder „any“ sein');
    return { name, match, rules: rules.map(normalizeRule) };
  }

  create(data) {
    const d = this.normalize(data);
    const t = now();
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO segments (name, match, rules, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      d.name, d.match, JSON.stringify(d.rules), t, t,
    );
    return this.find(lastInsertRowid);
  }

  update(id, data) {
    const existing = this.find(id);
    const d = this.normalize({ ...existing, ...data });
    this.db.run('UPDATE segments SET name = ?, match = ?, rules = ?, updated_at = ? WHERE id = ?', d.name, d.match, JSON.stringify(d.rules), now(), id);
    return this.find(id);
  }

  remove(id) {
    this.find(id);
    this.db.run('DELETE FROM segments WHERE id = ?', id);
  }

  /** Bedingung für ein gespeichertes Segment (per ID oder Objekt). */
  condition(segment) {
    const s = typeof segment === 'object' ? segment : this.find(segment);
    return compileRules(s.rules, s.match);
  }

  /** Anzahl aktiver Abonnenten im Segment. */
  count(segment) {
    const c = this.condition(segment);
    return this.db.get(`SELECT COUNT(*) AS n FROM subscribers s WHERE s.status = 'active' AND ${c.sql}`, ...c.params).n;
  }

  /** Ungespeicherte Regeln testen: Anzahl und Beispiele. */
  preview({ match = 'all', rules = [] }) {
    const d = this.normalize({ name: '', match, rules });
    const c = compileRules(d.rules, d.match);
    const where = `s.status = 'active' AND ${c.sql}`;
    return {
      count: this.db.get(`SELECT COUNT(*) AS n FROM subscribers s WHERE ${where}`, ...c.params).n,
      sample: this.db.all(`SELECT s.id, s.email, s.first_name, s.last_name FROM subscribers s WHERE ${where} ORDER BY s.id DESC LIMIT 10`, ...c.params),
    };
  }
}
