import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
  }
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Liest die Konfiguration aus Umgebungsvariablen. `overrides` wird vor allem
 * in Tests genutzt, um einzelne Werte gezielt zu setzen.
 */
export function loadConfig(overrides = {}) {
  if (!overrides.skipDotEnv) loadDotEnv();
  const env = process.env;
  const port = int(env.PORT, 3000);
  const config = {
    root: ROOT,
    env: env.NODE_ENV || 'development',
    port,
    host: env.HOST || '0.0.0.0',
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    databasePath: env.DATABASE_PATH || path.join(ROOT, 'data', 'newsletter.db'),
    uploadsDir: env.UPLOADS_DIR || path.join(ROOT, 'data', 'uploads'),
    modulesDir: env.MODULES_DIR || path.join(ROOT, 'modules'),
    theme: env.THEME || 'default',
    trustProxy: bool(env.TRUST_PROXY, false),
    mail: {
      // smtp | file | log
      transport: env.MAIL_TRANSPORT || (env.SMTP_URL || env.SMTP_HOST ? 'smtp' : 'file'),
      smtpUrl: env.SMTP_URL || '',
      smtpHost: env.SMTP_HOST || '',
      smtpPort: int(env.SMTP_PORT, 587),
      smtpSecure: bool(env.SMTP_SECURE, false),
      smtpUser: env.SMTP_USER || '',
      smtpPass: env.SMTP_PASS || '',
      outboxDir: env.MAIL_OUTBOX_DIR || path.join(ROOT, 'data', 'outbox'),
    },
    worker: {
      enabled: bool(env.WORKER_ENABLED, true),
      intervalMs: int(env.WORKER_INTERVAL_MS, 5000),
      maxAttempts: int(env.MAIL_MAX_ATTEMPTS, 3),
    },
    sessionTtlHours: int(env.SESSION_TTL_HOURS, 24 * 7),
    initialAdmin: {
      email: env.ADMIN_EMAIL || '',
      password: env.ADMIN_PASSWORD || '',
    },
    ...overrides,
  };
  delete config.skipDotEnv;
  return config;
}
