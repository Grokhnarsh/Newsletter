import { mergeTags, renderEmail } from '../../../lib/render.js';
import { addMinutes, now } from '../../../lib/time.js';

/**
 * Versand von Kampagnen und System-Mails (Double-Opt-in, Willkommen, Test)
 * sowie der Hintergrund-Worker für die Versandwarteschlange.
 */
export class DeliveryService {
  constructor({ db, config, mailer, settings, templates, campaigns, subscribers, logger = console, isEnabled = () => true }) {
    Object.assign(this, { db, config, mailer, settings, templates, campaigns, subscribers, logger, isEnabled });
    this.timer = null;
    this.busy = false;
    this.allowance = 0;
    this.lastTick = Date.now();
  }

  url(path) {
    return `${this.config.baseUrl}${path}`;
  }

  /** Platzhalter-Werte für einen Abonnenten. */
  vars(subscriber, { recipientToken, campaign, extra = {} } = {}) {
    const s = this.settings.all();
    const sub = subscriber || { email: '', first_name: '', last_name: '', attributes: {}, token: '' };
    const attributes = typeof sub.attributes === 'string' ? JSON.parse(sub.attributes || '{}') : sub.attributes || {};
    const unsubscribe = sub.token ? this.url(`/unsubscribe/${sub.token}${recipientToken ? `?r=${recipientToken}` : ''}`) : '#';
    let webview = '#';
    if (recipientToken) webview = this.url(`/view/${recipientToken}`);
    else if (campaign?.archive && campaign?.id) webview = this.url(`/archive/${campaign.id}`);
    return {
      email: sub.email,
      first_name: sub.first_name,
      last_name: sub.last_name,
      name: [sub.first_name, sub.last_name].filter(Boolean).join(' '),
      attributes,
      attr: attributes,
      site_name: s.site_name,
      company_address: s.company_address,
      privacy_url: s.privacy_url,
      subject: campaign?.subject ? mergeTags(campaign.subject, { first_name: sub.first_name, site_name: s.site_name }, { escape: false }) : '',
      unsubscribe_url: unsubscribe,
      preferences_url: sub.token ? this.url(`/preferences/${sub.token}`) : '#',
      webview_url: webview,
      archive_url: this.url('/archive'),
      date: new Date().toLocaleDateString('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }),
      year: String(new Date().getFullYear()),
      ...extra,
    };
  }

  layoutFor(campaign) {
    return this.campaigns.layoutFor(campaign);
  }

  /** Rendert eine Kampagne für einen Empfänger (mit Tracking, falls aktiviert). */
  renderForRecipient(campaign, subscriber, recipientToken, { linkMap, tracking = true } = {}) {
    const links = linkMap || this.campaigns.linkMap(campaign.id);
    const trackLink =
      tracking && campaign.track_clicks && recipientToken
        ? (url) => (links.has(url) ? this.url(`/t/c/${recipientToken}/${links.get(url)}`) : null)
        : null;
    const openPixelUrl = tracking && campaign.track_opens && recipientToken ? this.url(`/t/o/${recipientToken}.gif`) : null;
    return renderEmail({
      campaign,
      layout: this.layoutFor(campaign),
      vars: this.vars(subscriber, { recipientToken, campaign }),
      trackLink,
      openPixelUrl,
    });
  }

  /** Vorschau ohne Tracking, mit Beispiel- oder echtem Abonnenten. */
  preview(campaign, subscriber) {
    const sample = subscriber || {
      email: 'max.mustermann@example.com',
      first_name: 'Max',
      last_name: 'Mustermann',
      attributes: {},
      token: 'vorschau',
    };
    return renderEmail({ campaign, layout: this.layoutFor(campaign), vars: this.vars(sample, { campaign }) });
  }

  fromHeader(campaign = {}) {
    return {
      name: campaign.from_name || this.settings.get('sender_name'),
      address: campaign.from_email || this.settings.get('sender_email'),
    };
  }

  async sendTest(campaign, emails) {
    const results = [];
    for (const email of emails) {
      const subscriber = this.subscribers.findByEmail(email);
      const rendered = this.preview(campaign, subscriber);
      await this.mailer.send({
        from: this.fromHeader(campaign),
        replyTo: campaign.reply_to || this.settings.get('reply_to') || undefined,
        to: email,
        subject: `[TEST] ${rendered.subject}`,
        html: rendered.html,
        text: rendered.text,
      });
      results.push(email);
    }
    return results;
  }

  async sendSystemMail(subscriber, subjectTpl, htmlTpl, extraVars = {}) {
    const vars = this.vars(subscriber, { extra: extraVars });
    const rendered = renderEmail({
      campaign: { subject: subjectTpl, content_html: htmlTpl, preheader: '', content_text: '' },
      layout: this.templates.findOptional(this.settings.get('default_template_id'))?.html,
      vars,
    });
    await this.mailer.send({
      from: this.fromHeader(),
      replyTo: this.settings.get('reply_to') || undefined,
      to: subscriber.email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  }

  async sendConfirmation(subscriber) {
    const s = this.settings.all();
    await this.sendSystemMail(subscriber, s.confirm_subject, s.confirm_html, {
      confirm_url: this.url(`/confirm/${subscriber.token}`),
    });
    this.subscribers.markConfirmationSent(subscriber.id);
  }

  async sendWelcome(subscriber) {
    const s = this.settings.all();
    if (!s.welcome_enabled) return;
    await this.sendSystemMail(subscriber, s.welcome_subject, s.welcome_html);
  }

  /** Einmal-Link für Datenauskunft oder Löschung an die Adresse des Abonnenten. */
  async sendPrivacyLink(subscriber, action, actionUrl) {
    const texts = {
      export: {
        subject: 'Deine Daten bei {{site_name}}',
        html: '<p>Hallo {{first_name | "zusammen"}},</p>\n<p>du hast eine Auskunft über deine gespeicherten Daten angefordert. Über diesen Link kannst du sie 24 Stunden lang herunterladen:</p>\n<p><a href="{{action_url}}">Meine Daten herunterladen</a></p>\n<p>Falls du das nicht warst, kannst du diese E-Mail ignorieren.</p>',
      },
      delete: {
        subject: 'Löschung deiner Daten bei {{site_name}} bestätigen',
        html: '<p>Hallo {{first_name | "zusammen"}},</p>\n<p>du möchtest alle bei uns gespeicherten Daten löschen. Bitte bestätige das innerhalb von 24 Stunden über diesen Link:</p>\n<p><a href="{{action_url}}">Löschung bestätigen</a></p>\n<p>Falls du das nicht warst, kannst du diese E-Mail ignorieren – es wird nichts gelöscht.</p>',
      },
    }[action];
    await this.sendSystemMail(subscriber, texts.subject, texts.html, { action_url: actionUrl });
  }

  async sendSettingsTest(to) {
    await this.mailer.send({
      from: this.fromHeader(),
      to,
      subject: `Testnachricht von ${this.settings.get('site_name')}`,
      text: 'Wenn du diese Nachricht liest, funktioniert der E-Mail-Versand.',
      html: '<p>Wenn du diese Nachricht liest, funktioniert der E-Mail-Versand. ✅</p>',
    });
  }

  // ---- Worker ----

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), this.config.worker.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy || !this.isEnabled()) return;
    this.busy = true;
    try {
      const t = Date.now();
      const ratePerMinute = this.settings.get('send_rate_per_minute');
      // Token-Bucket: Kontingent wächst gleichmäßig mit der eingestellten Rate.
      this.allowance = Math.min(ratePerMinute, this.allowance + ((t - this.lastTick) / 60000) * ratePerMinute);
      this.lastTick = t;
      const limit = Math.floor(this.allowance);
      const sent = await this.runOnce({ limit });
      this.allowance -= sent;
    } catch (err) {
      this.logger.error('[worker] Fehler:', err);
    } finally {
      this.busy = false;
    }
  }

