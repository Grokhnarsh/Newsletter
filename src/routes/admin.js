import { Router } from 'express';
import { parseId, validate } from '../lib/validate.js';
import { requireAdmin } from '../middleware/auth.js';

/** Benutzer, API-Schlüssel, Einstellungen und Statistik. */
export function adminRoutes({ users, settings, delivery, stats, mailer, templates }) {
  const router = Router();

  // ---- Statistik ----
  router.get('/stats/overview', (req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    res.json(stats.overview({ days }));
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

  // ---- Einstellungen ----
  router.get('/settings', (req, res) => {
    res.json({ ...settings.all(), mail_transport: mailer.kind });
  });

  router.put('/settings', requireAdmin, (req, res) => {
    const data = validate(req.body, settings.rules, { partial: true });
    if (data.default_template_id) templates.find(data.default_template_id);
    res.json({ ...settings.update(data), mail_transport: mailer.kind });
  });

  router.post('/settings/test-email', requireAdmin, async (req, res) => {
    const { to } = validate(req.body, { to: { type: 'email', required: true } });
    try {
      await mailer.verify();
      await delivery.sendSettingsTest(to);
      res.json({ ok: true, message: `Testnachricht an ${to} gesendet` });
    } catch (err) {
      res.status(502).json({ error: `Versand fehlgeschlagen: ${err.message}` });
    }
  });

  return router;
}
