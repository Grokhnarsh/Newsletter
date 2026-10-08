import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import { slugify } from '../../core/content.js';
import { toCsv } from '../../lib/csv.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { FixedWindowCounter } from '../../lib/rateLimit.js';
import { escapeHtml } from '../../lib/render.js';
import { randomToken } from '../../lib/security.js';
import { now } from '../../lib/time.js';
import { isEmail, normalizeEmail, pagination, parseId, validate } from '../../lib/validate.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
export const FIELD_TYPES = ['text', 'email', 'textarea', 'tel', 'number', 'date', 'select', 'radio', 'checkbox', 'consent'];
const MIN_FILL_SECONDS = 3;
const MAX_FORM_AGE_HOURS = 48;

/** Prüft und vereinheitlicht die Felddefinitionen eines Formulars. */
export function cleanFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw badRequest('Ein Formular braucht mindestens ein Feld');
  if (fields.length > 50) throw badRequest('Höchstens 50 Felder');
  const names = new Set();
  return fields.map((f, i) => {
    const type = FIELD_TYPES.includes(f?.type) ? f.type : 'text';
    const label = String(f?.label ?? '').trim().slice(0, 300);
    if (!label) throw badRequest(`Feld ${i + 1}: Beschriftung fehlt`);
    let name = slugify(f.name || label).replace(/-/g, '_').slice(0, 40) || `feld_${i + 1}`;
    while (names.has(name)) name = `${name}_${i + 1}`;
    names.add(name);
    const options = ['select', 'radio'].includes(type)
      ? [...new Set((Array.isArray(f.options) ? f.options : String(f.options ?? '').split('\n')).map((o) => String(o).trim()).filter(Boolean))].slice(0, 50)
      : [];
    if (['select', 'radio'].includes(type) && !options.length) throw badRequest(`Feld „${label}“: Auswahloptionen fehlen`);
    return {
      name,
      label,
      type,
      required: type === 'consent' ? true : Boolean(f.required),
      placeholder: String(f.placeholder ?? '').slice(0, 200),
      help: String(f.help ?? '').slice(0, 300),
      options,
    };
  });
}

export class FormService {
  constructor({ db, settings }) {
    this.db = db;
    this.settings = settings;
  }

  shape(row) {
    return row && { ...row, fields: JSON.parse(row.fields), store: Boolean(row.store), newsletter_optin: Boolean(row.newsletter_optin) };
  }

  list() {
    return this.db
      .all(
        `SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS submission_count,
           (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id AND s.read_at IS NULL) AS unread_count
         FROM forms f ORDER BY f.name`,
      )
      .map((r) => this.shape(r));
  }

  find(id) {
    const row = this.db.get('SELECT * FROM forms WHERE id = ?', id);
    if (!row) throw notFound('Formular nicht gefunden');
    return this.shape(row);
  }

  save(id, data) {
    const fields = JSON.stringify(cleanFields(data.fields));
    const emails = String(data.notify_emails ?? '')
      .split(/[,;\s]+/)
      .map(normalizeEmail)
      .filter(Boolean);
    if (emails.some((e) => !isEmail(e))) throw badRequest('Validierung fehlgeschlagen', { notify_emails: 'Ungültige E-Mail-Adresse' });
    const values = [
      data.name,
      fields,
      data.submit_label || 'Absenden',
      data.success_message || 'Vielen Dank! Deine Nachricht ist bei uns angekommen.',
      emails.join(', '),
      data.store === false ? 0 : 1,
      data.newsletter_optin ? 1 : 0,
      data.newsletter_list_id || null,
      now(),
    ];
    if (id) {
      this.find(id);
      this.db.run(
        `UPDATE forms SET name = ?, fields = ?, submit_label = ?, success_message = ?, notify_emails = ?, store = ?,
           newsletter_optin = ?, newsletter_list_id = ?, updated_at = ? WHERE id = ?`,
        ...values,
        id,
      );
      return this.find(id);
    }
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO forms (name, fields, submit_label, success_message, notify_emails, store, newsletter_optin, newsletter_list_id, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      now(),
    );
    return this.find(lastInsertRowid);
  }

  remove(id) {
    this.find(id);
    this.db.run('DELETE FROM forms WHERE id = ?', id);
  }

  // ---- Einsendungen ----

  addSubmission(formId, { data, email, ip, userAgent, page }) {
    this.purge();
    const { lastInsertRowid } = this.db.run(
      'INSERT INTO form_submissions (form_id, data, email, ip, user_agent, page, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      formId,
      JSON.stringify(data),
      email || null,
      ip || null,
      String(userAgent || '').slice(0, 300),
      page || null,
      now(),
    );
    return lastInsertRowid;
  }

