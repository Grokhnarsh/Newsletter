import { badRequest, conflict, notFound } from '../../../lib/errors.js';
import { applyLayout, extractLinks } from '../../../lib/render.js';
import { now } from '../../../lib/time.js';

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled'];
const EDITABLE_FIELDS = [
  'name', 'subject', 'preheader', 'from_name', 'from_email', 'reply_to', 'content_html',
  'content_text', 'template_id', 'track_opens', 'track_clicks', 'archive',
];
const BOOL_FIELDS = new Set(['track_opens', 'track_clicks', 'archive']);

const STATS_SELECT = `
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id) AS recipient_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') AS failed_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'queued') AS queued_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.opened_at IS NOT NULL) AS unique_opens,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.clicked_at IS NOT NULL) AS unique_clicks,
  (SELECT COUNT(*) FROM events e WHERE e.campaign_id = c.id AND e.type = 'unsubscribed') AS unsubscribes`;

function rate(part, total) {
  return total ? Math.round((part / total) * 1000) / 10 : 0;
}

function shape(row) {
  if (!row) return row;
  const out = { ...row };
  for (const f of BOOL_FIELDS) out[f] = Boolean(row[f]);
  if ('sent_count' in row) {
    out.open_rate = rate(row.unique_opens, row.sent_count);
    out.click_rate = rate(row.unique_clicks, row.sent_count);
  }
  return out;
}

export class CampaignService {
  constructor(db, { templates, settings }) {
    this.db = db;
    this.templates = templates;
    this.settings = settings;
  }

  /** Layout-HTML der Kampagne (eigene Vorlage, sonst Standardvorlage aus den Einstellungen). */
  layoutFor(campaign) {
    const id = campaign.template_id || this.settings?.get('default_template_id');
    return this.templates.findOptional(id)?.html;
  }

  list({ status } = {}) {
    if (status && !CAMPAIGN_STATUSES.includes(status)) throw badRequest('Ungültiger Status');
    const rows = this.db.all(
      `SELECT c.id, c.name, c.subject, c.status, c.scheduled_at, c.started_at, c.finished_at, c.created_at, c.updated_at,
         c.archive, c.track_opens, c.track_clicks, ${STATS_SELECT},
         (SELECT GROUP_CONCAT(list_id) FROM campaign_lists WHERE campaign_id = c.id) AS list_ids
       FROM campaigns c ${status ? 'WHERE c.status = ?' : ''} ORDER BY COALESCE(c.started_at, c.scheduled_at, c.created_at) DESC, c.id DESC`,
      ...(status ? [status] : []),
    );
    return rows.map((r) => ({ ...shape(r), list_ids: r.list_ids ? r.list_ids.split(',').map(Number) : [] }));
  }

  find(id) {
    const row = this.db.get(`SELECT c.*, ${STATS_SELECT} FROM campaigns c WHERE c.id = ?`, id);
    if (!row) throw notFound('Kampagne nicht gefunden');
    return { ...shape(row), list_ids: this.listIds(id) };
  }

  listIds(id) {
    return this.db.all('SELECT list_id FROM campaign_lists WHERE campaign_id = ? ORDER BY list_id', id).map((r) => r.list_id);
  }

  setLists(id, listIds) {
    this.db.run('DELETE FROM campaign_lists WHERE campaign_id = ?', id);
    for (const listId of listIds) this.db.run('INSERT OR IGNORE INTO campaign_lists (campaign_id, list_id) VALUES (?, ?)', id, listId);
  }

