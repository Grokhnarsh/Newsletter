import { Router } from 'express';
import { escapeHtml } from '../../lib/render.js';
import { randomToken } from '../../lib/security.js';
import { pagination, parseId, validate } from '../../lib/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import { ROLES } from '../users.js';

/** Systemrouten des Kerns: Module, Benutzer, API-Schlüssel, Einstellungen. */
export function systemRoutes(ctx) {
  const { users, settings, modules, content, mailer, hooks, audit, systemMail, config, backups } = ctx;
  const router = Router();

  // ---- Module ----
  router.get('/system/modules', (req, res) => res.json(modules.describe()));

  router.put('/system/modules/:name', requireAdmin, (req, res) => {
    const { enabled } = validate(req.body, { enabled: { type: 'bool', required: true } });
    modules.setEnabled(req.params.name, enabled);
    res.json(modules.describe());
  });

  router.get('/system/shortcodes', (req, res) => res.json(content.listShortcodes()));

  // Kennzahlen aller aktiven Module für das Dashboard
  router.get('/system/dashboard', (req, res) => {
    res.json(Object.assign({}, ...hooks.collect('admin.dashboard', req)));
  });

  // ---- Benutzer ----
  const userSchema = {
    email: { type: 'email', required: true },
    name: { type: 'string', max: 200 },
    password: { type: 'string', required: true, min: 10, max: 200, trim: false },
    role: { type: 'enum', values: ROLES, default: 'editor' },
  };

  router.get('/users', requireAdmin, (req, res) => res.json(users.list()));

  const sendAccessLink = (user) => {
    const url = `${config.baseUrl}/admin/#/reset/${users.createPasswordReset(user.id)}`;
    return systemMail.send({
      to: user.email,
      subject: `Zugang zu ${settings.get('site_name')}`,
      html: `<p>Hallo ${escapeHtml(user.name || '')},</p>
<p>über diesen Link kannst du innerhalb von 60 Minuten ein (neues) Passwort für deinen Zugang festlegen:</p>
${systemMail.button(url, 'Passwort festlegen')}
<p style="color:#6b7280;font-size:13px;">Anmeldung danach unter ${escapeHtml(config.baseUrl)}/admin/</p>`,
    });
  };

  // Mit `invite: true` wird kein Passwort benötigt – der Benutzer legt es selbst per Link fest.
  router.post('/users', requireAdmin, async (req, res) => {
    const invite = req.body?.invite === true;
    const schema = invite ? { ...userSchema, password: { ...userSchema.password, required: false } } : userSchema;
    const data = validate(req.body, schema);
    const user = users.create({ ...data, password: data.password || randomToken(32) });
    if (invite) await sendAccessLink(user);
    res.status(201).json(user);
  });

  router.put('/users/:id', requireAdmin, (req, res) => {
    const data = validate(req.body, { ...userSchema, password: { ...userSchema.password, required: false } }, { partial: true });
    const id = parseId(req.params.id);
    const user = users.update(id, data);
    if (data.password) users.destroyUserSessions(id);
    res.json(user);
  });

  router.delete('/users/:id', requireAdmin, (req, res) => {
    users.remove(parseId(req.params.id), req.user.id);
    res.status(204).end();
  });

  // Zwei-Faktor-Anmeldung eines Kontos zurücksetzen (z. B. Gerät verloren)
  router.post('/users/:id/reset-2fa', requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    users.find(id);
    users.disableTotp(id);
    users.destroyUserSessions(id);
    res.json(users.find(id));
  });

  // Link zum Festlegen eines neuen Passworts per E-Mail schicken
  router.post('/users/:id/send-reset', requireAdmin, async (req, res) => {
    await sendAccessLink(users.find(parseId(req.params.id)));
    res.json({ ok: true });
  });

  // ---- Backups ----
  router.get('/system/backups', requireAdmin, (req, res) => res.json(backups.list()));

  router.post('/system/backups', requireAdmin, async (req, res) => {
    res.status(201).json(await backups.createFile());
  });

  // Direkter Download eines frischen Backups (ohne Speichern auf dem Server)
  router.get('/system/backup', requireAdmin, async (req, res) => {
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${backups.fileName()}"`);
    audit.log(req, 'backup_download', 'live');
    await backups.write(res);
    res.end();
  });

  router.get('/system/backups/:name', requireAdmin, (req, res) => {
    const file = backups.pathFor(req.params.name);
    audit.log(req, 'backup_download', req.params.name);
    res.download(file, req.params.name);
  });

  router.delete('/system/backups/:name', requireAdmin, (req, res) => {
    backups.remove(req.params.name);
    res.status(204).end();
  });

  // ---- Änderungsprotokoll ----
  router.get('/system/audit', requireAdmin, (req, res) => {
    res.json(audit.list(req.query, pagination(req.query, { defaultPerPage: 50 })));
  });

  // ---- API-Schlüssel ----
  router.get('/api-keys', requireAdmin, (req, res) => res.json(users.listApiKeys()));

  router.post('/api-keys', requireAdmin, (req, res) => {
    const { name } = validate(req.body, { name: { type: 'string', required: true, max: 100 } });
    res.status(201).json(users.createApiKey(name, req.user.id));
  });

  router.delete('/api-keys/:id', requireAdmin, (req, res) => {
    users.deleteApiKey(parseId(req.params.id));
    res.status(204).end();
  });

  // ---- Einstellungen (Kern + alle Module) ----
  router.get('/settings', (req, res) => {
    res.json({ ...settings.all(), mail_transport: mailer.kind });
  });

  router.put('/settings', requireAdmin, (req, res) => {
    const data = validate(req.body, settings.rules, { partial: true });
    hooks.collect('settings.validate', data);
    res.json({ ...settings.update(data), mail_transport: mailer.kind });
  });

  return router;
}
