import { HttpError } from './errors.js';

/**
 * Einfacher In-Memory-Ratenbegrenzer (Fixed Window) pro Schlüssel, z. B. IP.
 * Für Mehrinstanz-Betrieb sollte ein gemeinsamer Speicher genutzt werden.
 */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Zu viele Anfragen. Bitte später erneut versuchen.' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, windowMs);
  timer.unref();

  return function rateLimitMiddleware(req, res, next) {
    const k = key(req);
    const t = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= t) {
      entry = { count: 0, reset: t + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - t) / 1000)));
      return next(new HttpError(429, message));
    }
    next();
  };
}