  create(data, userId) {
    const t = now();
    return this.db.transaction(() => {
      const { lastInsertRowid: id } = this.db.run(
        `INSERT INTO campaigns (name, subject, preheader, from_name, from_email, reply_to, content_html, content_text,
           template_id, track_opens, track_clicks, archive, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.name,
        data.subject || '',
        data.preheader || '',
        data.from_name || '',
        data.from_email || '',
        data.reply_to || '',
        data.content_html || '',
        data.content_text || '',
        data.template_id || null,
        data.track_opens === false ? 0 : 1,
        data.track_clicks === false ? 0 : 1,
        data.archive ? 1 : 0,
        userId ?? null,
        t,
        t,
      );
      if (data.list_ids) this.setLists(id, data.list_ids);
      return this.find(id);
    });
  }

  update(id, data) {
    const campaign = this.find(id);
    if (!['draft', 'scheduled'].includes(campaign.status)) {
      // Nach dem Versand darf nur noch die Archiv-Freigabe geändert werden.
      const keys = Object.keys(data).filter((k) => data[k] !== undefined);
      if (keys.some((k) => !['archive', 'name'].includes(k))) throw conflict('Bereits versendete Kampagnen können nicht mehr bearbeitet werden');
    }
    return this.db.transaction(() => {
      const sets = [];
      const params = [];
      for (const field of EDITABLE_FIELDS) {
        if (data[field] === undefined) continue;
        sets.push(`${field} = ?`);
        params.push(BOOL_FIELDS.has(field) ? (data[field] ? 1 : 0) : data[field] ?? (field === 'template_id' ? null : ''));
      }
      sets.push('updated_at = ?');
      params.push(now(), id);
      this.db.run(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ?`, ...params);
      if (data.list_ids) this.setLists(id, data.list_ids);
      return this.find(id);
    });
  }

  remove(id) {
    const campaign = this.find(id);
    if (campaign.status === 'sending') throw conflict('Eine laufende Kampagne muss zuerst pausiert oder abgebrochen werden');
    this.db.run('DELETE FROM campaigns WHERE id = ?', id);
  }

  duplicate(id, userId) {
    const c = this.find(id);
    return this.create({ ...c, name: `${c.name} (Kopie)`, list_ids: c.list_ids }, userId);
  }

  /** Anzahl eindeutiger aktiver Abonnenten in den angegebenen Listen. */
  audienceCount(listIds) {
    if (!listIds.length) return 0;
    return this.db.get(
      `SELECT COUNT(DISTINCT s.id) AS n FROM subscribers s JOIN subscriber_lists sl ON sl.subscriber_id = s.id
       WHERE s.status = 'active' AND sl.list_id IN (${listIds.map(() => '?').join(',')})`,
      ...listIds,
    ).n;
  }

  assertSendable(campaign) {
    const problems = [];
    if (!campaign.subject.trim()) problems.push('Betreff fehlt');
    if (!campaign.content_html.trim()) problems.push('Inhalt fehlt');
    if (!campaign.list_ids.length) problems.push('Keine Empfängerliste ausgewählt');
    else if (this.audienceCount(campaign.list_ids) === 0) problems.push('Die ausgewählten Listen enthalten keine aktiven Abonnenten');
    if (problems.length) throw badRequest(`Kampagne kann nicht versendet werden: ${problems.join(', ')}`, { problems });
  }

  schedule(id, scheduledAt) {
    const campaign = this.find(id);
    if (!['draft', 'scheduled'].includes(campaign.status)) throw conflict('Nur Entwürfe können geplant werden');
    if (new Date(scheduledAt).getTime() <= Date.now()) throw badRequest('Der Zeitpunkt muss in der Zukunft liegen');
    this.assertSendable(campaign);
    this.db.run("UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, updated_at = ? WHERE id = ?", scheduledAt, now(), id);
    return this.find(id);
  }

  unschedule(id) {
    const campaign = this.find(id);
    if (campaign.status !== 'scheduled') throw conflict('Kampagne ist nicht geplant');
    this.db.run("UPDATE campaigns SET status = 'draft', scheduled_at = NULL, updated_at = ? WHERE id = ?", now(), id);
    return this.find(id);
  }

