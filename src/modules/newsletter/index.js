import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { badRequest } from '../../lib/errors.js';
import { escapeHtml } from '../../lib/render.js';
import { parseId, validate } from '../../lib/validate.js';
import { requireAdmin } from '../../middleware/auth.js';
import { migrations } from './migrations.js';
import { campaignRoutes } from './routes/campaigns.js';
import { publicRoutes, subscribeFormHtml } from './routes/public.js';
import { listRoutes, subscriberRoutes, templateRoutes, webhookRoutes } from './routes/subscribers.js';
import { CampaignService } from './services/campaigns.js';
import { DeliveryService } from './services/delivery.js';
import { ListService } from './services/lists.js';
import { StatsService } from './services/stats.js';
import { SubscriberService } from './services/subscribers.js';
import { TemplateService } from './services/templates.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

const settings = {
  defaults: {
    sender_name: 'Newsletter',
    sender_email: 'newsletter@example.com',
    reply_to: '',
    double_opt_in: true,
    send_rate_per_minute: 60,
    default_template_id: null,
    newsletter_footer_widget: true,
    newsletter_auto_campaign: false,
    confirm_subject: 'Bitte bestätige deine Anmeldung zu {{site_name}}',
    confirm_html:
      '<p>Hallo {{first_name | "zusammen"}},</p>\n<p>vielen Dank für dein Interesse an unserem Newsletter. Bitte bestätige deine Anmeldung mit einem Klick:</p>\n<p><a href="{{confirm_url}}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;">Anmeldung bestätigen</a></p>\n<p>Falls du dich nicht angemeldet hast, kannst du diese E-Mail einfach ignorieren.</p>',
    welcome_enabled: false,
    welcome_subject: 'Willkommen bei {{site_name}}!',
    welcome_html: '<p>Hallo {{first_name | "zusammen"}},</p>\n<p>schön, dass du dabei bist! Ab sofort erhältst du unseren Newsletter.</p>',
  },
  rules: {
    sender_name: { type: 'string', max: 200 },
    sender_email: { type: 'email' },
    reply_to: { type: 'string', max: 254 },
    double_opt_in: { type: 'bool' },
    send_rate_per_minute: { type: 'int', min: 1, max: 100000 },
    default_template_id: { type: 'int', min: 1 },
    newsletter_footer_widget: { type: 'bool' },
    newsletter_auto_campaign: { type: 'bool' },
    confirm_subject: { type: 'string', max: 300 },
    confirm_html: { type: 'string', max: 100000, trim: false },
    welcome_enabled: { type: 'bool' },
    welcome_subject: { type: 'string', max: 300 },
    welcome_html: { type: 'string', max: 100000, trim: false },
  },
};

/** Erstellt einen Kampagnenentwurf aus einem Blogbeitrag. */
function campaignFromPost(ctx, post, userId) {
  const url = ctx.posts.publicUrl(post);
  // E-Mails brauchen absolute Bild-URLs
  const coverUrl = post.cover_url && !/^https?:\/\//i.test(post.cover_url) ? ctx.site.url(post.cover_url) : post.cover_url;
  const cover = coverUrl ? `<p><img src="${escapeHtml(coverUrl)}" alt="" style="max-width:100%;height:auto;border-radius:6px;"></p>\n` : '';
  const html = `${cover}<h1>${escapeHtml(post.title)}</h1>
<p>${escapeHtml(post.excerpt || '')}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2a78d6;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">Weiterlesen</a></p>`;
  const publicLists = ctx.lists.list({ publicOnly: true }).map((l) => l.id);
  return ctx.campaigns.create(
    {
      name: `Blog: ${post.title}`.slice(0, 200),
      subject: post.title.slice(0, 300),
      preheader: (post.excerpt || '').slice(0, 300),
      content_html: html,
      template_id: ctx.settings.get('default_template_id'),
      list_ids: publicLists,
    },
    userId,
  );
}

