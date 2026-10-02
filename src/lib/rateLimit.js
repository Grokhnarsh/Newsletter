import { HttpError } from './errors.js';

// Obergrenze für gemerkte Schlüssel, damit gefälschte Absender den Speicher nicht füllen.
const MAX_KEYS = 50_000;

/**
 * Zähler mit festem Zeitfenster pro Schlüssel (z. B. IP oder E-Mail-Adresse).
 * Für Mehrinstanz-Betrieb sollte ein gemeinsamer Speicher genutzt werden.
 */
export class FixedWindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map();
    const timer = setInterval(() => this.prune(), windowMs);
    timer.unref();
  }

  prune() {
    const t = Date.now();
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
  }

  entry(key) {
    const t = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.reset <= t) {
      if (!entry && this.hits.size >= MAX_KEYS) {
        this.prune();
        // Immer noch voll: ältesten Eintrag verwerfen (Map behält die Einfügereihenfolge).
        if (this.hits.size >= MAX_KEYS) this.hits.delete(this.hits.keys().next().value);
      }
      entry = { count: 0, reset: t + this.windowMs };
      this.hits.set(key, entry);
    }
    return entry;
  }

  count(key) {
    const entry = this.hits.get(key);
    return entry && entry.reset > Date.now() ? entry.count : 0;
  }

  /** Erhöht den Zähler und liefert den neuen Stand. */
  hit(key) {
    return ++this.entry(key).count;
  }

  reset(key) {
    this.hits.delete(key);
  }

  retryAfter(key) {
    const entry = this.hits.get(key);
    return entry ? Math.max(1, Math.ceil((entry.reset - Date.now()) / 1000)) : 1;
  }
}

/** Middleware: begrenzt Anfragen pro Schlüssel (Standard: IP). */
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Zu viele Anfragen. Bitte später erneut versuchen.' }) {
  const counter = new FixedWindowCounter(windowMs);

  return function rateLimitMiddleware(req, res, next) {
    const k = key(req);
    if (counter.hit(k) > max) {
      res.set('Retry-After', String(counter.retryAfter(k)));
      return next(new HttpError(429, message));
    }
    next();
  };
}
