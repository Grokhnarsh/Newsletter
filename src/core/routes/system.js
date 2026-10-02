import { Router } from 'express';
import { parseId, validate } from '../../lib/validate.js';
import { requireAdmin } from '../../middleware/auth.js';

/** Systemrouten des Kerns: Module, Benutzer, API-Schlüssel, Einstellungen. */
export function systemRoutes(ctx) {
  const { users, settings, modules, content, mailer, hooks } = ctx;
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
    role: { type: 'enum', values: ['admin', 'editor'], default: 'editor' },
  };

  router.get('/users', requireAdmin, (req, res) => res.json(users.list()));

  router.post('/users', requireAdmin, (req, res) => {
    res.status(201).json(users.create(validate(req.body, userSchema)));
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
