import { Router } from 'express';
import { badRequest } from '../../../lib/errors.js';
import { isEmail, normalizeEmail, pagination, parseId, validate } from '../../../lib/validate.js';

const campaignSchema = {
  name: { type: 'string', required: true, max: 200 },
  subject: { type: 'string', max: 300 },
  preheader: { type: 'string', max: 300 },
  from_name: { type: 'string', max: 200 },
  from_email: { type: 'string', max: 254 },
  reply_to: { type: 'string', max: 254 },
  content_html: { type: 'string', max: 1_000_000, trim: false },
  content_text: { type: 'string', max: 500_000, trim: false },
  template_id: { type: 'int', min: 1 },
  list_ids: { type: 'ids' },
  track_opens: { type: 'bool' },
  track_clicks: { type: 'bool' },
  archive: { type: 'bool' },
  segment_id: { type: 'int', min: 1 },
  subject_b: { type: 'string', max: 300 },
  ab_test_percent: { type: 'int', min: 0, max: 100 },
  ab_wait_hours: { type: 'int', min: 1, max: 168 },
  ab_metric: { type: 'enum', values: ['opens', 'clicks'] },
};

function checkOptionalEmails(data) {
  for (const key of ['from_email', 'reply_to']) {
    if (data[key]) {
      data[key] = normalizeEmail(data[key]);
      if (!isEmail(data[key])) throw badRequest('Validierung fehlgeschlagen', { [key]: 'Ungültige E-Mail-Adresse' });
    }
  }
  return data;
}

export function campaignRoutes({ campaigns, lists, templates, subscribers, delivery, segments }) {
  const router = Router();

  const checkRefs = (data, body = {}) => {
    if (data.list_ids) lists.assertExist(data.list_ids);
    if (data.template_id) templates.find(data.template_id);
    if (data.segment_id) segments.find(data.segment_id);
    // Segment entfernen: segment_id: null
    if (body && 'segment_id' in body && !body.segment_id) data.segment_id = null;
    return data;
  };

  router.get('/', (req, res) => res.json(campaigns.list({ status: req.query.status })));

  router.post('/', (req, res) => {
    const data = checkOptionalEmails(validate(req.body, campaignSchema, { partial: true }));
    if (!data.name) throw badRequest('Validierung fehlgeschlagen', { name: 'Pflichtfeld' });
    checkRefs(data, req.body);
    res.status(201).json(campaigns.create(data, req.user?.id));
  });

  // Vorschau beliebiger (auch ungespeicherter) Inhalte
  router.post('/preview', (req, res) => {
    const data = validate(req.body, {
      subject: { type: 'string', max: 300 },
      preheader: { type: 'string', max: 300 },
      content_html: { type: 'string', max: 1_000_000, trim: false },
      template_id: { type: 'int', min: 1 },
      subscriber_id: { type: 'int', min: 1 },
    });
    const subscriber = data.subscriber_id ? subscribers.find(data.subscriber_id) : null;
    res.json(delivery.preview({ ...data, content_text: '' }, subscriber));
  });

  router.post('/audience', (req, res) => {
    const target = validate(req.body, { list_ids: { type: 'ids', default: () => [] }, segment_id: { type: 'int', min: 1 } });
    if (target.segment_id) segments.find(target.segment_id);
    res.json({ count: campaigns.audienceCount(target) });
  });

  router.get('/:id', (req, res) => res.json(campaigns.find(parseId(req.params.id))));

  router.put('/:id', (req, res) => {
    const data = checkOptionalEmails(validate(req.body, campaignSchema, { partial: true }));
    checkRefs(data, req.body);
    res.json(campaigns.update(parseId(req.params.id), data));
  });

  router.delete('/:id', (req, res) => {
    campaigns.remove(parseId(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/duplicate', (req, res) => {
    res.status(201).json(campaigns.duplicate(parseId(req.params.id), req.user?.id));
  });

  router.get('/:id/preview', (req, res) => {
    const campaign = campaigns.find(parseId(req.params.id));
    const rendered = delivery.preview(campaign);
    if (req.query.format === 'json') return res.json(rendered);
    res.set('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src *");
    res.type('html').send(rendered.html);
  });

  router.post('/:id/test', async (req, res) => {
    const { emails } = req.body || {};
    const list = (Array.isArray(emails) ? emails : String(emails || '').split(/[,;\s]+/)).map(normalizeEmail).filter(Boolean);
    if (!list.length || list.length > 10 || !list.every(isEmail)) throw badRequest('Bitte 1–10 gültige E-Mail-Adressen angeben');
    const campaign = campaigns.find(parseId(req.params.id));
    if (!campaign.subject || !campaign.content_html) throw badRequest('Betreff und Inhalt werden für den Testversand benötigt');
    const sent = await delivery.sendTest(campaign, list);
    res.json({ ok: true, sent });
  });

  router.post('/:id/send', (req, res) => {
    const campaign = campaigns.start(parseId(req.params.id));
    // Versand sofort anstoßen, nicht auf den nächsten Worker-Takt warten
    if (delivery.timer) setImmediate(() => delivery.tick());
    res.json(campaign);
  });

  router.post('/:id/schedule', (req, res) => {
    const { scheduled_at } = validate(req.body, { scheduled_at: { type: 'date', required: true } });
    res.json(campaigns.schedule(parseId(req.params.id), scheduled_at));
  });

  router.post('/:id/unschedule', (req, res) => res.json(campaigns.unschedule(parseId(req.params.id))));
  router.post('/:id/pause', (req, res) => res.json(campaigns.pause(parseId(req.params.id))));
  router.post('/:id/resume', (req, res) => res.json(campaigns.resume(parseId(req.params.id))));
  router.post('/:id/cancel', (req, res) => res.json(campaigns.cancel(parseId(req.params.id))));

  // A/B-Test vorzeitig entscheiden
  router.post('/:id/ab-winner', (req, res) => {
    const { variant } = validate(req.body, { variant: { type: 'enum', values: ['a', 'b'], required: true } });
    const campaign = campaigns.setAbWinner(parseId(req.params.id), variant);
    if (delivery.timer) setImmediate(() => delivery.tick());
    res.json(campaign);
  });

  router.get('/:id/report', (req, res) => res.json(campaigns.report(parseId(req.params.id))));

  router.get('/:id/recipients', (req, res) => {
    res.json(campaigns.recipients(parseId(req.params.id), req.query, pagination(req.query, { defaultPerPage: 50 })));
  });

  return router;
}
