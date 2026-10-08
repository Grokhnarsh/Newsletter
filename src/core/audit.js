import { now } from '../lib/time.js';

const RETENTION_DAYS = 365;

/** Änderungsprotokoll: wer hat wann was im Admin-Bereich verändert. */
export class AuditLog {
  constructor(db) {
    this.db = db;
    this.lastPurge = 0;
  }

  actorOf(req) {
    if (req?.user) return { user_id: req.user.id, actor: req.user.email };
    if (req?.auth?.type === 'api_key') return { user_id: null, actor: `API-Schlüssel „${req.auth.name}“` };
    return { user_id: null, actor: 'System' };
  }

  log(req, action, target = '', details = {}, actorOverride) {
    const actor = actorOverride || this.actorOf(req);
    this.db.run(
      'INSERT INTO audit_log (user_id, actor, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      actor.user_id ?? null,
      actor.actor,
      action,
      String(target).slice(0, 300),
      JSON.stringify(details),
      req?.ip ?? null,
      now(),
    );
    this.purge();
  }

  purge() {
    if (Date.now() - this.lastPurge < 3600_000) return;
    this.lastPurge = Date.now();
    this.db.run('DELETE FROM audit_log WHERE created_at < ?', new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString());
  }

  list({ q, user_id }, { page, perPage, offset }) {
    const where = [];
    const params = [];
    if (q) {
      where.push('(action LIKE ? OR target LIKE ? OR actor LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (user_id) {
      where.push('user_id = ?');
      params.push(Number(user_id));
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get(`SELECT COUNT(*) AS n FROM audit_log ${sql}`, ...params).n;
    const items = this.db
      .all(`SELECT * FROM audit_log ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, perPage, offset)
      .map((r) => ({ ...r, details: JSON.parse(r.details) }));
    return { items, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }
}

// Diese Anfragen ändern nichts und werden nicht protokolliert.
const READ_ONLY = [/\/preview$/, /\/audience$/, /^\/auth\//, /\/test$/];

/** Protokolliert erfolgreiche schreibende API-Aufrufe automatisch. */
export function auditMiddleware(audit) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || READ_ONLY.some((re) => re.test(req.path))) return next();
    // Pfad jetzt festhalten – Unter-Router verändern req.url während der Verarbeitung
    const target = req.path;
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.auth) return;
      try {
        audit.log(req, req.method, target);
      } catch {
        /* Protokollfehler dürfen die Anfrage nicht beeinflussen */
      }
    });
    next();
  };
}
