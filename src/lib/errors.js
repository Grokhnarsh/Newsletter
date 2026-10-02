export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, message, details);
export const unauthorized = (message = 'Nicht angemeldet') => new HttpError(401, message);
export const forbidden = (message = 'Keine Berechtigung') => new HttpError(403, message);
export const notFound = (message = 'Nicht gefunden') => new HttpError(404, message);
export const conflict = (message, details) => new HttpError(409, message, details);
