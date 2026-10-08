// Bounce- und Beschwerde-Meldungen gängiger E-Mail-Provider in ein einheitliches Format übersetzen:
// [{ email, type: 'hard' | 'soft' | 'complaint', reason }]

export const PROVIDERS = {
  ses: 'Amazon SES (über SNS)',
  mailgun: 'Mailgun',
  postmark: 'Postmark',
  brevo: 'Brevo (Sendinblue)',
  sendgrid: 'SendGrid',
  generic: 'Allgemein (JSON: email, type, reason)',
};

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

function ses(body) {
  // SNS liefert die SES-Meldung als JSON-Text im Feld „Message“
  let msg = body;
  if (body?.Type === 'Notification' && typeof body.Message === 'string') {
    try {
      msg = JSON.parse(body.Message);
    } catch {
      return [];
    }
  }
  const type = msg?.notificationType || msg?.eventType;
  if (type === 'Bounce') {
    const kind = msg.bounce?.bounceType === 'Permanent' ? 'hard' : 'soft';
    return (msg.bounce?.bouncedRecipients || []).map((r) => ({
      email: str(r.emailAddress),
      type: kind,
      reason: str(r.diagnosticCode || `${msg.bounce.bounceType}/${msg.bounce.bounceSubType}`),
    }));
  }
  if (type === 'Complaint') {
    return (msg.complaint?.complainedRecipients || []).map((r) => ({ email: str(r.emailAddress), type: 'complaint', reason: str(msg.complaint.complaintFeedbackType || 'complaint') }));
  }
  return [];
}

function mailgun(body) {
  const e = body?.['event-data'];
  if (!e) return [];
  if (e.event === 'failed') {
    return [{ email: str(e.recipient), type: e.severity === 'permanent' ? 'hard' : 'soft', reason: str(e['delivery-status']?.description || e['delivery-status']?.message || e.reason) }];
  }
  if (e.event === 'complained') return [{ email: str(e.recipient), type: 'complaint', reason: 'complaint' }];
  return [];
}

const POSTMARK_SOFT = new Set(['SoftBounce', 'Transient', 'DnsError', 'AutoResponder', 'MailFrontend']);
function postmark(body) {
  if (body?.RecordType === 'SpamComplaint') return [{ email: str(body.Email), type: 'complaint', reason: 'SpamComplaint' }];
  if (body?.RecordType === 'Bounce') {
    return [{ email: str(body.Email), type: POSTMARK_SOFT.has(body.Type) ? 'soft' : 'hard', reason: str(body.Description || body.Type) }];
  }
  return [];
}

function brevo(body) {
  const map = { hard_bounce: 'hard', invalid_email: 'hard', blocked: 'hard', soft_bounce: 'soft', spam: 'complaint', complaint: 'complaint' };
  const events = Array.isArray(body) ? body : [body];
  return events.filter((e) => map[e?.event]).map((e) => ({ email: str(e.email), type: map[e.event], reason: str(e.reason || e.event) }));
}

function sendgrid(body) {
  const events = Array.isArray(body) ? body : [body];
  const out = [];
  for (const e of events) {
    if (e?.event === 'bounce') out.push({ email: str(e.email), type: e.type === 'blocked' ? 'soft' : 'hard', reason: str(e.reason || e.status) });
    else if (e?.event === 'dropped' && /bounce|invalid/i.test(str(e.reason))) out.push({ email: str(e.email), type: 'hard', reason: str(e.reason) });
    else if (e?.event === 'spamreport') out.push({ email: str(e.email), type: 'complaint', reason: 'spamreport' });
  }
  return out;
}

function generic(body) {
  const items = Array.isArray(body) ? body : [body];
  return items
    .filter((i) => i?.email)
    .map((i) => ({ email: str(i.email), type: ['hard', 'soft', 'complaint'].includes(i.type) ? i.type : 'hard', reason: str(i.reason) }));
}

const PARSERS = { ses, mailgun, postmark, brevo, sendgrid, generic };

/** Meldungen eines Providers auslesen (max. 1000 Einträge je Aufruf). */
export function parseBounces(provider, body) {
  const parse = PARSERS[provider];
  if (!parse) return null;
  return parse(body)
    .filter((b) => b.email && b.email.length <= 254)
    .slice(0, 1000)
    .map((b) => ({ ...b, reason: b.reason.slice(0, 500) }));
}

/** Nur echte SNS-Adressen von AWS dürfen zur Bestätigung eines Abonnements aufgerufen werden. */
export function isSnsUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname);
  } catch {
    return false;
  }
}