  submissions(formId, { unread }, { page, perPage, offset }) {
    const where = ['form_id = ?'];
    if (unread === '1' || unread === true) where.push('read_at IS NULL');
    const sql = `WHERE ${where.join(' AND ')}`;
    const total = this.db.get(`SELECT COUNT(*) AS n FROM form_submissions ${sql}`, formId).n;
    const items = this.db
      .all(`SELECT * FROM form_submissions ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`, formId, perPage, offset)
      .map((s) => ({ ...s, data: JSON.parse(s.data) }));
    return { items, total, page, per_page: perPage, pages: Math.max(1, Math.ceil(total / perPage)) };
  }

  markRead(formId, ids, read = true) {
    for (const id of ids) {
      this.db.run('UPDATE form_submissions SET read_at = ? WHERE id = ? AND form_id = ?', read ? now() : null, id, formId);
    }
  }

  deleteSubmissions(formId, ids) {
    for (const id of ids) this.db.run('DELETE FROM form_submissions WHERE id = ? AND form_id = ?', id, formId);
  }

  exportCsv(formId) {
    const form = this.find(formId);
    const rows = this.db.all('SELECT * FROM form_submissions WHERE form_id = ? ORDER BY id', formId);
    const header = ['Eingang', ...form.fields.map((f) => f.label), 'Seite'];
    return toCsv(
      header,
      rows.map((r) => {
        const data = JSON.parse(r.data);
        return [r.created_at, ...form.fields.map((f) => (Array.isArray(data[f.name]) ? data[f.name].join(', ') : data[f.name] ?? '')), r.page || ''];
      }),
    );
  }

  /** Datensparsamkeit: alte Einsendungen nach der eingestellten Frist löschen. */
  purge() {
    const days = this.settings.get('forms_retention_days');
    if (!days) return;
    this.db.run('DELETE FROM form_submissions WHERE created_at < ?', new Date(Date.now() - days * 86400_000).toISOString());
  }

  // ---- Spamschutz: signierter Zeitstempel ----

  secret() {
    let s = this.settings.getInternal('forms_secret');
    if (!s) {
      s = randomToken(32);
      this.settings.setInternal('forms_secret', s);
    }
    return s;
  }

  stamp(formId) {
    const ts = Date.now();
    const sig = crypto.createHmac('sha256', this.secret()).update(`${formId}:${ts}`).digest('base64url').slice(0, 22);
    return `${ts}.${sig}`;
  }

  /** true, wenn das Formular von dieser Website stammt und nicht zu schnell abgeschickt wurde. */
  checkStamp(formId, value) {
    const [ts, sig] = String(value ?? '').split('.');
    const expected = crypto.createHmac('sha256', this.secret()).update(`${formId}:${ts}`).digest('base64url').slice(0, 22);
    if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const age = Date.now() - Number(ts);
    return age >= MIN_FILL_SECONDS * 1000 && age <= MAX_FORM_AGE_HOURS * 3600_000;
  }
}

// ---- Darstellung ----

function fieldHtml(form, f, value, error) {
  const id = `f${form.id}-${f.name}`;
  const req = f.required ? ' required' : '';
  const star = f.required && f.type !== 'consent' ? ' <span aria-hidden="true">*</span>' : '';
  const err = error ? `<div class="field-error" id="${id}-err">${escapeHtml(error)}</div>` : '';
  const aria = error ? ` aria-invalid="true" aria-describedby="${id}-err"` : '';
  const help = f.help ? `<div class="muted small">${escapeHtml(f.help)}</div>` : '';
  const v = value ?? '';
  const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : '';
  switch (f.type) {
    case 'textarea':
      return `<div class="form-field"><label for="${id}">${escapeHtml(f.label)}${star}</label><textarea id="${id}" name="${f.name}" rows="5"${ph}${req}${aria}>${escapeHtml(v)}</textarea>${help}${err}</div>`;
    case 'select':
      return `<div class="form-field"><label for="${id}">${escapeHtml(f.label)}${star}</label><select id="${id}" name="${f.name}"${req}${aria}><option value="">Bitte wählen …</option>${f.options
        .map((o) => `<option${o === v ? ' selected' : ''}>${escapeHtml(o)}</option>`)
        .join('')}</select>${help}${err}</div>`;
    case 'radio':
      return `<fieldset class="form-field"><legend>${escapeHtml(f.label)}${star}</legend>${f.options
        .map((o, i) => `<label class="check"><input type="radio" name="${f.name}" value="${escapeHtml(o)}"${o === v ? ' checked' : ''}${i === 0 ? req : ''}> ${escapeHtml(o)}</label>`)
        .join('')}${help}${err}</fieldset>`;
    case 'checkbox':
    case 'consent':
      return `<div class="form-field"><label class="check"><input type="checkbox" id="${id}" name="${f.name}" value="ja"${v ? ' checked' : ''}${req}${aria}> <span>${escapeHtml(f.label)}${star}</span></label>${help}${err}</div>`;
    default: {
      const type = { email: 'email', tel: 'tel', number: 'number', date: 'date' }[f.type] || 'text';
      const ac = { email: ' autocomplete="email"', tel: ' autocomplete="tel"' }[f.type] || '';
      return `<div class="form-field"><label for="${id}">${escapeHtml(f.label)}${star}</label><input id="${id}" type="${type}" name="${f.name}" value="${escapeHtml(v)}"${ph}${ac}${req}${aria}>${help}${err}</div>`;
    }
  }
}