  /** Ein Durchlauf: fällige Kampagnen starten, Warteschlange abarbeiten, Abschluss prüfen. */
  async runOnce({ limit = Infinity } = {}) {
    this.campaigns.startDue();
    let processed = 0;
    if (limit > 0) processed = await this.processQueue(limit);
    this.campaigns.finishCompleted();
    return processed;
  }

  async processQueue(limit) {
    const rows = this.db.all(
      `SELECT r.id, r.token, r.attempts, r.campaign_id, r.subscriber_id
       FROM campaign_recipients r JOIN campaigns c ON c.id = r.campaign_id
       WHERE c.status = 'sending' AND r.status = 'queued' AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ?)
       ORDER BY r.id LIMIT ?`,
      now(),
      Number.isFinite(limit) ? limit : -1,
    );
    if (!rows.length) return 0;

    const cache = new Map();
    const campaignFor = (id) => {
      if (!cache.has(id)) cache.set(id, { campaign: this.campaigns.find(id), linkMap: this.campaigns.linkMap(id) });
      return cache.get(id);
    };

    let processed = 0;
    const concurrency = 5;
    for (let i = 0; i < rows.length; i += concurrency) {
      await Promise.all(
        rows.slice(i, i + concurrency).map(async (row) => {
          await this.deliver(row, campaignFor(row.campaign_id));
          processed++;
        }),
      );
    }
    return processed;
  }

  async deliver(row, { campaign, linkMap }) {
    const subscriber = row.subscriber_id ? this.db.get('SELECT * FROM subscribers WHERE id = ?', row.subscriber_id) : null;
    if (!subscriber || subscriber.status !== 'active') {
      this.db.run("UPDATE campaign_recipients SET status = 'skipped', error = ? WHERE id = ?", 'Abonnent nicht mehr aktiv', row.id);
      return;
    }
    try {
      const rendered = this.renderForRecipient(campaign, subscriber, row.token, { linkMap });
      const unsubscribeUrl = this.url(`/unsubscribe/${subscriber.token}?r=${row.token}`);
      const { messageId } = await this.mailer.send({
        from: this.fromHeader(campaign),
        replyTo: campaign.reply_to || this.settings.get('reply_to') || undefined,
        to: subscriber.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          'X-Campaign-ID': String(campaign.id),
          Precedence: 'bulk',
        },
      });
      this.db.run(
        "UPDATE campaign_recipients SET status = 'sent', sent_at = ?, message_id = ?, attempts = attempts + 1, error = NULL WHERE id = ?",
        now(),
        messageId || null,
        row.id,
      );
    } catch (err) {
      const attempts = row.attempts + 1;
      const failed = attempts >= this.config.worker.maxAttempts;
      this.db.run(
        'UPDATE campaign_recipients SET status = ?, attempts = ?, error = ?, next_attempt_at = ? WHERE id = ?',
        failed ? 'failed' : 'queued',
        attempts,
        String(err.message || err).slice(0, 500),
        failed ? null : addMinutes(now(), 2 ** attempts),
        row.id,
      );
      this.logger.warn(`[worker] Versand an ${subscriber.email} fehlgeschlagen (Versuch ${attempts}): ${err.message}`);
    }
  }
}
