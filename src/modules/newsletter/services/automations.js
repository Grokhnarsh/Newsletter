import { badRequest, notFound } from '../../../lib/errors.js';
import { now } from '../../../lib/time.js';

const MAX_STEPS = 20;
const MAX_FAILURES_PER_STEP = 3;
const RETRY_MINUTES = 30;

const addHours = (iso, h) => new Date(new Date(iso).getTime() + h * 3600_000).toISOString();

/**
 * Automationen (z. B. Willkommensserie): Nach der Anmeldung erhält ein Abonnent
 * nacheinander die Schritte, jeweils mit einer Wartezeit nach dem vorherigen Schritt.
 */
export class AutomationService {
  constructor(db, { delivery, logger = console }) {
    Object.assign(this, { db, delivery, logger });
  }

  steps(automationId) {
    return this.db.all('SELECT * FROM automation_steps WHERE automation_id = ? ORDER BY position, id', automationId);
  }

  list() {
    return this.db.all(
      `SELECT a.*, l.name AS list_name,
         (SELECT COUNT(*) FROM automation_steps s WHERE s.automation_id = a.id) AS step_count,
         (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'active') AS active_runs,
         (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.status = 'done') AS completed_runs,
         (SELECT COUNT(*) FROM automation_sends x JOIN automation_runs r ON r.id = x.run_id WHERE r.automation_id = a.id AND x.status = 'sent') AS sent
       FROM automations a LEFT JOIN lists l ON l.id = a.list_id ORDER BY a.name`,
    );
  }

  find(id) {
    const row = this.db.get('SELECT * FROM automations WHERE id = ?', id);
    if (!row) throw notFound('Automation nicht gefunden');
    const steps = this.steps(id).map((s) => ({
      ...s,
      sent: this.db.get("SELECT COUNT(*) AS n FROM automation_sends WHERE step_id = ? AND status = 'sent'", s.id).n,
      waiting: this.db.get("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ? AND status = 'active' AND next_step = ?", id, s.position).n,
    }));
    const runs = this.db.get(
      "SELECT SUM(status = 'active') AS active, SUM(status = 'done') AS done, SUM(status = 'cancelled') AS cancelled FROM automation_runs WHERE automation_id = ?",
      id,
    );
    return { ...row, steps, runs: { active: runs.active || 0, done: runs.done || 0, cancelled: runs.cancelled || 0 } };
  }

  normalizeSteps(steps) {
    if (!Array.isArray(steps)) throw badRequest('steps muss eine Liste sein');
    if (steps.length > MAX_STEPS) throw badRequest(`Höchstens ${MAX_STEPS} Schritte`);
    return steps.map((s, i) => {
      const subject = String(s?.subject ?? '').trim().slice(0, 300);
      if (!subject) throw badRequest(`Schritt ${i + 1}: Betreff fehlt`);
      const delay = Number(s.delay_hours ?? 0);
      if (!Number.isInteger(delay) || delay < 0 || delay > 24 * 365) throw badRequest(`Schritt ${i + 1}: Wartezeit in ganzen Stunden (0–8760)`);
      return {
        id: Number(s.id) || null,
        delay_hours: delay,
        subject,
        preheader: String(s.preheader ?? '').slice(0, 300),
        content_html: String(s.content_html ?? '').slice(0, 1_000_000),
        template_id: Number(s.template_id) || null,
      };
    });
  }

  /** Schritte abgleichen: vorhandene (mit id) aktualisieren, neue anlegen, fehlende löschen. */
  saveSteps(automationId, steps) {
    const existing = new Set(this.steps(automationId).map((s) => s.id));
    const keep = new Set();
    steps.forEach((s, position) => {
      if (s.id && existing.has(s.id)) {
        keep.add(s.id);
        this.db.run(
          'UPDATE automation_steps SET position = ?, delay_hours = ?, subject = ?, preheader = ?, content_html = ?, template_id = ? WHERE id = ?',
          position, s.delay_hours, s.subject, s.preheader, s.content_html, s.template_id, s.id,
        );
      } else {
        this.db.run(
          'INSERT INTO automation_steps (automation_id, position, delay_hours, subject, preheader, content_html, template_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          automationId, position, s.delay_hours, s.subject, s.preheader, s.content_html, s.template_id,
        );
      }
    });
    for (const id of existing) if (!keep.has(id)) this.db.run('DELETE FROM automation_steps WHERE id = ?', id);
  }

  create({ name, list_id = null, status = 'draft', steps = [] }) {
    const clean = this.normalizeSteps(steps);
    if (status === 'active' && !clean.length) throw badRequest('Eine aktive Automation braucht mindestens einen Schritt');
    const t = now();
    return this.db.transaction(() => {
      const { lastInsertRowid: id } = this.db.run(
        'INSERT INTO automations (name, list_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        name, list_id || null, status, t, t,
      );
      this.saveSteps(id, clean);
      return this.find(id);
    });
  }

