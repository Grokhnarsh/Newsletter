// Die Sitzung liegt in einem httpOnly-Cookie (für JavaScript unlesbar). Jede Anfrage
// trägt zusätzlich einen eigenen Header als CSRF-Schutz.
export const CSRF_HEADERS = { 'X-Requested-With': 'cms-admin' };

export const session = { user: null };

// Alte Versionen speicherten das Token im Browser – entfernen.
try {
  localStorage.removeItem('newsletter.token');
} catch {
  /* Speicher nicht verfügbar */
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { ...CSRF_HEADERS };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, credentials: 'same-origin', body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('auth:expired'));
  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* kein JSON */
    }
    throw new ApiError(res.status, data.error || `Fehler ${res.status}`, data.details);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  return res.json();
}

export const get = (path) => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const del = (path) => api(path, { method: 'DELETE' });
