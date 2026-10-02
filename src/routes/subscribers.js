import { Router } from 'express';
import { csvToObjects, toCsv } from '../lib/csv.js';
import { badRequest } from '../lib/errors.js';
import { pagination, parseId, validate } from '../lib/validate.js';
import { STATUSES } from '../services/subscribers.js';

const subscriberSchema = {
  email: { type: 'email', required: true },
  first_name: { type: 'string', max: 100 },
  last_name: { type: 'string', max: 100 },
  status: { type: 'enum', values: STATUSES, default: 'active' },
  attributes: { type: 'object', default: () => ({}) },
  list_ids: { type: 'ids', default: () => [] },
};

export function subscriberRoutes({ subscribers, lists, delivery }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(subscribers.list(req.query, pagination(req.query)));
  });

  router.get('/export', (req, res) => {
    const rows = subscribers.exportRows(req.query);
    const attrKeys = [...new Set(rows.flatMap((r) => Object.keys(r.attributes)))].sort();
    const header = ['email', 'first_name', 'last_name', 'status', 'lists', 'source', 'created_at', 'confirmed_at', 'unsubscribed_at', ...attrKeys];
    const csv = toCsv(
      header,
      rows.map((r) => [r.email, r.first_name, r.last_name, r.status, r.lists || '', r.source, r.created_at, r.confirmed_at, r.unsubscribed_at, ...attrKeys.map((k) => r.attributes[k] ?? '')]),
    );
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="abonnenten-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('﻿' + csv);
  });

  // Import: JSON { csv: "...", list_ids, status, update_existing } oder { records: [...] }
  router.post('/import', (req, res) => {
    const options = validate(req.body, {
      list_ids: { type: 'ids', default: () => [] },
      status: { type: 'enum', values: ['active', 'pending', 'unsubscribed'], default: 'active' },
      update_existing: { type: 'bool', default: true },
    });
    lists.assertExist(options.list_ids);
    let records;
    if (typeof req.body.csv === 'string') records = csvToObjects(req.body.csv);
    else if (Array.isArray(req.body.records)) records = req.body.records.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), String(v ?? '')])));
    else throw badRequest('Bitte "csv" oder "records" angeben');
    if (!records.length) throw badRequest('Keine Datensätze gefunden');
    if (records.length > 100000) throw badRequest('Maximal 100.000 Datensätze pro Import');
    res.json(subscribers.import(records, options));
  });

  router.post('/bulk', (req, res) => {
    const data = validate(req.body, {
      action: { type: 'enum', values: ['delete', 'add_to_list', 'remove_from_list', 'set_status'], required: true },
      ids: { type: 'ids', required: true },
      list_id: { type: 'int', min: 1 },
      status: { type: 'enum', values: STATUSES },
    });
    if (['add_to_list', 'remove_from_list'].includes(data.action)) {
      if (!data.list_id) throw badRequest('list_id fehlt');
      lists.assertExist([data.list_id]);
    }
    if (data.action === 'set_status' && !data.status) throw badRequest('status fehlt');
    res.json(subscribers.bulk(data));
  });

  router.post('/', (req, res) => {
    const data = validate(req.body, subscriberSchema);
    lists.assertExist(data.list_ids);
    res.status(201).json(subscribers.create(data, { source: req.auth.type === 'api_key' ? 'api' : 'admin' }));
  });

  router.get('/:id', (req, res) => {
    res.json(subscribers.details(parseId(req.params.id)));
  });

  router.put('/:id', (req, res) => {
    const data = validate(req.body, subscriberSchema, { partial: true });
    if (data.list_ids) lists.assertExist(data.list_ids);
    res.json(subscribers.update(parseId(req.params.id), data));
  });

  router.delete('/:id', (req, res) => {
    subscribers.remove(parseId(req.params.id));
    res.status(204).end();
  });

  router.post('/:id/resend-confirmation', async (req, res) => {
    const subscriber = subscribers.find(parseId(req.params.id));
    if (subscriber.status !== 'pending') throw badRequest('Nur für unbestätigte Abonnenten möglich');
    await delivery.sendConfirmation(subscriber);
    res.json({ ok: true });
  });

  return router;
}

export function listRoutes({ lists }) {
  const router = Router();
  const schema = {
    name: { type: 'string', required: true, max: 200 },
    description: { type: 'string', max: 1000 },
    is_public: { type: 'bool', default: false },
  };

  router.get('/', (req, res) => res.json(lists.list()));
  router.post('/', (req, res) => res.status(201).json(lists.create(validate(req.body, schema))));
  router.get('/:id', (req, res) => res.json(lists.find(parseId(req.params.id))));
  router.put('/:id', (req, res) => res.json(lists.update(parseId(req.params.id), validate(req.body, schema, { partial: true }))));
  router.delete('/:id', (req, res) => {
    lists.remove(parseId(req.params.id));
    res.status(204).end();
  });

  return router;
}

export function templateRoutes({ templates }) {
  const router = Router();
  const schema = {
    name: { type: 'string', required: true, max: 200 },
    html: { type: 'string', required: true, max: 500000, trim: false },
  };

  router.get('/', (req, res) => res.json(templates.list()));
  router.post('/', (req, res) => res.status(201).json(templates.create(validate(req.body, schema))));
  router.get('/:id', (req, res) => res.json(templates.find(parseId(req.params.id))));
  router.put('/:id', (req, res) => res.json(templates.update(parseId(req.params.id), validate(req.body, schema, { partial: true }))));
  router.post('/:id/duplicate', (req, res) => res.status(201).json(templates.duplicate(parseId(req.params.id))));
  router.delete('/:id', (req, res) => {
    templates.remove(parseId(req.params.id));
    res.status(204).end();
  });

  return router;
}

export function webhookRoutes({ subscribers }) {
  const router = Router();
  // Bounce-/Beschwerde-Meldungen, z. B. vom E-Mail-Provider weitergeleitet.
  router.post('/bounce', (req, res) => {
    const data = validate(req.body, {
      email: { type: 'email', required: true },
      type: { type: 'enum', values: ['hard', 'soft', 'complaint'], default: 'hard' },
      reason: { type: 'string', max: 500 },
    });
    const subscriber = subscribers.recordBounce(data.email, data.type, data.reason);
    res.json({ ok: true, status: subscriber.status });
  });
  return router;
}