export function renderForm(ctx, form, { values = {}, errors = {}, page = '', message = '' } = {}) {
  const newsletter = form.newsletter_optin && ctx.modules.isEnabled('newsletter');
  const privacy = ctx.settings.get('privacy_url');
  return `<form class="cms-form" id="form-${form.id}" method="post" action="/formular/${form.id}" novalidate>
  ${message ? `<p class="form-message err" role="alert">${escapeHtml(message)}</p>` : ''}
  ${form.fields.map((f) => fieldHtml(form, f, values[f.name], errors[f.name])).join('\n  ')}
  ${
    newsletter
      ? `<div class="form-field"><label class="check"><input type="checkbox" name="_newsletter" value="1"${values._newsletter ? ' checked' : ''}> <span>Ich möchte zusätzlich den Newsletter erhalten (Bestätigung per E-Mail, jederzeit abbestellbar).</span></label></div>`
      : ''
  }
  <input type="hidden" name="_page" value="${escapeHtml(page)}">
  <input type="hidden" name="_ts" value="${escapeHtml(ctx.forms.stamp(form.id))}">
  <div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <button type="submit">${escapeHtml(form.submit_label)}</button>
  ${privacy ? `<p class="muted small">Hinweise zur Verarbeitung deiner Daten findest du in der <a href="${escapeHtml(privacy)}">Datenschutzerklärung</a>.</p>` : ''}
</form>`;
}

/** Prüft die Eingaben gegen die Felddefinition. */
export function validateSubmission(form, body) {
  const values = {};
  const errors = {};
  for (const f of form.fields) {
    let v = body[f.name];
    if (Array.isArray(v)) v = v[0];
    v = String(v ?? '').trim().slice(0, f.type === 'textarea' ? 10000 : 1000);
    if (['checkbox', 'consent'].includes(f.type)) v = v ? 'ja' : '';
    values[f.name] = v;
    if (!v) {
      if (f.required) errors[f.name] = f.type === 'consent' ? 'Bitte bestätigen' : 'Bitte ausfüllen';
      continue;
    }
    if (f.type === 'email' && !isEmail(normalizeEmail(v))) errors[f.name] = 'Bitte eine gültige E-Mail-Adresse angeben';
    if (f.type === 'number' && !Number.isFinite(Number(v))) errors[f.name] = 'Bitte eine Zahl angeben';
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.name] = 'Bitte ein Datum angeben';
    if (['select', 'radio'].includes(f.type) && !f.options.includes(v)) errors[f.name] = 'Ungültige Auswahl';
    if (f.type === 'email') values[f.name] = normalizeEmail(v);
  }
  values._newsletter = body._newsletter === '1';
  return { values, errors };
}

const formSchema = {
  name: { type: 'string', required: true, max: 200 },
  fields: { type: 'array' },
  submit_label: { type: 'string', max: 100 },
  success_message: { type: 'string', max: 1000 },
  notify_emails: { type: 'string', max: 1000 },
  store: { type: 'bool', default: true },
  newsletter_optin: { type: 'bool', default: false },
  newsletter_list_id: { type: 'int', min: 1 },
};

