export const CACHE_SETTINGS = {
  defaults: { cache_ttl_seconds: 300 },
  rules: { cache_ttl_seconds: { type: 'int', min: 0, max: 86400 } },
};

const MAX_ENTRIES = 500;
const MAX_ENTRY_BYTES = 1024 * 1024;

/**
 * Zwischenspeicher für öffentliche HTML-Seiten. Gespeichert werden nur Antworten,
 * die als cachebar markiert sind (res.locals.cacheable), also keine personalisierten
 * Seiten. Jede Änderung im Admin-Bereich leert den Cache vollständig.
 */
export class PageCache {
  constructor(settings) {
    this.settings = settings;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  ttl() {
    return this.settings.get('cache_ttl_seconds') * 1000;
  }

  clear() {
    this.entries.clear();
  }

  stats() {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses, ttl_seconds: this.ttl() / 1000 };
  }

  middleware() {
    return (req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !this.ttl()) return next();
      const key = req.originalUrl;
      const hit = this.entries.get(key);
      if (hit && hit.expires > Date.now()) {
        this.hits++;
        // LRU: zuletzt genutzte Einträge ans Ende
        this.entries.delete(key);
        this.entries.set(key, hit);
        res.set({ 'Content-Type': hit.type, 'X-Cache': 'HIT' });
        res.locals.cacheHit = true;
        return res.status(200).send(hit.body);
      }
      this.misses++;
      const send = res.send.bind(res);
      res.send = (body) => {
        if (res.locals.cacheable && res.statusCode === 200 && typeof body === 'string' && body.length < MAX_ENTRY_BYTES) {
          if (this.entries.size >= MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
          this.entries.set(key, { body, type: res.get('Content-Type') || 'text/html; charset=utf-8', expires: Date.now() + this.ttl() });
          res.set('X-Cache', 'MISS');
        }
        return send(body);
      };
      next();
    };
  }
}
