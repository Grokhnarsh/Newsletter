import { Router } from 'express';
import { forbidden } from '../../lib/errors.js';
import { rateLimit } from '../../lib/rateLimit.js';
import { validate } from '../../lib/validate.js';
import { requireSession } from '../../middleware/auth.js';

export function authRoutes({ users, settings, hooks }, authenticate) {
  const router = Router();
  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, message: 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.' });

  router.get('/status', (req, res) => {
    res.json({ needs_setup: users.count() === 0 });
  });

  // Ersteinrichtung: legt das erste Administratorkonto an (nur solange keine Benutzer existieren).
  router.post('/setup', loginLimiter, (req, res) => {
    if (users.count() > 0) throw forbidden('Die Einrichtung wurde bereits abgeschlossen');
    const data = validate(req.body, {
      email: { type: 'email', required: true },
      name: { type: 'string', max: 200 },
      password: { type: 'string', required: true, min: 10, max: 200, trim: false },
      site_name: { type: 'string', max: 200 },
    });
    const user = users.create({ ...data, role: 'admin' });
    if (data.site_name) settings.update({ site_name: data.site_name });
    // Module legen Standardinhalte an (Listen, Vorlagen, Startseite, Menü …)
    hooks.collect('system.setup', { user });
    res.status(201).json({ token: users.createSession(user.id), user });
  });

  router.post('/login', loginLimiter, (req, res) => {
    const { email, password } = validate(req.body, {
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, trim: false },
    });
    const row = users.verifyCredentials(email, password);
    res.json({ token: users.createSession(row.id), user: users.find(row.id) });
  });

  router.post('/logout', authenticate, requireSession, (req, res) => {
    users.destroySession(req.auth.token);
    res.status(204).end();
  });

  router.get('/me', authenticate, requireSession, (req, res) => {
    res.json(users.find(req.user.id));
  });

  router.put('/me', authenticate, requireSession, (req, res) => {
    const data = validate(
      req.body,
      {
        name: { type: 'string', max: 200 },
        email: { type: 'email' },
        current_password: { type: 'string', trim: false },
        new_password: { type: 'string', min: 10, max: 200, trim: false },
      },
      { partial: true },
    );
    if (data.new_password) {
      users.changeOwnPassword(req.user.id, data.current_password || '', data.new_password);
      users.destroyUserSessions(req.user.id, req.auth.token);
    }
    res.json(users.update(req.user.id, { name: data.name, email: data.email }));
  });

  return router;
}
