import crypto from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode-svg';
import { badRequest, forbidden, HttpError, unauthorized } from '../../lib/errors.js';
import { FixedWindowCounter, rateLimit } from '../../lib/rateLimit.js';
import { escapeHtml } from '../../lib/render.js';
import { validate } from '../../lib/validate.js';
import { clearSessionCookie, requireSession, setSessionCookie } from '../../middleware/auth.js';
import { otpauthUrl } from '../totp.js';

const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_IP = 20;
const MAX_FAILURES_PER_ACCOUNT = 10;
const TOO_MANY = 'Zu viele Anmeldeversuche. Bitte in 15 Minuten erneut versuchen.';
const PASSWORD = { type: 'string', required: true, min: 10, max: 200, trim: false };

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function authRoutes(ctx, authenticate) {
  const { users, settings, hooks, setupToken, config, audit, systemMail, logger } = ctx;
  const router = Router();
  const setupLimiter = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: 20, message: TOO_MANY });
  const forgotLimiter = rateLimit({ windowMs: 60 * 60_000, max: 10 });
  // Gezählt werden nur Fehlversuche – pro IP und pro Konto (hilft auch, wenn die IP gefälscht wird).
  const ipFailures = new FixedWindowCounter(LOGIN_WINDOW_MS);
  const accountFailures = new FixedWindowCounter(LOGIN_WINDOW_MS);
  const resetMailsPerAccount = new FixedWindowCounter(60 * 60_000);
  const cookieOpts = { secure: config.baseUrl.startsWith('https://'), maxAgeHours: config.sessionTtlHours };

  const checkLocked = (req, res, email) => {
    for (const [counter, key, max] of [
      [ipFailures, req.ip, MAX_FAILURES_PER_IP],
      [accountFailures, email, MAX_FAILURES_PER_ACCOUNT],
    ]) {
      if (key && counter.count(key) >= max) {
        res.set('Retry-After', String(counter.retryAfter(key)));
        throw new HttpError(429, TOO_MANY);
      }
    }
  };
  const failed = (req, email) => {
    ipFailures.hit(req.ip);
    if (email) accountFailures.hit(email);
  };

  /** Startet die Sitzung: Cookie für die Admin-Oberfläche, Token für API-Clients. */
  const startSession = (req, res, user, status = 200) => {
    const token = users.createSession(user.id);
    setSessionCookie(res, token, cookieOpts);
    audit.log(req, 'login', user.email, {}, { user_id: user.id, actor: user.email });
    res.status(status).json({ token, user: users.find(user.id) });
  };

  router.get('/status', (req, res) => {
    res.json({ needs_setup: users.count() === 0 });
  });

  // Ersteinrichtung: legt das erste Administratorkonto an (nur solange keine Benutzer existieren).
  router.post('/setup', setupLimiter, (req, res) => {
    if (users.count() > 0) throw forbidden('Die Einrichtung wurde bereits abgeschlossen');
    const data = validate(req.body, {
      email: { type: 'email', required: true },
      name: { type: 'string', max: 200 },
      password: PASSWORD,
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
    startSession(req, res, user, 201);
  });

  router.post('/login', (req, res) => {
    const { email, password } = validate(req.body, {
      email: { type: 'email', required: true },
      password: { type: 'string', required: true, trim: false },
    });
    checkLocked(req, res, email);
    let row;
    try {
      row = users.verifyCredentials(email, password);
    } catch (err) {
      failed(req, email);
      audit.log(req, 'login_failed', email, {}, { user_id: null, actor: email });
      throw err;
    }
    accountFailures.reset(email);
    if (row.totp_enabled) {
      // Zweiter Schritt: Code aus der Authenticator-App
      return res.json({ two_factor: true, challenge: users.createChallenge(row.id) });
    }
    startSession(req, res, row);
  });

  router.post('/login/2fa', (req, res) => {
    const { challenge, code } = validate(req.body, {
      challenge: { type: 'string', required: true, max: 200 },
      code: { type: 'string', required: true, max: 50 },
    });
    checkLocked(req, res);
    const { userId, finish } = users.useChallenge(challenge);
    if (!users.verifySecondFactor(userId, code)) {
      failed(req);
      const user = users.find(userId);
      audit.log(req, 'login_2fa_failed', user.email, {}, { user_id: userId, actor: user.email });
      throw unauthorized('Der Code ist ungültig');
    }
    finish();
    startSession(req, res, users.find(userId));
  });

  router.post('/logout', authenticate, requireSession, (req, res) => {
    users.destroySession(req.auth.token);
    clearSessionCookie(res, cookieOpts);
    res.status(204).end();
  });

  router.get('/me', authenticate, requireSession, (req, res) => {
    res.json({ ...users.find(req.user.id), recovery_codes_left: users.recoveryCodesLeft(req.user.id) });
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
      audit.log(req, 'password_changed', req.user.email);
    }
    res.json(users.update(req.user.id, { name: data.name, email: data.email }));
  });

  // ---- Passwort vergessen ----

  router.post('/forgot', forgotLimiter, async (req, res) => {
    const { email } = validate(req.body, { email: { type: 'email', required: true } });
    const user = users.findByEmail(email);
    // Gleiche Antwort für bekannte und unbekannte Adressen
    if (user && resetMailsPerAccount.hit(user.id) <= 3) {
      const token = users.createPasswordReset(user.id);
      const url = `${config.baseUrl}/admin/#/reset/${token}`;
      try {
        await systemMail.send({
          to: user.email,
          subject: `Passwort zurücksetzen – ${settings.get('site_name')}`,
          html: `<p>Hallo ${escapeHtml(user.name || '')},</p>
<p>für dein Konto wurde ein neues Passwort angefordert. Über diesen Link kannst du es innerhalb von 60 Minuten festlegen:</p>
${systemMail.button(url, 'Neues Passwort festlegen')}
<p style="color:#6b7280;font-size:13px;">Falls du das nicht warst, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.</p>`,
        });
        audit.log(req, 'password_reset_requested', user.email, {}, { user_id: user.id, actor: user.email });
      } catch (err) {
        logger.error('[auth] Reset-Mail konnte nicht gesendet werden:', err.message);
      }
    }
    res.json({ ok: true, message: 'Falls ein Konto zu dieser Adresse existiert, haben wir dir einen Link geschickt.' });
  });

  router.post('/reset', setupLimiter, (req, res) => {
    const { token, password } = validate(req.body, { token: { type: 'string', required: true, max: 200 }, password: PASSWORD });
    const user = users.resetPassword(token, password);
    audit.log(req, 'password_reset', user.email, {}, { user_id: user.id, actor: user.email });
    res.json({ ok: true, message: 'Dein Passwort wurde geändert. Du kannst dich jetzt anmelden.' });
  });

  // ---- Zwei-Faktor-Anmeldung ----

  router.post('/2fa/setup', authenticate, requireSession, (req, res) => {
    const { password } = validate(req.body, { password: { type: 'string', required: true, trim: false } });
    users.checkPassword(req.user.id, password);
    const secret = users.startTotpSetup(req.user.id);
    const url = otpauthUrl({ secret, account: req.user.email, issuer: settings.get('site_name') || 'CMS' });
    const svg = new QRCode({ content: url, padding: 2, width: 220, height: 220, ecl: 'M', join: true }).svg();
    res.json({ secret, otpauth_url: url, qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
  });

  router.post('/2fa/enable', authenticate, requireSession, (req, res) => {
    const { code } = validate(req.body, { code: { type: 'string', required: true, max: 20 } });
    const recovery = users.enableTotp(req.user.id, code);
    audit.log(req, '2fa_enabled', req.user.email);
    res.json({ recovery_codes: recovery });
  });

  router.post('/2fa/disable', authenticate, requireSession, (req, res) => {
    const { password } = validate(req.body, { password: { type: 'string', required: true, trim: false } });
    users.checkPassword(req.user.id, password);
    users.disableTotp(req.user.id);
    audit.log(req, '2fa_disabled', req.user.email);
    res.json({ ok: true });
  });

  return router;
}
