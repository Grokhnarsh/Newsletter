import { HttpError } from '../lib/errors.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Nicht gefunden' });
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültiges JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Anfrage zu groß' });
    logger.error(err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  };
}
