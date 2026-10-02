import { HttpError } from '../lib/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Nicht gefunden' });
}

/**
 * Fehlerbehandlung: API-Anfragen erhalten JSON, Website-Besucher eine Fehlerseite
 * im Theme (falls verfügbar).
 */
export function errorHandler(logger, site) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    let status = 500;
    let body = { error: 'Interner Serverfehler' };
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: err.message, ...(err.details ? { details: err.details } : {}) };
    } else if (err.type === 'entity.parse.failed') {
      status = 400;
      body = { error: 'Ungültiges JSON' };
    } else if (err.type === 'entity.too.large') {
      status = 413;
      body = { error: 'Anfrage zu groß' };
    } else {
      logger.error(err);
    }
    if (res.headersSent) return;
    const wantsJson = req.originalUrl.startsWith('/api/') || req.originalUrl === '/api' || req.accepts(['html', 'json']) === 'json';
    if (wantsJson || !site) return res.status(status).json(body);
    try {
      site.message(req, res, { title: status >= 500 ? 'Fehler' : 'Hinweis', message: body.error, tone: 'err', status });
    } catch {
      res.status(status).type('text').send(body.error);
    }
  };
}