export default {
  name: 'newsletter',
  label: 'Newsletter',
  description: 'Abonnenten, Listen, Double-Opt-in, Kampagnen mit Tracking und Versand-Worker.',
  version: '2.0.0',
  migrations,
  settings,
  adminDir: path.join(dir, 'admin'),

  setup(ctx) {
    const { db, config, mailer, logger, hooks, content } = ctx;
    ctx.lists = new ListService(db);
    ctx.subscribers = new SubscriberService(db);
    ctx.templates = new TemplateService(db);
    ctx.campaigns = new CampaignService(db, { templates: ctx.templates, settings: ctx.settings });
    ctx.delivery = new DeliveryService({
      db, config, mailer, logger, settings: ctx.settings, templates: ctx.templates, campaigns: ctx.campaigns, subscribers: ctx.subscribers,
      isEnabled: () => ctx.modules.isEnabled('newsletter'),
    });
    ctx.newsletterStats = new StatsService(db, { campaigns: ctx.campaigns });
    ctx.newsletterPublic = publicRoutes(ctx);

    const opts = { module: 'newsletter' };
    hooks.on('site.reserved', () => ['subscribe', 'unsubscribe', 'confirm', 'preferences', 't', 'view', 'archive'], opts);
    hooks.on(
      'system.setup',
      () => {
        if (ctx.lists.list().length === 0) ctx.lists.create({ name: 'Newsletter', description: 'Allgemeiner Newsletter', is_public: true });
        const template = ctx.templates.seedDefault();
        if (template) ctx.settings.update({ default_template_id: template.id });
      },
      opts,
    );
    hooks.on(
      'settings.validate',
      (data) => {
        if (data.default_template_id) ctx.templates.find(data.default_template_id);
      },
      opts,
    );
    hooks.on('site.widgets', (area) => (area === 'footer' && ctx.settings.get('newsletter_footer_widget') ? subscribeFormHtml(ctx) : undefined), opts);
    hooks.on('site.sitemap', () => [{ loc: ctx.site.url('/subscribe') }, ...ctx.campaigns.archived().map((c) => ({ loc: ctx.site.url(`/archive/${c.id}`), lastmod: c.started_at }))], opts);
    hooks.on('admin.dashboard', () => ({ newsletter: ctx.newsletterStats.overview({ days: 30 }) }), opts);
    // Integration mit dem Blog-Modul: neue Beiträge optional als Kampagnenentwurf anlegen
    hooks.on(
      'blog.post.published',
      (post, { userId } = {}) => {
        if (ctx.settings.get('newsletter_auto_campaign') && ctx.posts) campaignFromPost(ctx, post, userId);
      },
      opts,
    );

    content.registerShortcode('newsletter_form', (attrs) => subscribeFormHtml(ctx, { title: attrs.title ?? 'Newsletter abonnieren', text: attrs.text }), {
      module: 'newsletter',
      description: 'Anmeldeformular für den Newsletter',
      example: '[newsletter_form title="Bleib auf dem Laufenden"]',
    });
  },

  api(router, ctx) {
    router.use('/subscribers', subscriberRoutes(ctx));
    router.use('/lists', listRoutes(ctx));
    router.use('/templates', templateRoutes(ctx));
    router.use('/campaigns', campaignRoutes(ctx));
    router.use('/webhooks', webhookRoutes(ctx));

    const extra = Router();
    extra.get('/stats/overview', (req, res) => {
      const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
      res.json(ctx.newsletterStats.overview({ days }));
    });
    extra.post('/settings/test-email', requireAdmin, async (req, res) => {
      const { to } = validate(req.body, { to: { type: 'email', required: true } });
      try {
        await ctx.mailer.verify();
        await ctx.delivery.sendSettingsTest(to);
        res.json({ ok: true, message: `Testnachricht an ${to} gesendet` });
      } catch (err) {
        res.status(502).json({ error: `Versand fehlgeschlagen: ${err.message}` });
      }
    });
    extra.post('/campaigns/from-post/:postId', (req, res) => {
      if (!ctx.posts || !ctx.modules.isEnabled('blog')) throw badRequest('Das Blog-Modul ist nicht aktiv');
      const post = ctx.posts.find(parseId(req.params.postId));
      res.status(201).json(campaignFromPost(ctx, post, req.user?.id));
    });
    router.use(extra);
  },

  publicApi(router, ctx) {
    router.use(ctx.newsletterPublic.api);
  },

  publicRoutes(router, ctx) {
    router.use(ctx.newsletterPublic.web);
  },

  start(ctx) {
    if (ctx.config.worker.enabled) ctx.delivery.start();
  },

  stop(ctx) {
    ctx.delivery.stop();
  },
};
