import { badRequest, forbidden } from '../lib/errors.js';
import { escapeHtml } from '../lib/render.js';
import { now } from '../lib/time.js';
import { isAuthor } from '../middleware/auth.js';

/** Spalten, die Module mit Freigabe-Workflow per Migration ergänzen. */
export const REVIEW_COLUMNS_SQL = (table) => `
  ALTER TABLE ${table} ADD COLUMN review_requested_at TEXT;
  ALTER TABLE ${table} ADD COLUMN review_note TEXT NOT NULL DEFAULT '';
`;

/**
 * Freigabe-Workflow: Autoren bearbeiten nur eigene Entwürfe und reichen sie zur
 * Prüfung ein. Redaktion und Administratoren veröffentlichen sie oder geben sie
 * mit einem Hinweis zurück. Beide Seiten werden per E-Mail benachrichtigt.
 */
export class ReviewService {
  constructor({ db, config, systemMail, logger = console }) {
    Object.assign(this, { db, config, systemMail, logger });
  }

  /** Darf die Anfrage diesen Inhalt verändern? */
  canEdit(req, item) {
    if (!isAuthor(req)) return true;
    return item.author_id === req.user?.id && item.status === 'draft';
  }

  assertCanEdit(req, item) {
    if (this.canEdit(req, item)) return;
    throw forbidden(
      item.author_id !== req.user?.id ? 'Autoren können nur eigene Inhalte bearbeiten' : 'Veröffentlichte Inhalte kann nur die Redaktion ändern',
    );
  }

  /** Autoren dürfen weder veröffentlichen noch Erscheinungstermine setzen. */
  restrict(req, data) {
    if (!isAuthor(req)) return data;
    if (data.status && data.status !== 'draft') throw forbidden('Autoren können nicht selbst veröffentlichen – reiche den Entwurf zur Prüfung ein');
    const { published_at: _ignored, ...rest } = data;
    return rest;
  }

  link(path) {
    return `${this.config.baseUrl}/admin/#${path}`;
  }

  async notify(recipients, subject, html) {
    const results = await Promise.allSettled(recipients.map((u) => this.systemMail.send({ to: u.email, subject, html })));
    for (const r of results) if (r.status === 'rejected') this.logger.warn(`[review] Benachrichtigung fehlgeschlagen: ${r.reason?.message}`);
    return results.filter((r) => r.status === 'fulfilled').length;
  }

  /** Entwurf zur Prüfung einreichen; alle Redakteure und Administratoren erhalten eine E-Mail. */
  async submit(req, { table, item, kind, editPath }) {
    this.assertCanEdit(req, item);
    if (item.status !== 'draft') throw badRequest('Nur Entwürfe können zur Prüfung eingereicht werden');
    this.db.run(`UPDATE ${table} SET review_requested_at = ?, review_note = '' WHERE id = ?`, now(), item.id);
    const editors = this.db.all("SELECT email FROM users WHERE role IN ('admin', 'editor') AND id != ?", req.user?.id ?? 0);
    const by = escapeHtml(req.user?.name || req.user?.email || 'Ein Autor');
    const notified = await this.notify(
      editors,
      `Zur Prüfung: ${item.title}`,
      `<p>${by} hat ${kind} <strong>„${escapeHtml(item.title)}“</strong> zur Prüfung eingereicht.</p>
       <p>Bitte prüfe den Entwurf und veröffentliche ihn oder gib ihn mit einem Hinweis zurück.</p>
       ${this.systemMail.button(this.link(editPath), 'Entwurf öffnen')}`,
    );
    return { notified };
  }

  /** Eingereichten Entwurf mit Hinweis an den Autor zurückgeben. */
  async decline(req, { table, item, kind, editPath, note }) {
    if (isAuthor(req)) throw forbidden();
    if (!item.review_requested_at) throw badRequest('Dieser Inhalt wurde nicht zur Prüfung eingereicht');
    const text = String(note ?? '').trim().slice(0, 2000);
    this.db.run(`UPDATE ${table} SET review_requested_at = NULL, review_note = ? WHERE id = ?`, text, item.id);
    const author = item.author_id && this.db.get('SELECT email FROM users WHERE id = ?', item.author_id);
    if (!author) return { notified: 0 };
    const notified = await this.notify(
      [author],
      `Überarbeitung erbeten: ${item.title}`,
      `<p>Dein Entwurf für ${kind} <strong>„${escapeHtml(item.title)}“</strong> wurde zur Überarbeitung zurückgegeben.</p>
       ${text ? `<blockquote style="margin:0 0 16px;padding:8px 14px;border-left:3px solid #d1d5db;color:#4b5563;">${escapeHtml(text).replace(/\n/g, '<br>')}</blockquote>` : ''}
       ${this.systemMail.button(this.link(editPath), 'Entwurf bearbeiten')}`,
    );
    return { notified };
  }

  /** Nach dem Veröffentlichen ist die Prüfung erledigt; der Autor erfährt davon. */
  async published(req, { table, item, kind, url }) {
    if (!item.review_requested_at) return;
    this.db.run(`UPDATE ${table} SET review_requested_at = NULL, review_note = '' WHERE id = ?`, item.id);
    const author = item.author_id && item.author_id !== req.user?.id && this.db.get('SELECT email FROM users WHERE id = ?', item.author_id);
    if (!author) return;
    await this.notify(
      [author],
      `Veröffentlicht: ${item.title}`,
      `<p>Dein Entwurf für ${kind} <strong>„${escapeHtml(item.title)}“</strong> wurde freigegeben und veröffentlicht.</p>${url ? this.systemMail.button(url, 'Ansehen') : ''}`,
    );
  }
}
