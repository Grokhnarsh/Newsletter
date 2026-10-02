import crypto from 'node:crypto';
import { Router } from 'express';
import { badRequest, forbidden, HttpError } from '../../lib/errors.js';
import { FixedWindowCounter, rateLimit } from '../../lib/rateLimit.js';
import { validate } from '../../lib/validate.js';
import { requireSession } from '../../middleware/auth.js';

const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_IP = 20;
const MAX_FAILURES_PER_ACCOUNT = 10;
const TOO_MANY = 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.';

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function authRoutes({ users, settings, hooks, setupToken }, authenticate) {
  const router = Router();
  const setupLimiter = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: 20, message: TOO_MANY });
  // Gezählt werden nur Fehlversuche – pro IP und pro Konto (hilft auch, wenn die IP gefälscht wird).
  const ipFailures = new FixedWindowCounter(LOGIN_WINDOW_MS);
  const accountFailures = new FixedWindowCounter(LOGIN_WINDOW_MS);

  router.get('/status', (req, res) => {
    res.json({ needs_setup: users.count() === 0 });
  });

  // Ersteinrichtung: legt das erste Administratorkonto an (nur solange keine Benutzer existieren).
  router.post('/setup', setupLimiter, (req, res) => {
    if (users.count() > 0) throw forbidden('Die Einrichtung wurde bereits abgeschlossen');
    const data = validate(req.body, {
      email: { type: 'email', required: true },
      name: { type: 'string', max: 200 },
      password: { type: 'string', required: true, min: 10, max: 200, trim: false },
      site_name: { type: 'string', max: 200 },
      setup_token: { type: 'string', required: true, max: 200 },
    });
    if (!sameSecret(data.setup_token, setupToken)) {
      throw badRequest('Validierung fehlgeschlagen', { setup_token: 'Einrichtungscode ist falsch (steht im Server-Log)' });
    }
    const user = users.create({ email: data.email, name: data.name, password: data.password, role: 'admin' });
    if (data.site_name) settings.update({ site_name: data.site_name });
    // Module legen Standardinhalte an (Listen, Vorlagen, Startseite, Menü …)
    hooks.collect('system.setup', { user });
    res.status(201).json({ token: users.createSession(user.id), user });
  });

  router.post('/login', (req, res) => {
    const { email, password } = validate(req.body, {
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, trim: false },
    });
    for (const [counter, key, max] of [
      [ipFailures, req.ip, MAX_FAILURES_PER_IP],
      [accountFailures, email, MAX_FAILURES_PER_ACCOUNT],
    ]) {
      if (counter.count(key) >= max) {
        res.set('Retry-After', String(counter.retryAfter(key)));
        throw new HttpError(429, TOO_MANY);
      }
    }
    let row;
    try {
      row = users.verifyCredentials(email, password);
    } catch (err) {
      ipFailures.hit(req.ip);
      accountFailures.hit(email);
      throw err;
    }
    accountFailures.reset(email);
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
    // Neue Anmeldeadresse nur mit aktuellem Passwort (Schutz bei kurz offener Sitzung)
    if (data.email && data.email !== req.user.email && !data.new_password) {
      users.checkPassword(req.user.id, data.current_password || '');
    }
    if (data.new_password) {
      users.changeOwnPassword(req.user.id, data.current_password || '', data.new_password);
      users.destroyUserSessions(req.user.id, req.auth.token);
    }
    res.json(users.update(req.user.id, { name: data.name, email: data.email }));
  });

  return router;
}
