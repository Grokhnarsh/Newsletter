import express, { Router } from 'express';
import { HttpError } from '../../../lib/errors.js';
import { rateLimit } from '../../../lib/rateLimit.js';
import { escapeHtml, mergeTags } from '../../../lib/render.js';
import { isEmail, normalizeEmail } from '../../../lib/validate.js';

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const SUCCESS_MESSAGE = {
  confirm: 'Fast geschafft! Wir haben dir eine E-Mail geschickt. Bitte bestätige deine Anmeldung über den Link darin.',
  done: 'Vielen Dank! Deine Anmeldung war erfolgreich.',
};

function wantsHtml(req) {
  return !req.is('application/json') && req.accepts(['json', 'html']) === 'html';
}

/** Kompaktes Anmeldeformular für Widgets und den Shortcode [newsletter_form]. */
export function subscribeFormHtml({ lists, settings }, { title = 'Newsletter abonnieren', text = 'Neuigkeiten direkt in dein Postfach. Abmeldung jederzeit möglich.' } = {}) {
  const privacy = settings.get('privacy_url');
  const publicLists = lists.list({ publicOnly: true });
  return `<div class="newsletter-box">
  ${title ? `<h3>${escapeHtml(title)}</h3>` : ''}${text ? `<p class="muted">${escapeHtml(text)}</p>` : ''}
  <form method="post" action="/subscribe">
    <div class="newsletter-inline">
      <input type="email" name="email" required placeholder="E-Mail-Adresse" aria-label="E-Mail-Adresse" autocomplete="email">
      <button type="submit">Abonnieren</button>
    </div>
    ${publicLists.length > 1 ? publicLists.map((l) => `<input type="hidden" name="list_ids" value="${l.id}">`).join('') : ''}
    <div class="hp" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>
    <label class="check"><input type="checkbox" name="consent" value="1" required><span class="muted">Ich stimme dem Empfang des Newsletters zu${
      privacy ? ` (<a href="${escapeHtml(privacy)}">Datenschutz</a>)` : ''
    }.</span></label>
  </form>
</div>`;
}

/**
 * Öffentliche Seiten: Anmeldung, Bestätigung, Abmeldung, Präferenzen, Tracking, Archiv.
 * Liefert zwei Router: `web` (Website) und `api` (unter /api, ohne Anmeldung).
 */
