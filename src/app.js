import path from 'node:path';
import express from 'express';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { campaignRoutes } from './routes/campaigns.js';
import { publicRoutes } from './routes/public.js';
import { listRoutes, subscriberRoutes, templateRoutes, webhookRoutes } from './routes/subscribers.js';
import { CampaignService } from './services/campaigns.js';
import { DeliveryService } from './services/delivery.js';
import { ListService } from './services/lists.js';
import { SettingsService } from './services/settings.js';
import { StatsService } from './services/stats.js';
import { SubscriberService } from './services/subscribers.js';
import { TemplateService } from './services/templates.js';
import { UserService } from './services/users.js';

export function createServices({ db, config, mailer, logger = console }) {
  const settings = new SettingsService(db);
  const users = new UserService(db, config);
  const lists = new ListService(db);
  const subscribers = new SubscriberService(db);
  const templates = new TemplateService(db);
  const campaigns = new CampaignService(db, { templates, settings });
  const delivery = new DeliveryService({ db, config, mailer, settings, templates, campaigns, subscribers, logger });
  const stats = new StatsService(db, { campaigns });
  return { db, config, mailer, logger, settings, users, lists, subscribers, templates, campaigns, delivery, stats };
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
}

export function createApp(services) {
  const { config, logger, users } = services;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders);

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Öffentliche Seiten & Tracking (eigene Body-Parser mit kleinen Limits)
  app.use(publicRoutes(services));

  // Admin-Oberfläche (statische Single-Page-App)
  const adminDir = path.join(config.root, 'public', 'admin');
  app.use('/admin', express.static(adminDir, { index: 'index.html', maxAge: config.env === 'production' ? '1h' : 0 }));

  // REST-API
  const auth = authenticate(users);
  const api = express.Router();
  api.use('/subscribers/import', express.json({ limit: '20mb' }));
  api.use(express.json({ limit: '2mb' }));
  api.use('/auth', authRoutes(services, auth));
  api.use(auth);
  api.use('/subscribers', subscriberRoutes(services));
  api.use('/lists', listRoutes(services));
  api.use('/templates', templateRoutes(services));
  api.use('/campaigns', campaignRoutes(services));
  api.use('/webhooks', webhookRoutes(services));
  api.use(adminRoutes(services));
  api.use(notFoundHandler);
  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
