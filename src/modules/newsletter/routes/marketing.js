import crypto from 'node:crypto';
import express, { Router } from 'express';
import { badRequest, notFound } from '../../../lib/errors.js';
import { randomToken } from '../../../lib/security.js';
import { parseId, validate } from '../../../lib/validate.js';
import { requireAdmin } from '../../../middleware/auth.js';
import { isSnsUrl, parseBounces, PROVIDERS } from '../services/bounces.js';
import { SEGMENT_FIELDS } from '../services/segments.js';

export function segmentRoutes({ segments, lists }) {
  const router = Router();
  const schema = {
    name: { type: 'string', required: true, max: 200 },
    match: { type: 'enum', values: ['all', 'any'], default: 'all' },
  };
  const checkLists = (rules = []) => {
    const ids = rules.filter((r) => r?.field === 'list').map((r) => Number(r.value)).filter(Boolean);
    if (ids.length) lists.assertExist(ids);
  };

  router.get('/', (req, res) => res.json(segments.list()));
  router.get('/fields', (req, res) => res.json(Object.entries(SEGMENT_FIELDS).map(([key, f]) => ({ key, label: f.label, type: f.type }))));
  router.post('/preview', (req, res) => {
    checkLists(req.body?.rules);
    res.json(segments.preview({ match: req.body?.match, rules: req.body?.rules ?? [] }));
  });
  router.post('/', (req, res) => {
    checkLists(req.body?.rules);
    res.status(201).json(segments.create({ ...validate(req.body, schema), rules: req.body?.rules ?? [] }));
  });
  router.get('/:id', (req, res) => {
    const segment = segments.find(parseId(req.params.id));
    res.json({ ...segment, count: segments.count(segment) });
  });
  router.put('/:id', (req, res) => {
    checkLists(req.body?.rules);
    const data = validate(req.body, schema, { partial: true });
    res.json(segments.update(parseId(req.params.id), { ...data, ...(req.body?.rules !== undefined ? { rules: req.body.rules } : {}) }));
  });
  router.delete('/:id', (req, res) => {
    segments.remove(parseId(req.params.id));
    res.status(204).end();
  });
  return router;
}

export function automationRoutes({ automations, lists, templates }) {
  const router = Router();
  const schema = {
    name: { type: 'string', required: true, max: 200 },
    list_id: { type: 'int', min: 1 },
    status: { type: 'enum', values: ['draft', 'active', 'paused'] },
  };
  const checkRefs = (data, steps) => {
    if (data.list_id) lists.assertExist([data.list_id]);
    for (const s of steps || []) if (Number(s?.template_id)) templates.find(Number(s.template_id));
  };

  router.get('/', (req, res) => res.json(automations.list()));
  router.post('/', (req, res) => {
    const data = validate(req.body, schema);
    checkRefs(data, req.body?.steps);
    res.status(201).json(automations.create({ ...data, steps: req.body?.steps ?? [] }));
  });
  router.get('/:id', (req, res) => res.json(automations.find(parseId(req.params.id))));
  router.put('/:id', (req, res) => {
    const data = validate(req.body, schema, { partial: true });
    if (req.body && 'list_id' in req.body && !req.body.list_id) data.list_id = null;
    checkRefs(data, req.body?.steps);
    res.json(automations.update(parseId(req.params.id), { ...data, ...(req.body?.steps !== undefined ? { steps: req.body.steps } : {}) }));
  });
  router.delete('/:id', (req, res) => {
    automations.remove(parseId(req.params.id));
    res.status(204).end();
  });
  return router;
}

/** Geheimer Pfadbestandteil der Provider-Webhooks (wird beim ersten Abruf erzeugt). */
function webhookSecret(settings, renew = false) {
  let secret = settings.getInternal('bounce_webhook_secret');
  if (!secret || renew) {
    secret = randomToken(24);
    settings.setInternal('bounce_webhook_secret', secret);
  }
  return secret;
}

/** Verwaltung: Webhook-Adressen für die Provider anzeigen und erneuern. */
export function webhookAdminRoutes({ settings, site }) {
  const router = Router();
  const urls = (secret) => Object.entries(PROVIDERS).map(([key, label]) => ({ provider: key, label, url: site.url(`/api/public/bounces/${key}/${secret}`) }));
  router.get('/bounce-urls', (req, res) => res.json(urls(webhookSecret(settings))));
  router.post('/bounce-urls/renew', requireAdmin, (req, res) => res.json(urls(webhookSecret(settings, true))));
  return router;
}

/** Öffentliche Webhooks der E-Mail-Provider (Bounces und Beschwerden). */
export function bounceWebhookRoutes({ settings, subscribers, logger }) {
  const router = Router();
  // SNS sendet JSON mit Content-Type text/plain
  const text = express.text({ type: ['text/plain', 'application/x-www-form-urlencoded'], limit: '256kb' });

  router.post('/public/bounces/:provider/:secret', text, async (req, res) => {
    const expected = Buffer.from(webhookSecret(settings));
    const given = Buffer.from(String(req.params.secret));
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw notFound('Nicht gefunden');
    if (!PROVIDERS[req.params.provider]) throw notFound('Unbekannter Provider');

    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw badRequest('Ungültiges JSON');
      }
    }

    // Amazon SNS: Abonnement einmalig bestätigen
    if (req.params.provider === 'ses' && body?.Type === 'SubscriptionConfirmation') {
      if (!isSnsUrl(body.SubscribeURL)) throw badRequest('Ungültige SubscribeURL');
      try {
        await fetch(body.SubscribeURL, { signal: AbortSignal.timeout(10_000) });
        logger.log('[bounces] SNS-Abonnement bestätigt');
      } catch (err) {
        logger.warn(`[bounces] SNS-Bestätigung fehlgeschlagen: ${err.message}`);
      }
      return res.json({ ok: true, confirmed: true });
    }

    const items = parseBounces(req.params.provider, body);
    let processed = 0;
    for (const item of items) {
      if (!subscribers.findByEmail(item.email)) continue;
      subscribers.recordBounce(item.email, item.type, item.reason);
      processed++;
    }
    res.json({ ok: true, received: items.length, processed });
  });
  return router;
}