  update(id, data) {
    const current = this.find(id);
    const steps = data.steps !== undefined ? this.normalizeSteps(data.steps) : null;
    const status = data.status ?? current.status;
    if (status === 'active' && !(steps ?? current.steps).length) throw badRequest('Eine aktive Automation braucht mindestens einen Schritt');
    return this.db.transaction(() => {
      this.db.run(
        'UPDATE automations SET name = ?, list_id = ?, status = ?, updated_at = ? WHERE id = ?',
        data.name ?? current.name,
        data.list_id !== undefined ? data.list_id || null : current.list_id,
        status,
        now(),
        id,
      );
      if (steps) this.saveSteps(id, steps);
      return this.find(id);
    });
  }

  remove(id) {
    this.find(id);
    this.db.run('DELETE FROM automations WHERE id = ?', id);
  }

  /** Neuen Abonnenten in alle passenden aktiven Automationen aufnehmen. */
  enroll(subscriber) {
    if (!subscriber || subscriber.status !== 'active') return 0;
    const candidates = this.db.all("SELECT * FROM automations WHERE status = 'active' AND trigger = 'signup'");
    let enrolled = 0;
    for (const a of candidates) {
      if (a.list_id && !this.db.get('SELECT 1 FROM subscriber_lists WHERE subscriber_id = ? AND list_id = ?', subscriber.id, a.list_id)) continue;
      const first = this.steps(a.id)[0];
      if (!first) continue;
      const t = now();
      const { changes } = this.db.run(
        'INSERT OR IGNORE INTO automation_runs (automation_id, subscriber_id, next_step, next_at, status, started_at) VALUES (?, ?, 0, ?, ?, ?)',
        a.id, subscriber.id, addHours(t, first.delay_hours), 'active', t,
      );
      enrolled += changes;
    }
    return enrolled;
  }

  finishRun(run, status) {
    this.db.run('UPDATE automation_runs SET status = ?, next_at = NULL, finished_at = ? WHERE id = ?', status, now(), run.id);
  }

  /** Fällige Schritte versenden (vom Versand-Worker aufgerufen). Liefert die Anzahl versuchter Sendungen. */
  async runDue(limit = Infinity) {
    if (limit <= 0) return 0;
    const runs = this.db.all(
      `SELECT r.* FROM automation_runs r JOIN automations a ON a.id = r.automation_id
       WHERE r.status = 'active' AND a.status = 'active' AND r.next_at <= ? ORDER BY r.next_at LIMIT ?`,
      now(),
      Number.isFinite(limit) ? limit : -1,
    );
    let attempted = 0;
    for (const run of runs) {
      const subscriber = this.db.get('SELECT * FROM subscribers WHERE id = ?', run.subscriber_id);
      if (!subscriber || subscriber.status !== 'active') {
        this.finishRun(run, 'cancelled');
        continue;
      }
      const steps = this.steps(run.automation_id);
      const step = steps[run.next_step];
      if (!step) {
        this.finishRun(run, 'done');
        continue;
      }
      attempted++;
      let ok = true;
      try {
        await this.delivery.sendAutomationStep(step, subscriber);
        this.db.run("INSERT INTO automation_sends (run_id, step_id, status, created_at) VALUES (?, ?, 'sent', ?)", run.id, step.id, now());
      } catch (err) {
        ok = false;
        this.db.run("INSERT INTO automation_sends (run_id, step_id, status, error, created_at) VALUES (?, ?, 'failed', ?, ?)", run.id, step.id, String(err.message).slice(0, 500), now());
        this.logger.warn(`[automation] Schritt ${step.id} an ${subscriber.email} fehlgeschlagen: ${err.message}`);
      }
      const failures = ok ? 0 : this.db.get("SELECT COUNT(*) AS n FROM automation_sends WHERE run_id = ? AND step_id = ? AND status = 'failed'", run.id, step.id).n;
      if (!ok && failures < MAX_FAILURES_PER_STEP) {
        this.db.run('UPDATE automation_runs SET next_at = ? WHERE id = ?', new Date(Date.now() + RETRY_MINUTES * 60_000).toISOString(), run.id);
        continue;
      }
      const next = steps[run.next_step + 1];
      if (next) this.db.run('UPDATE automation_runs SET next_step = ?, next_at = ? WHERE id = ?', run.next_step + 1, addHours(now(), next.delay_hours), run.id);
      else this.finishRun(run, 'done');
    }
    return attempted;
  }
}
