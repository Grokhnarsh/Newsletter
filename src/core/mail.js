import { escapeHtml, htmlToText } from '../lib/render.js';

export const MAIL_SETTINGS = {
  defaults: { sender_name: 'Website', sender_email: 'noreply@example.com', reply_to: '' },
  rules: {
    sender_name: { type: 'string', max: 200 },
    sender_email: { type: 'email' },
    reply_to: { type: 'string', max: 254 },
  },
};

/** Systemmails des Kerns (Passwort-Reset, Benachrichtigungen von Modulen). */
export class SystemMail {
  constructor({ mailer, settings, logger = console }) {
    Object.assign(this, { mailer, settings, logger });
  }

  /** Einfache, gut lesbare HTML-Mail mit Textalternative. */
  layout(title, bodyHtml) {
    const site = escapeHtml(this.settings.get('site_name'));
    return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:20px 28px;border-bottom:1px solid #e5e7eb;font-weight:bold;">${site}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
</table></td></tr></table></body></html>`;
  }

  async send({ to, subject, html, replyTo }) {
    const full = this.layout(subject, html);
    return this.mailer.send({
      from: { name: this.settings.get('sender_name'), address: this.settings.get('sender_email') },
      replyTo: replyTo || this.settings.get('reply_to') || undefined,
      to,
      subject,
      html: full,
      text: htmlToText(full),
    });
  }

  button(url, label) {
    return `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2a78d6;color:#ffffff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">${escapeHtml(label)}</a></p>`;
  }
}
