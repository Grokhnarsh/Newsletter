import { forbidden, unauthorized } from '../lib/errors.js';
import { API_KEY_PREFIX } from '../core/users.js';

/**
 * Authentifiziert per `Authorization: Bearer <token>` (Sitzung oder API-Schlüssel)
 * bzw. `X-API-Key: <schlüssel>`. API-Schlüssel haben Redakteursrechte.
 */
export function authenticate(users) {
  return (req, res, next) => {
    const match = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
    const token = match?.[1] || req.get('x-api-key');
    if (!token) return next(unauthorized());

    if (token.startsWith(API_KEY_PREFIX)) {
      const key = users.apiKeyLookup(token);
      if (!key) return next(unauthorized('Ungültiger API-Schlüssel'));
      req.auth = { type: 'api_key', role: 'editor', keyId: key.id, name: key.name };
      return next();
    }

    const user = users.userForSession(token);
    if (!user) return next(unauthorized('Sitzung abgelaufen – bitte erneut anmelden'));
    req.user = user;
    req.auth = { type: 'session', role: user.role, token };
    next();
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
