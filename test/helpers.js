import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCms } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createMemoryMailer } from '../src/lib/mailer.js';

const silentLogger = { log() {}, warn() {}, error() {} };

/** Startet eine Instanz mit In-Memory-Datenbank und Speicher-Mailer. */
export async function startTestServer({ uploadsDir, modulesDir = null } = {}) {
  const config = loadConfig({ skipDotEnv: true, databasePath: ':memory:', baseUrl: 'http://test.local' });
  config.worker = { ...config.worker, enabled: false, maxAttempts: 2 };
  config.uploadsDir = uploadsDir || path.join(os.tmpdir(), `cms-test-uploads-${process.pid}-${Date.now()}`);
  config.modulesDir = modulesDir;
  const db = openDatabase(':memory:');
  const mailer = createMemoryMailer();
  const { app, ctx: services } = await createCms({ db, config, mailer, logger: silentLogger });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = null;

  async function request(method, path, { body, headers = {}, form, raw, auth = true } = {}) {
    const h = { ...headers };
    if (auth && token && !h.Authorization) h.Authorization = `Bearer ${token}`;
    let payload;
    if (raw) {
      payload = raw;
    } else if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  return {
    base,
    db,
    mailer,
    services,
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, body, o = {}) => request('POST', p, { ...o, body }),
    put: (p, body, o = {}) => request('PUT', p, { ...o, body }),
    del: (p, o) => request('DELETE', p, o),
    setToken(t) {
      token = t;
    },
    async setupAdmin() {
      const res = await this.post('/api/auth/setup', { email: 'admin@example.com', password: 'sehrgeheim123', site_name: 'Test-News' });
      token = res.data.token;
      return res;
    },
    /** Verarbeitet die Versand-Warteschlange vollständig. */
    flush() {
      return services.delivery.runOnce();
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          fs.rmSync(config.uploadsDir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

/** Wandelt eine Test-URL (http://test.local/...) in einen Pfad um. */
export const pathOf = (url) => url.replace('http://test.local', '');

/** Extrahiert alle URLs aus einer HTML-Mail. */
export function urls(html) {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
}
