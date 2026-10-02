const TOKEN_KEY = 'newsletter.token';

export const session = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set token(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* Speicher nicht verfügbar */
    }
  },
  user: null,
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    session.token = null;
    window.dispatchEvent(new CustomEvent('auth:expired'));
  }
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