export default {
  name: 'forms',
  label: 'Formulare',
  description: 'Kontakt- und Anfrageformulare mit Spamschutz, E-Mail-Benachrichtigung, Einsendungen und Newsletter-Opt-in.',
  version: '1.0.0',
  adminDir: path.join(dir, 'admin'),
  settings: {
    defaults: { forms_retention_days: 180 },
    rules: { forms_retention_days: { type: 'int', min: 0, max: 3650 } },
  },
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE forms (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          fields TEXT NOT NULL DEFAULT '[]',
          submit_label TEXT NOT NULL DEFAULT 'Absenden',
          success_message TEXT NOT NULL DEFAULT '',
          notify_emails TEXT NOT NULL DEFAULT '',
          store INTEGER NOT NULL DEFAULT 1,
          newsletter_optin INTEGER NOT NULL DEFAULT 0,
          newsletter_list_id INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE form_submissions (
          id INTEGER PRIMARY KEY,
          form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
          data TEXT NOT NULL,
          email TEXT,
          ip TEXT,
          user_agent TEXT,
          page TEXT,
          read_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_form_submissions_form ON form_submissions(form_id, id);
      `,
    },
  ],

  setup(ctx) {
    ctx.forms = new FormService(ctx);
    const opts = { module: 'forms' };
    ctx.hooks.on('site.reserved', () => ['formular'], opts);
    ctx.hooks.on('admin.dashboard', () => ({ forms: { unread: ctx.db.get('SELECT COUNT(*) AS n FROM form_submissions WHERE read_at IS NULL').n } }), opts);
    ctx.content.registerShortcode(
      'form',
      (attrs, req) => {
        const id = Number(attrs.id);
        const form = id && ctx.db.get('SELECT * FROM forms WHERE id = ?', id);
        if (!form) return '';
        const f = ctx.forms.shape(form);
        if (String(req?.query?.formular) === String(f.id)) {
          return `<div class="form-success" id="form-${f.id}" role="status"><p>${escapeHtml(f.success_message)}</p></div>`;
        }
        return renderForm(ctx, f, { page: req?.originalUrl?.split('?')[0] || req?.path || '' });
      },
      { module: 'forms', description: 'Formular einbinden', example: '[form id="1"]' },
    );
    // Beispiel-Kontaktformular und Kontaktseite bei der Ersteinrichtung
    ctx.hooks.on(
      'system.setup',
      ({ user }) => {
        if (ctx.db.get('SELECT COUNT(*) AS n FROM forms').n > 0) return;
        const form = ctx.forms.save(null, {
          name: 'Kontakt',
          fields: [
            { label: 'Name', type: 'text', required: true },
            { label: 'E-Mail', type: 'email', required: true },
            { label: 'Nachricht', type: 'textarea', required: true },
            { label: 'Ich bin mit der Verarbeitung meiner Angaben zur Beantwortung der Anfrage einverstanden.', type: 'consent' },
          ],
          notify_emails: user?.email || '',
        });
        if (ctx.modules.isEnabled('pages') && ctx.pages && !ctx.db.get("SELECT 1 FROM pages WHERE slug = 'kontakt' AND parent_id IS NULL")) {
          ctx.pages.create({ title: 'Kontakt', status: 'published', position: 5, content: `<p>Schreib uns – wir melden uns schnellstmöglich.</p>\n<p>[form id="${form.id}"]</p>` }, user?.id);
        }
      },
      { ...opts, priority: 20 },
    );
  },

  api(router, ctx) {
    const r = Router();
    r.get('/', (req, res) => res.json(ctx.forms.list()));
    r.post('/', (req, res) => res.status(201).json(ctx.forms.save(null, validate(req.body, formSchema))));
    r.get('/:id', (req, res) => res.json(ctx.forms.find(parseId(req.params.id))));
    r.put('/:id', (req, res) => res.json(ctx.forms.save(parseId(req.params.id), validate(req.body, formSchema))));
    r.delete('/:id', (req, res) => {
      ctx.forms.remove(parseId(req.params.id));
      res.status(204).end();
    });
    r.get('/:id/submissions', (req, res) => {
      const id = parseId(req.params.id);
      ctx.forms.find(id);
      res.json(ctx.forms.submissions(id, req.query, pagination(req.query, { defaultPerPage: 50 })));
    });
    r.post('/:id/submissions/read', (req, res) => {
      const { ids, read } = validate(req.body, { ids: { type: 'ids', required: true }, read: { type: 'bool', default: true } });
      ctx.forms.markRead(parseId(req.params.id), ids, read);
      res.json({ ok: true });
    });
    r.post('/:id/submissions/delete', (req, res) => {
      const { ids } = validate(req.body, { ids: { type: 'ids', required: true } });
      ctx.forms.deleteSubmissions(parseId(req.params.id), ids);
      res.json({ ok: true });
    });
    r.get('/:id/export', (req, res) => {
      const id = parseId(req.params.id);
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="formular-${id}-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(`﻿${ctx.forms.exportCsv(id)}`);
    });
    router.use('/forms', r);
  },

  publicRoutes(router, ctx) {
    const parse = express.urlencoded({ extended: false, limit: '50kb' });
    const perIp = new FixedWindowCounter(60 * 60_000);

    router.post('/formular/:id', parse, async (req, res, next) => {
      const id = Number(req.params.id);
      const row = Number.isInteger(id) && ctx.db.get('SELECT * FROM forms WHERE id = ?', id);
      if (!row) return next();
      const form = ctx.forms.shape(row);
      const body = req.body || {};
      const page = typeof body._page === 'string' && /^\/(?!\/)[^\s]*$/.test(body._page) ? body._page.slice(0, 300) : '';
      const done = () => {
        if (page) return res.redirect(303, `${page}?formular=${form.id}#form-${form.id}`);
        ctx.site.message(req, res, { title: 'Vielen Dank', message: form.success_message, tone: 'ok' });
      };

      // Spamschutz: Honigtopf, signierter Zeitstempel, Begrenzung pro IP – Bots erhalten scheinbar Erfolg
      if (body.website || !ctx.forms.checkStamp(form.id, body._ts)) return done();
      if (perIp.hit(req.ip) > 20) {
        return ctx.site.message(req, res, { title: 'Zu viele Anfragen', message: 'Bitte versuche es später erneut.', tone: 'err', status: 429 });
      }

      const { values, errors } = validateSubmission(form, body);
      if (Object.keys(errors).length) {
        return ctx.site.send(req, res, {
          title: form.name,
          status: 422,
          noindex: true,
          bodyClass: 'narrow',
          content: `<div class="panel"><h1>${escapeHtml(form.name)}</h1>${renderForm(ctx, form, { values, errors, page, message: 'Bitte prüfe die markierten Felder.' })}</div>`,
        });
      }

      const emailField = form.fields.find((f) => f.type === 'email');
      const email = emailField ? values[emailField.name] : null;
      const data = Object.fromEntries(form.fields.map((f) => [f.name, values[f.name]]));
      if (form.store) ctx.forms.addSubmission(form.id, { data, email, ip: req.ip, userAgent: req.get('user-agent'), page });

      if (form.notify_emails) {
        const rows = form.fields
          .map((f) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;">${escapeHtml(f.label)}</td><td style="padding:6px 0;white-space:pre-wrap;">${escapeHtml(values[f.name] || '–')}</td></tr>`)
          .join('');
        for (const to of form.notify_emails.split(/,\s*/)) {
          ctx.systemMail
            .send({
              to,
              replyTo: email || undefined,
              subject: `Neue Anfrage: ${form.name}`,
              html: `<p>Über das Formular <strong>${escapeHtml(form.name)}</strong>${page ? ` auf ${escapeHtml(page)}` : ''} ist eine neue Einsendung eingegangen:</p><table>${rows}</table>${
                form.store ? `<p style="color:#6b7280;font-size:13px;">Alle Einsendungen findest du im Admin-Bereich unter Formulare.</p>` : ''
              }`,
            })
            .catch((err) => ctx.logger.error('[forms] Benachrichtigung fehlgeschlagen:', err.message));
        }
      }

      // Optional: Newsletter-Anmeldung mit Double-Opt-in
      if (values._newsletter && email && form.newsletter_optin && ctx.modules.isEnabled('newsletter') && ctx.subscribers) {
        try {
          const publicIds = ctx.lists.list({ publicOnly: true }).map((l) => l.id);
          const listIds = form.newsletter_list_id ? [form.newsletter_list_id] : publicIds;
          const nameField = form.fields.find((f) => /name/.test(f.name));
          const { subscriber, action } = ctx.subscribers.publicSubscribe(
            { email, first_name: nameField ? String(values[nameField.name]).split(' ')[0] : '', list_ids: listIds },
            { ip: req.ip, doubleOptIn: true, source: `form:${form.id}` },
          );
          if (action === 'confirm') await ctx.delivery.sendConfirmation(subscriber);
        } catch (err) {
          ctx.logger.error('[forms] Newsletter-Anmeldung fehlgeschlagen:', err.message);
        }
      }
      done();
    });
  },
};