export function publicRoutes({ subscribers, lists, settings, delivery, campaigns, logger, site }) {
  const router = Router();
  const apiRouter = Router();
  const form = express.urlencoded({ extended: false, limit: '20kb' });
  const json = express.json({ limit: '20kb' });
  const subscribeLimiter = rateLimit({ windowMs: 60 * 60_000, max: 30 });
  // Ausgabe im Layout des aktiven Themes
  const page = ({ title, body }) => ({ title, body });
  const messagePage = ({ title, message, tone = '' }) => ({ title, message, tone, isMessage: true });
  const html = (res, status, view) =>
    view.isMessage
      ? site.message(res.req, res, { ...view, status })
      : site.send(res.req, res, { title: view.title, status, noindex: true, bodyClass: 'narrow', content: `<div class="panel">${view.body}</div>` });
  const notFoundPage = (res) => html(res, 404, messagePage({ title: 'Link ungültig', message: 'Dieser Link ist ungültig oder abgelaufen.', tone: 'err' }));

  const findSubscriber = (token) => {
    try {
      return subscribers.findByToken(token);
    } catch {
      return null;
    }
  };

  // ---- Anmeldung ----

  router.get('/subscribe', (req, res) => {
    const publicLists = lists.list({ publicOnly: true });
    const privacy = settings.get('privacy_url');
    const listChoices =
      publicLists.length > 1
        ? `<label>Themen</label>${publicLists
            .map(
              (l) =>
                `<label class="check"><input type="checkbox" name="list_ids" value="${l.id}" checked><span>${escapeHtml(l.name)}${
                  l.description ? `<br><span class="muted">${escapeHtml(l.description)}</span>` : ''
                }</span></label>`,
            )
            .join('')}`
        : '';
    html(
      res,
      200,
      page({
        title: 'Newsletter abonnieren',
        body: `<h1>Newsletter abonnieren</h1>
<p class="muted">Erhalte Neuigkeiten direkt in dein Postfach. Abmeldung jederzeit möglich.</p>
<form method="post" action="/subscribe">
  <label for="email">E-Mail-Adresse</label>
  <input id="email" type="email" name="email" required autocomplete="email">
  <div class="row">
    <div><label for="first_name">Vorname</label><input id="first_name" type="text" name="first_name" autocomplete="given-name"></div>
    <div><label for="last_name">Nachname</label><input id="last_name" type="text" name="last_name" autocomplete="family-name"></div>
  </div>
  ${listChoices}
  <div class="hp" aria-hidden="true"><label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
  <label class="check"><input type="checkbox" name="consent" value="1" required><span class="muted">Ich möchte den Newsletter erhalten und habe die ${
    privacy ? `<a href="${escapeHtml(privacy)}" target="_blank" rel="noopener">Datenschutzerklärung</a>` : 'Datenschutzerklärung'
  } gelesen.</span></label>
  <button type="submit">Jetzt abonnieren</button>
</form>
<hr><p class="muted"><a href="/archive">Bisherige Ausgaben ansehen</a></p>`,
      }),
    );
  });

  const subscribeHandler = async (req, res) => {
    const body = req.body || {};
    const respond = (status, message, ok = true) => {
      if (wantsHtml(req)) {
        return html(res, status, messagePage({ title: ok ? 'Danke!' : 'Fehler', message, tone: ok ? 'ok' : 'err' }));
      }
      return res.status(status).json(ok ? { ok: true, message } : { error: message });
    };

    // Honeypot: Bots füllen das versteckte Feld aus → scheinbarer Erfolg.
    if (body.website) return respond(200, SUCCESS_MESSAGE.confirm);

    const email = normalizeEmail(body.email);
    if (!isEmail(email)) return respond(400, 'Bitte gib eine gültige E-Mail-Adresse ein.', false);

    const publicIds = lists.list({ publicOnly: true }).map((l) => l.id);
    const requested = [].concat(body.list_ids ?? body.lists ?? []).map(Number).filter((id) => publicIds.includes(id));
    const listIds = requested.length ? requested : publicIds;
    const attributes = body.attributes && typeof body.attributes === 'object' && !Array.isArray(body.attributes) ? body.attributes : {};
    const clip = (v, n) => String(v ?? '').trim().slice(0, n);
    const doubleOptIn = settings.get('double_opt_in');

    const { subscriber, action } = subscribers.publicSubscribe(
      {
        email,
        first_name: clip(body.first_name, 100),
        last_name: clip(body.last_name, 100),
        list_ids: listIds,
        attributes: Object.fromEntries(Object.entries(attributes).slice(0, 20).map(([k, v]) => [clip(k, 50), clip(v, 500)])),
      },
      { ip: req.ip, doubleOptIn, source: req.originalUrl.startsWith('/api') ? 'api' : 'form' },
    );

    try {
      if (action === 'confirm') await delivery.sendConfirmation(subscriber);
      if (action === 'welcome') await delivery.sendWelcome(subscriber);
    } catch (err) {
      logger.error('[subscribe] E-Mail konnte nicht gesendet werden:', err.message);
    }
    // Einheitliche Antwort – verrät nicht, ob die Adresse bereits eingetragen ist.
    respond(200, doubleOptIn ? SUCCESS_MESSAGE.confirm : SUCCESS_MESSAGE.done);
  };

  // CORS für eingebettete Formulare auf anderen Websites
  const cors = (req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };

  router.post('/subscribe', subscribeLimiter, form, subscribeHandler);
  apiRouter.options('/public/subscribe', cors);
  apiRouter.post('/public/subscribe', cors, subscribeLimiter, json, form, subscribeHandler);
  apiRouter.get('/public/lists', cors, (req, res) => {
    res.json(lists.list({ publicOnly: true }).map(({ id, name, description }) => ({ id, name, description })));
  });

  // ---- Bestätigung (Double-Opt-in) ----

  router.get('/confirm/:token', async (req, res) => {
    const subscriber = findSubscriber(req.params.token);
    if (!subscriber) return notFoundPage(res);
    if (subscriber.status === 'pending') {
      const { subscriber: confirmed } = subscribers.confirm(req.params.token);
      try {
        await delivery.sendWelcome(confirmed);
      } catch (err) {
        logger.error('[confirm] Willkommens-Mail fehlgeschlagen:', err.message);
      }
    } else if (subscriber.status !== 'active') {
      return html(res, 410, messagePage({ title: 'Nicht möglich', message: 'Dieses Abonnement kann nicht mehr bestätigt werden. Bitte melde dich erneut an.', tone: 'err' }));
    }
    html(res, 200, messagePage({ title: 'Anmeldung bestätigt', message: 'Vielen Dank! Du erhältst ab sofort unseren Newsletter.', tone: 'ok' }));
  });

  // ---- Abmeldung ----

  router.get('/unsubscribe/:token', (req, res) => {
    const subscriber = findSubscriber(req.params.token);
    if (!subscriber) return notFoundPage(res);
    if (subscriber.status === 'unsubscribed') {
      return html(res, 200, messagePage({ title: 'Bereits abgemeldet', message: 'Du bist bereits vom Newsletter abgemeldet.' }));
    }
    const r = typeof req.query.r === 'string' ? `?r=${encodeURIComponent(req.query.r)}` : '';
    html(
      res,
      200,
      page({
        title: 'Abmelden',
        body: `<h1>Newsletter abbestellen</h1>
<p>Möchtest du <strong>${escapeHtml(subscriber.email)}</strong> wirklich vom Newsletter abmelden?</p>
<form method="post" action="/unsubscribe/${escapeHtml(req.params.token)}${escapeHtml(r)}"><button type="submit">Ja, abmelden</button></form>
<hr><p class="muted">Du möchtest nur weniger E-Mails? <a href="/preferences/${escapeHtml(req.params.token)}">Einstellungen anpassen</a></p>`,
      }),
    );
  });

  // Unterstützt auch RFC 8058 One-Click-Unsubscribe (POST mit List-Unsubscribe=One-Click)
  router.post('/unsubscribe/:token', form, (req, res) => {
    const subscriber = findSubscriber(req.params.token);
    if (!subscriber) return notFoundPage(res);
    const recipient = typeof req.query.r === 'string' ? campaigns.recipientByToken(req.query.r) : null;
    const campaignId = recipient && recipient.subscriber_id === subscriber.id ? recipient.campaign_id : null;
    const oneClick = req.body?.['List-Unsubscribe'] === 'One-Click';
    subscribers.unsubscribe(req.params.token, { campaignId, reason: oneClick ? 'one_click' : 'link' });
    if (oneClick) return res.status(200).send('OK');
    html(
      res,
      200,
      page({
        title: 'Abgemeldet',
        body: `<h1 class="ok">Du wurdest abgemeldet</h1><p>Du erhältst keine weiteren Newsletter mehr. Schade, dass du gehst!</p>
<p class="muted">Versehentlich abgemeldet? <a href="/subscribe">Hier erneut anmelden</a>.</p>`,
      }),
    );
  });

  // ---- Präferenzen ----

  const renderPreferences = (res, subscriber, notice = '') => {
    const publicLists = lists.list({ publicOnly: true });
    const active = subscriber.status === 'active';
    html(
      res,
      200,
      page({
        title: 'Einstellungen',
        body: `<h1>Deine Newsletter-Einstellungen</h1>
${notice ? `<p class="ok">${escapeHtml(notice)}</p>` : ''}
<p class="muted">Adresse: <strong>${escapeHtml(subscriber.email)}</strong> · Status: ${active ? 'aktiv' : escapeHtml(subscriber.status)}</p>
<form method="post" action="/preferences/${escapeHtml(subscriber.token)}">
  <div class="row">
    <div><label for="first_name">Vorname</label><input id="first_name" type="text" name="first_name" value="${escapeHtml(subscriber.first_name)}"></div>
    <div><label for="last_name">Nachname</label><input id="last_name" type="text" name="last_name" value="${escapeHtml(subscriber.last_name)}"></div>
  </div>
  ${
    publicLists.length
      ? `<label>Themen</label>${publicLists
          .map(
            (l) =>
              `<label class="check"><input type="checkbox" name="list_ids" value="${l.id}"${subscriber.list_ids.includes(l.id) ? ' checked' : ''}><span>${escapeHtml(l.name)}</span></label>`,
          )
          .join('')}`
      : ''
  }
  ${!active && subscriber.status === 'unsubscribed' ? '<label class="check"><input type="checkbox" name="resubscribe" value="1"><span>Newsletter wieder abonnieren</span></label>' : ''}
  <button type="submit">Speichern</button>
</form>
<hr>
${active ? `<form method="post" action="/unsubscribe/${escapeHtml(subscriber.token)}"><button class="secondary" type="submit">Von allen Newslettern abmelden</button></form>` : ''}
<p class="muted" style="margin-top:18px">Datenschutz: <a href="/preferences/${escapeHtml(subscriber.token)}/export">Meine Daten herunterladen</a></p>
<form method="post" action="/preferences/${escapeHtml(subscriber.token)}/delete">
  <button class="secondary" type="submit">Alle meine Daten löschen</button>
</form>`,
      }),
    );
  };

  router.get('/preferences/:token', (req, res) => {
    const subscriber = findSubscriber(req.params.token);
    if (!subscriber) return notFoundPage(res);
    renderPreferences(res, subscriber);
  });

  router.post('/preferences/:token', form, (req, res) => {
    const subscriber = findSubscriber(req.params.token);
    if (!subscriber) return notFoundPage(res);
    const body = req.body || {};
    const publicIds = lists.list({ publicOnly: true }).map((l) => l.id);
    const listIds = [].concat(body.list_ids ?? []).map(Number);
    let updated = subscribers.updatePreferences(
      req.params.token,
      { first_name: String(body.first_name ?? '').trim().slice(0, 100), last_name: String(body.last_name ?? '').trim().slice(0, 100), list_ids: listIds },
      publicIds,
    );
    if (body.resubscribe && updated.status === 'unsubscribed') {
      subscribers.setStatus(updated.id, 'active', { reason: 'preferences' });
      updated = subscribers.find(updated.id);
    }
    renderPreferences(res, updated, 'Deine Einstellungen wurden gespeichert.');
  });

  router.get('/preferences/:token/export', (req, res) => {
    if (!findSubscriber(req.params.token)) return notFoundPage(res);
    res.set('Content-Disposition', 'attachment; filename="meine-daten.json"');
    res.json(subscribers.exportPersonalData(req.params.token));
  });

  router.post('/preferences/:token/delete', form, (req, res) => {
    const subscriber = findSubscriber(req.params.token);
    if (!subscriber) return notFoundPage(res);
    if (req.body?.confirm !== '1') {
      return html(
        res,
        200,
        page({
          title: 'Daten löschen',
            body: `<h1>Alle Daten löschen?</h1>
<p>Dadurch werden <strong>${escapeHtml(subscriber.email)}</strong> und alle zugehörigen Daten endgültig gelöscht. Das kann nicht rückgängig gemacht werden.</p>
<form method="post" action="/preferences/${escapeHtml(subscriber.token)}/delete"><input type="hidden" name="confirm" value="1"><button class="secondary" type="submit">Endgültig löschen</button></form>
<p class="muted" style="margin-top:18px"><a href="/preferences/${escapeHtml(subscriber.token)}">Abbrechen</a></p>`,
        }),
      );
    }
    subscribers.remove(subscriber.id);
    html(res, 200, messagePage({ title: 'Daten gelöscht', message: 'Alle zu deiner Adresse gespeicherten Daten wurden gelöscht.', tone: 'ok' }));
  });

  // ---- Tracking ----

  router.get('/t/o/:file', (req, res) => {
    const token = req.params.file.replace(/\.gif$/, '');
    try {
      const recipient = campaigns.recipientByToken(token);
      if (recipient) campaigns.recordOpen(recipient);
    } catch (err) {
      logger.error('[tracking] Öffnung:', err.message);
    }
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache' });
    res.send(PIXEL);
  });

  router.get('/t/c/:token/:linkId', (req, res) => {
    const recipient = campaigns.recipientByToken(req.params.token);
    const url = recipient ? campaigns.recordClick(recipient, Number(req.params.linkId)) : null;
    if (!url) return notFoundPage(res);
    res.set('Cache-Control', 'no-store');
    res.redirect(302, url);
  });

  // ---- Webansicht & Archiv ----

  const sendEmailHtml = (res, htmlBody) => {
    res.set('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src *");
    res.type('html').send(htmlBody);
  };

  router.get('/view/:token', (req, res) => {
    const recipient = campaigns.recipientByToken(req.params.token);
    if (!recipient) return notFoundPage(res);
    const campaign = campaigns.find(recipient.campaign_id);
    const subscriber = recipient.subscriber_id ? subscribers.find(recipient.subscriber_id) : null;
    const rendered = delivery.renderForRecipient(campaign, subscriber, recipient.token, { tracking: false });
    sendEmailHtml(res, rendered.html);
  });

  router.get('/archive', (req, res) => {
    const vars = delivery.vars(null);
    const items = campaigns.archived().map((c) => ({ ...c, subject: mergeTags(c.subject, vars, { escape: false }) }));
    html(
      res,
      200,
      page({
        title: 'Archiv',
        body: `<h1>Newsletter-Archiv</h1>${
          items.length
            ? `<ul class="archive">${items
                .map(
                  (c) =>
                    `<li><a href="/archive/${c.id}">${escapeHtml(c.subject)}</a><br><span class="muted">${new Date(c.started_at).toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' })}</span></li>`,
                )
                .join('')}</ul>`
            : '<p class="muted">Noch keine Ausgaben im Archiv.</p>'
        }<hr><p><a class="btn" href="/subscribe">Newsletter abonnieren</a></p>`,
      }),
    );
  });

  router.get('/archive/:id', (req, res) => {
    const id = Number(req.params.id);
    let campaign;
    try {
      campaign = Number.isInteger(id) ? campaigns.find(id) : null;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
    if (!campaign || !campaign.archive || campaign.status !== 'sent') return notFoundPage(res);
    sendEmailHtml(res, delivery.preview(campaign, { email: '', first_name: '', last_name: '', attributes: {}, token: '' }).html);
  });

  return { web: router, api: apiRouter };
}