  /**
   * Startet den Versand: legt die Empfänger an (Momentaufnahme der aktiven
   * Abonnenten) und registriert alle trackbaren Links.
   */
  start(id) {
    const campaign = this.find(id);
    if (!['draft', 'scheduled'].includes(campaign.status)) throw conflict('Kampagne wurde bereits gestartet');
    this.assertSendable(campaign);
    return this.db.transaction(() => {
      const placeholders = campaign.list_ids.map(() => '?').join(',');
      this.db.run(
        `INSERT OR IGNORE INTO campaign_recipients (campaign_id, subscriber_id, token, status)
         SELECT ?, s.id, lower(hex(randomblob(16))), 'queued' FROM subscribers s
         WHERE s.status = 'active' AND EXISTS (
           SELECT 1 FROM subscriber_lists sl WHERE sl.subscriber_id = s.id AND sl.list_id IN (${placeholders}))`,
        id,
        ...campaign.list_ids,
      );
      for (const url of extractLinks(applyLayout(this.layoutFor(campaign), campaign.content_html))) {
        this.db.run('INSERT OR IGNORE INTO links (campaign_id, url) VALUES (?, ?)', id, url);
      }
      const t = now();
      this.db.run("UPDATE campaigns SET status = 'sending', started_at = ?, scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?", t, t, t, id);
      return this.find(id);
    });
  }

  pause(id) {
    const campaign = this.find(id);
    if (campaign.status !== 'sending') throw conflict('Nur laufende Kampagnen können pausiert werden');
    this.db.run("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?", now(), id);
    return this.find(id);
  }

  resume(id) {
    const campaign = this.find(id);
    if (campaign.status !== 'paused') throw conflict('Kampagne ist nicht pausiert');
    this.db.run("UPDATE campaigns SET status = 'sending', updated_at = ? WHERE id = ?", now(), id);
    return this.find(id);
  }

  cancel(id) {
    const campaign = this.find(id);
    if (!['scheduled', 'sending', 'paused'].includes(campaign.status)) throw conflict('Kampagne kann nicht abgebrochen werden');
    this.db.transaction(() => {
      this.db.run("UPDATE campaign_recipients SET status = 'skipped', error = 'Kampagne abgebrochen' WHERE campaign_id = ? AND status = 'queued'", id);
      this.db.run("UPDATE campaigns SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?", now(), now(), id);
    });
    return this.find(id);
  }

  /** Geplante Kampagnen starten, deren Zeitpunkt erreicht ist. */
  startDue() {
    const due = this.db.all("SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?", now());
    const started = [];
    for (const { id } of due) {
      try {
        this.start(id);
        started.push(id);
      } catch (err) {
        // z. B. keine aktiven Empfänger mehr – zurück in den Entwurf
        this.db.run("UPDATE campaigns SET status = 'draft', updated_at = ? WHERE id = ?", now(), id);
        this.db.run(
          "INSERT INTO events (type, campaign_id, data, created_at) VALUES ('campaign_error', ?, ?, ?)",
          id,
          JSON.stringify({ error: err.message }),
          now(),
        );
      }
    }
    return started;
  }

  /** Markiert laufende Kampagnen ohne offene Empfänger als versendet. */
  finishCompleted() {
    const t = now();
    return this.db.run(
      `UPDATE campaigns SET status = 'sent', finished_at = ?, updated_at = ?
       WHERE status = 'sending' AND NOT EXISTS (
         SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = campaigns.id AND r.status = 'queued')`,
      t,
      t,
    ).changes;
  }

