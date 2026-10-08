import { badRequest, conflict, notFound } from '../../../lib/errors.js';
import { applyLayout, extractLinks } from '../../../lib/render.js';
import { now } from '../../../lib/time.js';

export const CAMPAIGN_STATUSES = ['draft', 'scheduled', 'sending', 'paused', 'sent', 'cancelled'];
const EDITABLE_FIELDS = [
  'name', 'subject', 'preheader', 'from_name', 'from_email', 'reply_to', 'content_html',
  'content_text', 'template_id', 'track_opens', 'track_clicks', 'archive',
  'segment_id', 'subject_b', 'ab_test_percent', 'ab_wait_hours', 'ab_metric',
];
const BOOL_FIELDS = new Set(['track_opens', 'track_clicks', 'archive']);

const STATS_SELECT = `
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id) AS recipient_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'sent') AS sent_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'failed') AS failed_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'queued') AS queued_count,
  (SELECT COUNT(*) FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'held') AS held_count,
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

/** Kampagne mit A/B-Test des Betreffs? */
export const isAbTest = (c) => Boolean(c.subject_b?.trim()) && c.ab_test_percent > 0;

export class CampaignService {
  constructor(db, { templates, settings, segments }) {
    this.db = db;
    this.templates = templates;
    this.settings = settings;
    this.segments = segments;
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
         c.archive, c.track_opens, c.track_clicks, c.segment_id, c.subject_b, c.ab_test_percent, c.ab_winner, ${STATS_SELECT},
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
           template_id, track_opens, track_clicks, archive, segment_id, subject_b, ab_test_percent, ab_wait_hours, ab_metric,
           created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        data.segment_id || null,
        data.subject_b || '',
        data.ab_test_percent || 0,
        data.ab_wait_hours ?? 4,
        data.ab_metric || 'opens',
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
        params.push(BOOL_FIELDS.has(field) ? (data[field] ? 1 : 0) : data[field] ?? (['template_id', 'segment_id'].includes(field) ? null : ''));
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

  /**
   * Zielgruppe als SQL-Bedingung über `subscribers s`: aktive Abonnenten aus den Listen,
   * eingeschränkt auf das Segment. Ohne Listen gilt das Segment für alle Abonnenten.
   */
  audience({ list_ids = [], segment_id = null }) {
    const where = ["s.status = 'active'"];
    const params = [];
    if (list_ids.length) {
      where.push(`EXISTS (SELECT 1 FROM subscriber_lists sl WHERE sl.subscriber_id = s.id AND sl.list_id IN (${list_ids.map(() => '?').join(',')}))`);
      params.push(...list_ids);
    }
    if (segment_id) {
      const c = this.segments.condition(segment_id);
      where.push(c.sql);
      params.push(...c.params);
    }
    return { sql: where.join(' AND '), params, empty: !list_ids.length && !segment_id };
  }

  /** Anzahl eindeutiger aktiver Empfänger (Listen und/oder Segment). */
  audienceCount(target) {
    const a = this.audience(Array.isArray(target) ? { list_ids: target } : target);
    if (a.empty) return 0;
    return this.db.get(`SELECT COUNT(*) AS n FROM subscribers s WHERE ${a.sql}`, ...a.params).n;
  }

  assertSendable(campaign) {
    const problems = [];
    if (!campaign.subject.trim()) problems.push('Betreff fehlt');
    if (!campaign.content_html.trim()) problems.push('Inhalt fehlt');
    if (!campaign.list_ids.length && !campaign.segment_id) problems.push('Keine Empfängerliste und kein Segment ausgewählt');
    else if (this.audienceCount(campaign) === 0) problems.push('Die Zielgruppe enthält keine aktiven Abonnenten');
    if (campaign.ab_test_percent > 0 && !campaign.subject_b.trim()) problems.push('Für den A/B-Test fehlt Betreff B');
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
    const ab = isAbTest(campaign);
    return this.db.transaction(() => {
      const a = this.audience(campaign);
      this.db.run(
        `INSERT OR IGNORE INTO campaign_recipients (campaign_id, subscriber_id, token, status)
         SELECT ?, s.id, lower(hex(randomblob(16))), ? FROM subscribers s WHERE ${a.sql}`,
        id,
        ab ? 'held' : 'queued',
        ...a.params,
      );
      if (ab) this.startAbTest(campaign);
      for (const url of extractLinks(applyLayout(this.layoutFor(campaign), campaign.content_html))) {
        this.db.run('INSERT OR IGNORE INTO links (campaign_id, url) VALUES (?, ?)', id, url);
      }
      const t = now();
      this.db.run("UPDATE campaigns SET status = 'sending', started_at = ?, scheduled_at = COALESCE(scheduled_at, ?), updated_at = ? WHERE id = ?", t, t, t, id);
      return this.find(id);
    });
  }

  // ---- A/B-Test des Betreffs ----

  /**
   * Zufällige Testgruppe: je die Hälfte bekommt Betreff A bzw. B, der Rest wird
   * zurückgehalten, bis nach der Wartezeit der Gewinner feststeht.
   */
  startAbTest(campaign) {
    const ids = this.db.all("SELECT id FROM campaign_recipients WHERE campaign_id = ? AND status = 'held' ORDER BY random()", campaign.id).map((r) => r.id);
    const testSize = Math.min(ids.length, Math.max(2, Math.round((ids.length * campaign.ab_test_percent) / 100)));
    const half = Math.ceil(testSize / 2);
    const mark = (slice, variant) => {
      for (let i = 0; i < slice.length; i += 500) {
        const chunk = slice.slice(i, i + 500);
        this.db.run(`UPDATE campaign_recipients SET status = 'queued', variant = ? WHERE id IN (${chunk.map(() => '?').join(',')})`, variant, ...chunk);
      }
    };
    mark(ids.slice(0, half), 'a');
    mark(ids.slice(half, testSize), 'b');
    const endsAt = new Date(Date.now() + campaign.ab_wait_hours * 3600_000).toISOString();
    this.db.run('UPDATE campaigns SET ab_test_ends_at = ?, ab_winner = NULL WHERE id = ?', endsAt, campaign.id);
  }

  /** Öffnungs- und Klickraten je Variante. */
  abResults(id) {
    const rows = this.db.all(
      `SELECT variant, COUNT(*) AS recipients, SUM(status = 'sent') AS sent,
         SUM(opened_at IS NOT NULL) AS opens, SUM(clicked_at IS NOT NULL) AS clicks
       FROM campaign_recipients WHERE campaign_id = ? AND variant IS NOT NULL GROUP BY variant`,
      id,
    );
    const out = {};
    for (const v of ['a', 'b']) {
      const r = rows.find((x) => x.variant === v) || { recipients: 0, sent: 0, opens: 0, clicks: 0 };
      out[v] = { recipients: r.recipients, sent: r.sent || 0, opens: r.opens || 0, clicks: r.clicks || 0, open_rate: rate(r.opens, r.sent), click_rate: rate(r.clicks, r.sent) };
    }
    return out;
  }

  /** Gewinner festlegen und zurückgehaltene Empfänger mit diesem Betreff freigeben. */
  setAbWinner(id, variant) {
    const campaign = this.find(id);
    if (!isAbTest(campaign)) throw badRequest('Diese Kampagne hat keinen A/B-Test');
    if (campaign.ab_winner) throw conflict('Der Gewinner steht bereits fest');
    if (!['a', 'b'].includes(variant)) throw badRequest('Variante muss „a“ oder „b“ sein');
    this.db.transaction(() => {
      this.db.run('UPDATE campaigns SET ab_winner = ?, updated_at = ? WHERE id = ?', variant, now(), id);
      this.db.run("UPDATE campaign_recipients SET status = 'queued', variant = ? WHERE campaign_id = ? AND status = 'held'", variant, id);
      this.db.run(
        "INSERT INTO events (type, campaign_id, data, created_at) VALUES ('ab_winner', ?, ?, ?)",
        id,
        JSON.stringify({ variant, results: this.abResults(id) }),
        now(),
      );
    });
    return this.find(id);
  }

  /** Abgelaufene Tests auswerten (Gleichstand → A). */
  decideAbTests() {
    const due = this.db.all("SELECT id, ab_metric FROM campaigns WHERE status = 'sending' AND ab_winner IS NULL AND ab_test_ends_at <= ?", now());
    for (const c of due) {
      const r = this.abResults(c.id);
      const key = c.ab_metric === 'clicks' ? 'click_rate' : 'open_rate';
      this.setAbWinner(c.id, r.b[key] > r.a[key] ? 'b' : 'a');
    }
    return due.length;
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
      this.db.run("UPDATE campaign_recipients SET status = 'skipped', error = 'Kampagne abgebrochen' WHERE campaign_id = ? AND status IN ('queued', 'held')", id);
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
         SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = campaigns.id AND r.status IN ('queued', 'held'))`,
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
      ab: isAbTest(campaign) ? this.abResults(id) : null,
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
      `SELECT r.id, r.subscriber_id, COALESCE(s.email, '(gelöscht)') AS email, r.status, r.variant, r.attempts, r.error, r.sent_at,
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
