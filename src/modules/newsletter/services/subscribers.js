import { badRequest, conflict, notFound } from '../../../lib/errors.js';
import { randomToken } from '../../../lib/security.js';
import { now } from '../../../lib/time.js';
import { isEmail, normalizeEmail } from '../../../lib/validate.js';

/** Mindestabstand zwischen zwei Bestätigungs-Mails an dieselbe Adresse (öffentliches Formular). */
export const CONFIRMATION_COOLDOWN_MS = 24 * 3600_000;
export const STATUSES = ['pending', 'active', 'unsubscribed', 'bounced', 'complained'];
const SORTABLE = { email: 's.email', created_at: 's.created_at', status: 's.status', first_name: 's.first_name', last_name: 's.last_name' };
const IMPORT_FIELDS = new Set(['email', 'e-mail', 'mail', 'first_name', 'firstname', 'vorname', 'last_name', 'lastname', 'nachname', 'name', 'status']);

function shape(row) {
  if (!row) return row;
  const { attributes, ...rest } = row;
  let attrs = {};
  try {
    attrs = JSON.parse(attributes || '{}');
  } catch {
    attrs = {};
  }
  return { ...rest, attributes: attrs, tracking_consent: Boolean(rest.tracking_consent) };
}

export class SubscriberService {
  constructor(db) {
    this.db = db;
  }

  // ---- Abfragen ----

