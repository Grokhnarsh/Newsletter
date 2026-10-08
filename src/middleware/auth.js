import { forbidden, unauthorized } from '../lib/errors.js';
import { API_KEY_PREFIX } from '../core/users.js';

export const SESSION_COOKIE = 'cms_sid';
// Eigener Header für Cookie-Anfragen: fremde Websites können ihn ohne CORS nicht setzen (CSRF-Schutz).
export const CSRF_HEADER = 'x-requested-with';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(req, name) {
  const header = req.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Setzt das Sitzungs-Cookie (httpOnly, nur für /api, SameSite=Strict). */
export function setSessionCookie(res, token, { secure, maxAgeHours }) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/api',
    maxAge: maxAgeHours * 3600_000,
  });
}

export function clearSessionCookie(res, { secure }) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: '/api' });
}

/**
 * Ermittelt die Anmeldung aus `Authorization: Bearer <token>` (Sitzung oder API-Schlüssel),
 * `X-API-Key: <schlüssel>` oder dem Sitzungs-Cookie der Admin-Oberfläche. Ergebnis wird an der
 * Anfrage zwischengespeichert: `req.auth` bei Erfolg, sonst `req.authError`.
 */
function resolve(users, req) {
  if (req.authResolved) return;
  req.authResolved = true;
  req.authError = null;
  const match = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  let token = match?.[1] || req.get('x-api-key');
  let viaCookie = false;
  if (!token) {
    token = readCookie(req, SESSION_COOKIE);
    viaCookie = Boolean(token);
  }
  if (!token) return;

  if (token.startsWith(API_KEY_PREFIX) && !viaCookie) {
    const key = users.apiKeyLookup(token);
    if (!key) {
      req.authError = unauthorized('Ungültiger API-Schlüssel');
      return;
    }
    req.auth = { type: 'api_key', role: 'editor', keyId: key.id, name: key.name };
    return;
  }

  const user = users.userForSession(token);
  if (!user) {
    req.authError = unauthorized('Sitzung abgelaufen – bitte erneut anmelden');
    return;
  }
  if (viaCookie && !SAFE_METHODS.has(req.method) && !req.get(CSRF_HEADER)) {
    req.authError = forbidden('Anfrage ohne CSRF-Schutz abgelehnt');
    return;
  }
  req.user = user;
  req.auth = { type: 'session', role: user.role, token, viaCookie };
}

/** Prüft die Anmeldung, ohne abzulehnen (z. B. um Größenlimits davon abhängig zu machen). */
export function identify(users) {
  return (req, res, next) => {
    resolve(users, req);
    next();
  };
}

/** API-Schlüssel haben Redakteursrechte. */
export function authenticate(users) {
  return (req, res, next) => {
    resolve(users, req);
    if (req.auth) return next();
    next(req.authError || unauthorized());
  };
}

export function requireAdmin(req, res, next) {
  if (req.auth?.type === 'session' && req.auth.role === 'admin') return next();
  next(forbidden('Nur für Administratoren'));
}

/** Redakteure und Administratoren (nicht Autoren). API-Schlüssel zählen als Redakteur. */
export function requireEditor(req, res, next) {
  if (req.auth && req.auth.role !== 'author') return next();
  next(forbidden('Für diese Funktion fehlen die Rechte (Redakteur erforderlich)'));
}

export function requireSession(req, res, next) {
  if (req.auth?.type === 'session') return next();
  next(forbidden('Nur mit Benutzeranmeldung möglich'));
}

export const isAuthor = (req) => req.auth?.role === 'author';
