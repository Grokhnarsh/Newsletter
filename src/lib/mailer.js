import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';

/**
 * Erstellt den E-Mail-Versand. Transportarten:
 *  - smtp: Versand über SMTP (SMTP_URL oder SMTP_HOST/PORT/USER/PASS)
 *  - file: speichert jede Mail als .eml-Datei im Outbox-Ordner (Entwicklung)
 *  - log:  gibt die Mails nur auf der Konsole aus
 */
export function createMailer(mailConfig, logger = console) {
  let transport;
  const kind = mailConfig.transport;

  if (kind === 'smtp') {
    transport = mailConfig.smtpUrl
      ? nodemailer.createTransport(mailConfig.smtpUrl, { pool: true })
      : nodemailer.createTransport({
          pool: true,
          host: mailConfig.smtpHost,
          port: mailConfig.smtpPort,
          secure: mailConfig.smtpSecure,
          auth: mailConfig.smtpUser ? { user: mailConfig.smtpUser, pass: mailConfig.smtpPass } : undefined,
        });
  } else if (kind === 'file') {
    transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    fs.mkdirSync(mailConfig.outboxDir, { recursive: true });
  } else if (kind === 'log') {
    transport = nodemailer.createTransport({ jsonTransport: true });
  } else {
    throw new Error(`Unbekannter MAIL_TRANSPORT: ${kind}`);
  }

  return {
    kind,
    async send(message) {
      const info = await transport.sendMail({ ...message, disableFileAccess: true, disableUrlAccess: true });
      if (kind === 'file') {
        const safeTo = String(message.to).replace(/[^a-z0-9@._-]/gi, '_');
        const file = path.join(mailConfig.outboxDir, `${Date.now()}-${safeTo}.eml`);
        await fs.promises.writeFile(file, info.message);
      } else if (kind === 'log') {
        logger.log(`[mail] an ${message.to}: ${message.subject}`);
      }
      return { messageId: info.messageId };
    },
    async verify() {
      if (kind !== 'smtp') return { ok: true, info: `Transport "${kind}" (kein SMTP)` };
      await transport.verify();
      return { ok: true, info: 'SMTP-Verbindung erfolgreich' };
    },
    close() {
      transport.close?.();
    },
  };
}

/** Mailer für Tests: speichert alle Nachrichten im Speicher. */
export function createMemoryMailer() {
  const sent = [];
  return {
    kind: 'memory',
    sent,
    failFor: new Set(),
    async send(message) {
      if (this.failFor.has(message.to)) throw new Error('Simulierter Versandfehler');
      sent.push(message);
      return { messageId: `<${sent.length}@memory>` };
    },
    async verify() {
      return { ok: true, info: 'memory' };
    },
    close() {},
  };
}