  buildFilter({ q, status, list_id }) {
    const where = [];
    const params = [];
    if (q) {
      where.push("(s.email LIKE ? ESCAPE '\\' OR s.first_name LIKE ? ESCAPE '\\' OR s.last_name LIKE ? ESCAPE '\\')");
      const like = `%${String(q).replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      params.push(like, like, like);
    }
    if (status) {
      if (!STATUSES.includes(status)) throw badRequest('Ungültiger Status');
      where.push('s.status = ?');
      params.push(status);
    }
    if (list_id) {
      where.push('EXISTS (SELECT 1 FROM subscriber_lists sl WHERE sl.subscriber_id = s.id AND sl.list_id = ?)');
      params.push(Number(list_id));
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  list(query, { page, perPage, offset }) {
    const filter = this.buildFilter(query);
    const sortCol = SORTABLE[query.sort] || 's.created_at';
    const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
    const total = this.db.get(`SELECT COUNT(*) AS n FROM subscribers s ${filter.sql}`, ...filter.params).n;
    const rows = this.db.all(
      `SELECT s.*, (SELECT GROUP_CONCAT(list_id) FROM subscriber_lists WHERE subscriber_id = s.id) AS list_ids
       FROM subscribers s ${filter.sql} ORDER BY ${sortCol} ${dir}, s.id ${dir} LIMIT ? OFFSET ?`,
      ...filter.params,
      perPage,
      offset,
    );
    return {
      items: rows.map((r) => ({ ...shape(r), list_ids: r.list_ids ? r.list_ids.split(',').map(Number) : [] })),
      total,
      page,
      per_page: perPage,
      pages: Math.max(1, Math.ceil(total / perPage)),
    };
  }

  find(id) {
    const row = this.db.get('SELECT * FROM subscribers WHERE id = ?', id);
    if (!row) throw notFound('Abonnent nicht gefunden');
    return { ...shape(row), list_ids: this.listIds(id) };
  }

  findByEmail(email) {
    return shape(this.db.get('SELECT * FROM subscribers WHERE email = ?', normalizeEmail(email)));
  }

  findByToken(token) {
    const row = this.db.get('SELECT * FROM subscribers WHERE token = ?', String(token));
    if (!row) throw notFound('Abonnement nicht gefunden');
    return { ...shape(row), list_ids: this.listIds(row.id) };
  }

  listIds(id) {
    return this.db.all('SELECT list_id FROM subscriber_lists WHERE subscriber_id = ? ORDER BY list_id', id).map((r) => r.list_id);
  }

  details(id) {
    const subscriber = this.find(id);
    const events = this.db.all(
      `SELECT e.id, e.type, e.campaign_id, c.name AS campaign_name, e.data, e.created_at
       FROM events e LEFT JOIN campaigns c ON c.id = e.campaign_id
       WHERE e.subscriber_id = ? ORDER BY e.id DESC LIMIT 100`,
      id,
    ).map((e) => ({ ...e, data: JSON.parse(e.data) }));
    const campaigns = this.db.all(
      `SELECT c.id, c.name, c.subject, r.status, r.sent_at, r.opened_at, r.open_count, r.clicked_at, r.click_count
       FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.subscriber_id = ? ORDER BY r.id DESC LIMIT 100`,
      id,
    );
    return { ...subscriber, events, campaigns };
  }

  // ---- Schreiben ----

  logEvent(type, subscriberId, campaignId = null, data = {}) {
    this.db.run(
      'INSERT INTO events (type, subscriber_id, campaign_id, data, created_at) VALUES (?, ?, ?, ?, ?)',
      type,
      subscriberId,
      campaignId,
      JSON.stringify(data),
      now(),
    );
  }

  /** Setzt den Status inklusive Zeitstempeln und Ereignis-Protokoll. */
  setStatus(id, status, { campaignId = null, reason } = {}) {
    const current = this.db.get('SELECT status FROM subscribers WHERE id = ?', id);
    if (!current) throw notFound('Abonnent nicht gefunden');
    if (current.status === status) return false;
    const t = now();
    if (status === 'active') {
      this.db.run(
        'UPDATE subscribers SET status = ?, updated_at = ?, confirmed_at = COALESCE(confirmed_at, ?), unsubscribed_at = NULL WHERE id = ?',
        status, t, t, id,
      );
    } else if (status === 'unsubscribed') {
      this.db.run('UPDATE subscribers SET status = ?, updated_at = ?, unsubscribed_at = ? WHERE id = ?', status, t, t, id);
    } else {
      this.db.run('UPDATE subscribers SET status = ?, updated_at = ? WHERE id = ?', status, t, id);
    }
    const eventType = { active: 'subscribed', unsubscribed: 'unsubscribed', bounced: 'bounced', complained: 'complained', pending: 'pending' }[status];
    this.logEvent(eventType, id, campaignId, reason ? { reason } : {});
    return true;
  }

  setLists(id, listIds) {
    this.db.transaction(() => {
      this.db.run('DELETE FROM subscriber_lists WHERE subscriber_id = ?', id);
      this.addToLists(id, listIds);
    });
  }

  addToLists(id, listIds) {
    const t = now();
    for (const listId of listIds) {
      this.db.run('INSERT OR IGNORE INTO subscriber_lists (subscriber_id, list_id, created_at) VALUES (?, ?, ?)', id, listId, t);
    }
  }

  create(data, { source = 'admin', ip = null } = {}) {
    if (this.findByEmail(data.email)) throw conflict('Diese E-Mail-Adresse ist bereits eingetragen');
    const t = now();
    const status = data.status || 'active';
    return this.db.transaction(() => {
      const { lastInsertRowid: id } = this.db.run(
        `INSERT INTO subscribers (email, first_name, last_name, status, attributes, token, source, ip, consent_at,
           confirmed_at, unsubscribed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.email,
        data.first_name || '',
        data.last_name || '',
        status,
        JSON.stringify(data.attributes || {}),
        randomToken(24),
        source,
        ip,
        t,
        status === 'active' ? t : null,
        status === 'unsubscribed' ? t : null,
        t,
        t,
      );
      if (data.list_ids?.length) this.addToLists(id, data.list_ids);
      this.logEvent('created', id, null, { source });
      if (status === 'active') this.logEvent('subscribed', id, null, { source });
      return this.find(id);
    });
  }

  update(id, data) {
    const existing = this.find(id);
    if (data.email && data.email !== existing.email) {
      const other = this.findByEmail(data.email);
      if (other && other.id !== id) throw conflict('Diese E-Mail-Adresse ist bereits eingetragen');
    }
    return this.db.transaction(() => {
      this.db.run(
        `UPDATE subscribers SET email = COALESCE(?, email), first_name = COALESCE(?, first_name),
           last_name = COALESCE(?, last_name), attributes = COALESCE(?, attributes), updated_at = ? WHERE id = ?`,
        data.email ?? null,
        data.first_name ?? null,
        data.last_name ?? null,
        data.attributes ? JSON.stringify(data.attributes) : null,
        now(),
        id,
      );
      if (data.status) this.setStatus(id, data.status, { reason: 'admin' });
      if (data.list_ids) this.setLists(id, data.list_ids);
      return this.find(id);
    });
  }

  remove(id) {
    const { changes } = this.db.run('DELETE FROM subscribers WHERE id = ?', id);
    if (!changes) throw notFound('Abonnent nicht gefunden');
  }

  bulk({ action, ids, list_id, status }) {
    let affected = 0;
    this.db.transaction(() => {
      for (const id of ids) {
        if (!this.db.get('SELECT 1 FROM subscribers WHERE id = ?', id)) continue;
        switch (action) {
          case 'delete':
            this.db.run('DELETE FROM subscribers WHERE id = ?', id);
            break;
          case 'add_to_list':
            this.addToLists(id, [list_id]);
            break;
          case 'remove_from_list':
            this.db.run('DELETE FROM subscriber_lists WHERE subscriber_id = ? AND list_id = ?', id, list_id);
            break;
          case 'set_status':
            this.setStatus(id, status, { reason: 'admin' });
            break;
          default:
            throw badRequest('Unbekannte Aktion');
        }
        affected++;
      }
    });
    return { affected };
  }

  /**
   * Importiert Datensätze (z. B. aus CSV). Unbekannte Spalten landen in `attributes`.
   * Bereits abgemeldete oder gebouncte Adressen werden nie automatisch reaktiviert.
   */
  import(records, { list_ids = [], status = 'active', update_existing = true }) {
    const result = { created: 0, updated: 0, skipped: 0, errors: [] };
    this.db.transaction(() => {
      records.forEach((rec, index) => {
        const email = normalizeEmail(rec.email ?? rec['e-mail'] ?? rec.mail);
        if (!isEmail(email)) {
          result.errors.push({ row: index + 2, error: `Ungültige E-Mail-Adresse: ${email || '(leer)'}` });
          return;
        }
        let first = rec.first_name ?? rec.firstname ?? rec.vorname ?? '';
        let last = rec.last_name ?? rec.lastname ?? rec.nachname ?? '';
        if (!first && !last && rec.name) [first, ...last] = String(rec.name).split(' ');
        if (Array.isArray(last)) last = last.join(' ');
        const attributes = Object.fromEntries(Object.entries(rec).filter(([k, v]) => !IMPORT_FIELDS.has(k) && v !== ''));
        const rowStatus = STATUSES.includes(rec.status) ? rec.status : status;
        const existing = this.findByEmail(email);
        if (existing) {
          if (!update_existing) {
            result.skipped++;
            return;
          }
          this.db.run(
            `UPDATE subscribers SET first_name = CASE WHEN ? != '' THEN ? ELSE first_name END,
               last_name = CASE WHEN ? != '' THEN ? ELSE last_name END, attributes = ?, updated_at = ? WHERE id = ?`,
            first,
            first,
            last,
            last,
            JSON.stringify({ ...existing.attributes, ...attributes }),
            now(),
            existing.id,
          );
          this.addToLists(existing.id, list_ids);
          result.updated++;
        } else {
          this.create({ email, first_name: first, last_name: last, status: rowStatus, attributes, list_ids }, { source: 'import' });
          result.created++;
        }
      });
    });
    return result;
  }

  exportRows(query) {
    const filter = this.buildFilter(query);
    return this.db
      .all(
        `SELECT s.*, (SELECT GROUP_CONCAT(l.name, '|') FROM subscriber_lists sl JOIN lists l ON l.id = sl.list_id
           WHERE sl.subscriber_id = s.id) AS lists
         FROM subscribers s ${filter.sql} ORDER BY s.id`,
        ...filter.params,
      )
      .map(shape);
  }

  // ---- Öffentliche Abläufe (An-/Abmeldung) ----

  /**
   * Anmeldung über das öffentliche Formular.
   * Rückgabe: { subscriber, action } mit action ∈ confirm | welcome | none
   */
  publicSubscribe({ email, first_name = '', last_name = '', list_ids, attributes = {}, tracking_consent }, { ip, doubleOptIn, source = 'form' }) {
    return this.db.transaction(() => {
      const existing = this.findByEmail(email);
      if (!existing) {
        const created = this.create(
          { email, first_name, last_name, attributes, list_ids, status: doubleOptIn ? 'pending' : 'active' },
          { source, ip },
        );
        if (tracking_consent) this.setTrackingConsent(created.id, true);
        return { subscriber: this.find(created.id), action: doubleOptIn ? 'confirm' : 'welcome' };
      }

      // Gesperrte Adressen (Bounce/Beschwerde) werden nicht verändert.
      if (existing.status === 'bounced' || existing.status === 'complained') return { subscriber: existing, action: 'none' };
      // Aktive Abonnenten ändern ihre Listen über die Einstellungsseite – nicht Dritte über das Formular.
      if (existing.status === 'active') return { subscriber: existing, action: 'none' };
      // Höchstens eine Bestätigungs-Mail pro Zeitraum, sonst ließe sich eine Adresse mit Mails fluten.
      if (existing.confirmation_sent_at && Date.now() - new Date(existing.confirmation_sent_at).getTime() < CONFIRMATION_COOLDOWN_MS) {
        return { subscriber: existing, action: 'none' };
      }

      this.addToLists(existing.id, list_ids);

      this.db.run(
        `UPDATE subscribers SET first_name = CASE WHEN first_name = '' THEN ? ELSE first_name END,
           last_name = CASE WHEN last_name = '' THEN ? ELSE last_name END, consent_at = ?, ip = ?, updated_at = ? WHERE id = ?`,
        first_name,
        last_name,
        now(),
        ip,
        now(),
        existing.id,
      );
      if (tracking_consent !== undefined) this.setTrackingConsent(existing.id, Boolean(tracking_consent));
      // Wer sich abgemeldet hat, wird nur nach eigener Bestätigung wieder aktiv.
      if (doubleOptIn || existing.status === 'unsubscribed') {
        this.setStatus(existing.id, 'pending');
        return { subscriber: this.find(existing.id), action: 'confirm' };
      }
      this.setStatus(existing.id, 'active', { reason: source });
      return { subscriber: this.find(existing.id), action: 'welcome' };
    });
  }

  markConfirmationSent(id) {
    this.db.run('UPDATE subscribers SET confirmation_sent_at = ? WHERE id = ?', now(), id);
  }

  /** Bestätigt eine Double-Opt-in-Anmeldung. Gibt { subscriber, changed } zurück. */
  confirm(token) {
    const subscriber = this.findByToken(token);
    if (subscriber.status !== 'pending') return { subscriber, changed: false };
    this.setStatus(subscriber.id, 'active', { reason: 'double_opt_in' });
    return { subscriber: this.find(subscriber.id), changed: true };
  }

  unsubscribe(token, { campaignId = null, reason = 'link' } = {}) {
    const subscriber = this.findByToken(token);
    if (subscriber.status === 'active' || subscriber.status === 'pending') {
      this.setStatus(subscriber.id, 'unsubscribed', { campaignId, reason });
    }
    return this.find(subscriber.id);
  }

  /** Einwilligung in die Auswertung von Öffnungen und Klicks (Tracking-Modus „consent“). */
  setTrackingConsent(id, consent) {
    const current = this.db.get('SELECT tracking_consent FROM subscribers WHERE id = ?', id);
    if (!current || Boolean(current.tracking_consent) === consent) return;
    this.db.run('UPDATE subscribers SET tracking_consent = ?, tracking_consent_at = ?, updated_at = ? WHERE id = ?', consent ? 1 : 0, now(), now(), id);
    this.logEvent(consent ? 'tracking_consent_given' : 'tracking_consent_withdrawn', id);
  }

  /** Aktualisiert Einstellungen über die Präferenzseite (nur öffentliche Listen). */
  updatePreferences(token, { first_name, last_name, list_ids, tracking_consent }, publicListIds) {
    const subscriber = this.findByToken(token);
    return this.db.transaction(() => {
      if (tracking_consent !== undefined) this.setTrackingConsent(subscriber.id, tracking_consent);
      this.db.run(
        'UPDATE subscribers SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ?',
        first_name ?? subscriber.first_name,
        last_name ?? subscriber.last_name,
        now(),
        subscriber.id,
      );
      const allowed = new Set(publicListIds);
      for (const listId of publicListIds) {
        if (list_ids.includes(listId)) this.addToLists(subscriber.id, [listId]);
        else this.db.run('DELETE FROM subscriber_lists WHERE subscriber_id = ? AND list_id = ?', subscriber.id, listId);
      }
      this.logEvent('preferences_updated', subscriber.id, null, { list_ids: list_ids.filter((id) => allowed.has(id)) });
      return this.find(subscriber.id);
    });
  }

  /** Verarbeitet Bounce-/Beschwerde-Meldungen (z. B. per Webhook). */
  recordBounce(email, type = 'hard', reason = '') {
    const subscriber = this.findByEmail(email);
    if (!subscriber) throw notFound('Abonnent nicht gefunden');
    if (type === 'soft') {
      this.logEvent('soft_bounce', subscriber.id, null, { reason });
      // Nach drei Soft-Bounces innerhalb von 30 Tagen wird die Adresse gesperrt.
      const since = new Date(Date.now() - 30 * 86400_000).toISOString();
      const count = this.db.get(
        "SELECT COUNT(*) AS n FROM events WHERE subscriber_id = ? AND type = 'soft_bounce' AND created_at >= ?",
        subscriber.id,
        since,
      ).n;
      if (count >= 3) this.setStatus(subscriber.id, 'bounced', { reason: 'soft_bounce_limit' });
    } else {
      this.setStatus(subscriber.id, type === 'complaint' ? 'complained' : 'bounced', { reason });
    }
    return this.find(subscriber.id);
  }

  /** DSGVO-Auskunft: alle gespeicherten Daten zu einem Abonnenten. */
  exportPersonalData(token) {
    const subscriber = this.findByToken(token);
    const details = this.details(subscriber.id);
    const lists = this.db.all(
      'SELECT l.name, sl.created_at FROM subscriber_lists sl JOIN lists l ON l.id = sl.list_id WHERE sl.subscriber_id = ?',
      subscriber.id,
    );
    const { token: _token, list_ids: _ids, ...data } = details;
    return { ...data, lists };
  }
}
