import { forbidden, unauthorized } from '../lib/errors.js';
import { API_KEY_PREFIX } from '../core/users.js';

/**
 * Ermittelt die Anmeldung aus `Authorization: Bearer <token>` (Sitzung oder API-Schlüssel)
 * bzw. `X-API-Key: <schlüssel>`. Ergebnis wird an der Anfrage zwischengespeichert:
 * `req.auth` bei Erfolg, sonst `req.authError` (null, wenn gar nichts mitgeschickt wurde).
 */
function resolve(users, req) {
  if (req.authResolved) return;
  req.authResolved = true;
  req.authError = null;
  const match = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1] || req.get('x-api-key');
  if (!token) return;

  if (token.startsWith(API_KEY_PREFIX)) {
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
  req.user = user;
  req.auth = { type: 'session', role: user.role, token };
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

export function requireSession(req, res, next) {
  if (req.auth?.type === 'session') return next();
  next(forbidden('Nur mit Benutzeranmeldung möglich'));
}
