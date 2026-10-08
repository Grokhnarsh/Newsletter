import path from 'node:path';
import express from 'express';
import { AuditLog, auditMiddleware } from './core/audit.js';
import { BACKUP_SETTINGS, BackupService } from './core/backup.js';
import { CACHE_SETTINGS, PageCache } from './core/cache.js';
import { ContentService } from './core/content.js';
import { HookBus } from './core/hooks.js';
import { MAIL_SETTINGS, SystemMail } from './core/mail.js';
import { SearchService } from './core/search.js';
import { ModuleManager } from './core/modules.js';
import { authRoutes } from './core/routes/auth.js';
import { systemRoutes } from './core/routes/system.js';
import { SettingsService } from './core/settings.js';
import { SITE_SETTINGS, SiteService } from './core/site.js';
import { UserService } from './core/users.js';
import { authenticate, identify } from './middleware/auth.js';
import { randomToken } from './lib/security.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { builtinModules } from './modules/index.js';

/**
 * Baut das CMS zusammen: Kern-Services, Module (inkl. Migrationen) und die Express-App.
 * Rückgabe: { app, ctx } – `ctx` ist der gemeinsame Kontext aller Module.
 */
export async function createCms({ db, config, mailer, logger = console, modules: moduleList = builtinModules }) {
  const settings = new SettingsService(db);
  const manager = new ModuleManager({ settings, logger });
  const isEnabled = (name) => manager.isEnabled(name);
  const hooks = new HookBus({ isEnabled, logger });
  const content = new ContentService({ db, hooks, isEnabled });
  const site = new SiteService({ config, settings, hooks, content, logger });
  const users = new UserService(db, config);

  const audit = new AuditLog(db);
  const systemMail = new SystemMail({ mailer, settings, logger });

  settings.register('core', SITE_SETTINGS.defaults, SITE_SETTINGS.rules);
  settings.register('core', MAIL_SETTINGS.defaults, MAIL_SETTINGS.rules);
  settings.register('core', BACKUP_SETTINGS.defaults, BACKUP_SETTINGS.rules);
  settings.register('core', CACHE_SETTINGS.defaults, CACHE_SETTINGS.rules);
  for (const mod of moduleList) manager.add(mod);
  await manager.loadDirectory(config.modulesDir);
  manager.resolve();
  manager.registerSettings();
  manager.migrate(db);
  await site.loadTheme(config.theme);

  // Gemeinsamer Kontext; Module hängen ihre Services direkt an (z. B. ctx.subscribers).
  const backups = new BackupService({ db, config, settings, modules: manager, logger });
  const search = new SearchService({ db, hooks });
  const cache = new PageCache(settings);
  const ctx = { db, config, mailer, logger, settings, hooks, content, site, users, audit, systemMail, backups, search, cache, modules: manager };
  site.search = search;
  // Einmaliger Einrichtungscode: ohne ihn kann niemand das erste Administratorkonto anlegen.
  ctx.setupToken = config.setupToken || randomToken(12);
  manager.setup(ctx);
  // Suchindex beim ersten Start (oder nach einem Update ohne Index) aufbauen
  if (search.isEmpty()) search.rebuild();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.get('/health', (req, res) => res.json({ ok: true }));

  // Admin-Oberfläche: Kern + Skripte der Module
  const staticOpts = { maxAge: config.env === 'production' ? '1h' : 0 };
  app.use('/admin', express.static(path.join(config.root, 'public', 'admin'), { index: 'index.html', ...staticOpts }));
  for (const mod of manager.list()) {
    if (mod.adminDir) app.use(`/admin/modules/${mod.name}`, express.static(mod.adminDir, staticOpts));
  }

  // REST-API
  const auth = authenticate(users);
  const api = express.Router();
  // Große Anfragen werden nur nach erfolgreicher Anmeldung gelesen.
  const parsers = { anonymous: express.json({ limit: '100kb' }), user: express.json({ limit: '2mb' }), import: express.json({ limit: '20mb' }) };
  api.use(identify(users));
  api.use((req, res, next) => {
    if (!req.auth) return parsers.anonymous(req, res, next);
    if (req.path.startsWith('/media') && req.method === 'POST') return next();
    return (req.path.startsWith('/subscribers/import') ? parsers.import : parsers.user)(req, res, next);
  });
  api.use(auditMiddleware(audit));
  // Jede erfolgreiche Änderung leert den Seiten-Cache der Website
  api.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) res.on('finish', () => res.statusCode < 400 && cache.clear());
    next();
  });
  api.use('/auth', authRoutes(ctx, auth));
  for (const router of manager.mount('publicApi', ctx)) api.use(router);
  api.use(auth);
  api.use(systemRoutes(ctx));
  for (const router of manager.mount('api', ctx)) api.use(router);
  api.use(notFoundHandler);
  app.use('/api', api);

  // Öffentliche Website: Besuch melden (Statistik), Cache, Modulrouten, Kernrouten, Fallbacks
  app.use((req, res, next) => {
    if (req.method === 'GET') res.on('finish', () => hooks.emit('site.pageview', req, res));
    next();
  });
  app.use(cache.middleware());
  for (const router of manager.mount('publicRoutes', ctx)) app.use(router);
  app.use(site.routes());
  for (const router of manager.mount('fallbackRoutes', ctx)) app.use(router);
  app.use((req, res) => site.notFound(req, res));
  app.use(errorHandler(logger, site));

  return { app, ctx };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: https: http:",
      "media-src 'self' https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
}