  report(id) {
    const campaign = this.find(id);
    const links = this.db.all(
      `SELECT l.id, l.url, COUNT(lc.id) AS clicks, COUNT(DISTINCT lc.recipient_id) AS unique_clicks
       FROM links l LEFT JOIN link_clicks lc ON lc.link_id = l.id
       WHERE l.campaign_id = ? GROUP BY l.id ORDER BY clicks DESC, l.id`,
      id,
    );
    const totals = this.db.get(
      'SELECT COALESCE(SUM(open_count), 0) AS total_opens, COALESCE(SUM(click_count), 0) AS total_clicks FROM campaign_recipients WHERE campaign_id = ?',
      id,
    );
    // Öffnungen & Klicks pro Stunde in den ersten 7 Tagen nach Versandstart
    const timeline = this.db.all(
      `SELECT substr(created_at, 1, 13) AS hour,
         SUM(type = 'open') AS opens, SUM(type = 'click') AS clicks
       FROM events WHERE campaign_id = ? AND type IN ('open', 'click')
       GROUP BY hour ORDER BY hour LIMIT 168`,
      id,
    );
    const bounces = this.db.get(
      "SELECT COUNT(*) AS n FROM events WHERE campaign_id = ? AND type IN ('bounced', 'complained')",
      id,
    ).n;
    return {
      campaign,
      totals: { ...totals, bounces, click_to_open_rate: rate(campaign.unique_clicks, campaign.unique_opens) },
      links,
      timeline,
    };
  }

  recipients(id, { status, q }, { page, perPage, offset }) {
    this.find(id);
    const where = ['r.campaign_id = ?'];
    const params = [id];
    if (status === 'opened') where.push('r.opened_at IS NOT NULL');
    else if (status === 'clicked') where.push('r.clicked_at IS NOT NULL');
    else if (status) {
      where.push('r.status = ?');
      params.push(status);
    }
    if (q) {
      where.push('s.email LIKE ?');
      params.push(`%${q}%`);
    }
    const from = `FROM campaign_recipients r LEFT JOIN subscribers s ON s.id = r.subscriber_id WHERE ${where.join(' AND ')}`;
    const total = this.db.get(`SELECT COUNT(*) AS n ${from}`, ...params).n;
    const items = this.db.all(
      `SELECT r.id, r.subscriber_id, COALESCE(s.email, '(gelöscht)') AS email, r.status, r.attempts, r.error, r.sent_at,
         r.opened_at, r.open_count, r.clicked_at, r.click_count ${from} ORDER BY r.id LIMIT ? OFFSET ?`,
      ...params,
      perPage,
      offset,
    );
    return { items, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  // ---- Tracking ----

  recipientByToken(token) {
    return this.db.get('SELECT * FROM campaign_recipients WHERE token = ?', String(token));
  }

  recordOpen(recipient) {
    const t = now();
    this.db.run('UPDATE campaign_recipients SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?', t, recipient.id);
    this.db.run(
      "INSERT INTO events (type, subscriber_id, campaign_id, data, created_at) VALUES ('open', ?, ?, '{}', ?)",
      recipient.subscriber_id,
      recipient.campaign_id,
      t,
    );
  }

  /** Registriert einen Klick und liefert die Ziel-URL (nur bekannte Links → kein Open Redirect). */
  recordClick(recipient, linkId) {
    const link = this.db.get('SELECT * FROM links WHERE id = ? AND campaign_id = ?', linkId, recipient.campaign_id);
    if (!link) return null;
    const t = now();
    this.db.transaction(() => {
      this.db.run('INSERT INTO link_clicks (link_id, recipient_id, created_at) VALUES (?, ?, ?)', link.id, recipient.id, t);
      // Ein Klick impliziert eine Öffnung (z. B. bei blockierten Bildern).
      this.db.run(
        `UPDATE campaign_recipients SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?),
           opened_at = COALESCE(opened_at, ?), open_count = MAX(open_count, 1) WHERE id = ?`,
        t,
        t,
        recipient.id,
      );
      this.db.run(
        "INSERT INTO events (type, subscriber_id, campaign_id, data, created_at) VALUES ('click', ?, ?, ?, ?)",
        recipient.subscriber_id,
        recipient.campaign_id,
        JSON.stringify({ url: link.url }),
        t,
      );
    });
    return link.url;
  }

  linkMap(campaignId) {
    return new Map(this.db.all('SELECT id, url FROM links WHERE campaign_id = ?', campaignId).map((l) => [l.url, l.id]));
  }

  archived() {
    return this.db.all(
      "SELECT id, name, subject, preheader, started_at FROM campaigns WHERE archive = 1 AND status = 'sent' ORDER BY started_at DESC",
    );
  }
}
