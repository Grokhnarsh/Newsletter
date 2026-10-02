/**
 * Rendering von Newsletter-HTML: Platzhalter (Merge-Tags), Layout-Vorlagen,
 * Link-Tracking, Öffnungs-Pixel und Text-Alternative.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

export const CONTENT_TAG_RE = /\{\{\{\s*content\s*\}\}\}|\{\{\s*content\s*\}\}/;

/** Eingebautes Standard-Layout, falls keine Vorlage gewählt wurde. */
export const DEFAULT_LAYOUT = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{subject}}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;">
<tr><td style="padding:24px 32px;border-bottom:1px solid #e5e7eb;font-size:20px;font-weight:bold;">{{site_name}}</td></tr>
<tr><td style="padding:32px;font-size:16px;line-height:1.6;">{{{content}}}</td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:#6b7280;">
{{company_address}}<br>
<a href="{{webview_url}}" style="color:#6b7280;">Im Browser ansehen</a> ·
<a href="{{preferences_url}}" style="color:#6b7280;">Einstellungen</a> ·
<a href="{{unsubscribe_url}}" style="color:#6b7280;">Abmelden</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

/** Setzt den Kampagneninhalt in das Layout ein. */
export function applyLayout(layoutHtml, contentHtml) {
  const layout = layoutHtml && CONTENT_TAG_RE.test(layoutHtml) ? layoutHtml : DEFAULT_LAYOUT;
  // Funktion als Ersatz, damit `$` im Inhalt nicht als Regex-Rückverweis gilt
  return layout.replace(CONTENT_TAG_RE, () => contentHtml || '');
}

function lookup(vars, path) {
  let cur = vars;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
  }
  return cur;
}

/**
 * Ersetzt Merge-Tags. Unterstützt:
 *   {{first_name}}               – HTML-escaped
 *   {{first_name | "Leser"}}     – mit Standardwert
 *   {{{raw_value}}}              – ohne Escaping
 *   {{attributes.firma}}         – benutzerdefinierte Felder
 */
export function mergeTags(template, vars, { escape = true } = {}) {
  return String(template ?? '').replace(
    /\{\{(\{)?\s*([a-zA-Z_][\w.]*)\s*(?:\|\s*(?:"([^"]*)"|'([^']*)'|([^}]*?)))?\s*\}?\}\}/g,
    (match, triple, name, dq, sq, bare) => {
      if (name === 'content') return match;
      let value = lookup(vars, name);
      if (value === undefined || value === null || value === '') value = dq ?? sq ?? (bare !== undefined ? bare.trim() : '');
      if (typeof value === 'object') value = JSON.stringify(value);
      return triple || !escape ? String(value) : escapeHtml(value);
    },
  );
}

/** Fügt einen versteckten Vorschautext (Preheader) direkt nach <body> ein. */
export function injectPreheader(html, preheader) {
  if (!preheader) return html;
  const span = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`;
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, (m) => m + span) : span + html;
}

export function injectBeforeBodyEnd(html, snippet) {
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, () => `${snippet}</body>`) : html + snippet;
}

const HREF_RE = /(<a\b[^>]*?\bhref\s*=\s*)(["'])(.*?)\2/gis;

function decodeHref(href) {
  return href.replace(/&amp;/g, '&').trim();
}

/** Liefert alle trackbaren http(s)-Links eines HTML-Dokuments. */
export function extractLinks(html) {
  const urls = new Set();
  for (const m of String(html).matchAll(HREF_RE)) {
    const url = decodeHref(m[3]);
    if (isTrackable(url)) urls.add(url);
  }
  return [...urls];
}

function isTrackable(url) {
  return /^https?:\/\//i.test(url) && !url.includes('{{');
}

/** Ersetzt trackbare Links über die Callback-Funktion `mapUrl(url) => neueUrl|null`. */
export function rewriteLinks(html, mapUrl) {
  return String(html).replace(HREF_RE, (match, prefix, quote, href) => {
    const url = decodeHref(href);
    if (!isTrackable(url)) return match;
    const replacement = mapUrl(url);
    return replacement ? `${prefix}${quote}${escapeHtml(replacement)}${quote}` : match;
  });
}

/** Einfache HTML-zu-Text-Konvertierung für die Text-Alternative. */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<div style="display:none[^>]*>[\s\S]*?<\/div>/gi, '');
  text = text.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (m, q, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, '').trim();
    const url = decodeHref(href);
    if (!label || label === url) return url;
    return `${label} (${url})`;
  });
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<li[^>]*>/gi, '\n• ');
  text = text.replace(/<h[1-6][^>]*>/gi, '\n\n');
  text = text.replace(/<\/(p|div|h[1-6]|tr|table|ul|ol|blockquote)>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&zwnj;|&#847;/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Baut die vollständige, personalisierte E-Mail.
 * @param {object} opts
 * @param {object} opts.campaign       subject, preheader, content_html, content_text
 * @param {string} [opts.layout]       HTML der Vorlage (mit {{{content}}})
 * @param {object} opts.vars           Platzhalter-Werte
 * @param {function} [opts.trackLink]  url => Tracking-URL
 * @param {string} [opts.openPixelUrl] URL des Öffnungs-Pixels
 */
export function renderEmail({ campaign, layout, vars, trackLink, openPixelUrl }) {
  let html = applyLayout(layout, campaign.content_html);
  // Abmeldelink ist Pflicht – falls die Vorlage keinen enthält, wird er ergänzt.
  if (!/\{\{\{?\s*unsubscribe_url/.test(html)) {
    html = injectBeforeBodyEnd(
      html,
      '<p style="font-size:12px;color:#6b7280;text-align:center;padding:16px;">Du möchtest diesen Newsletter nicht mehr erhalten? <a href="{{unsubscribe_url}}" style="color:#6b7280;">Hier abmelden</a>.</p>',
    );
  }
  if (trackLink) html = rewriteLinks(html, trackLink);
  html = mergeTags(html, vars);
  html = injectPreheader(html, mergeTags(campaign.preheader, vars, { escape: false }));
  if (openPixelUrl) {
    html = injectBeforeBodyEnd(html, `<img src="${escapeHtml(openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;">`);
  }
  const subject = mergeTags(campaign.subject, vars, { escape: false });
  const text = campaign.content_text
    ? mergeTags(campaign.content_text, vars, { escape: false })
    : htmlToText(html);
  return { subject, html, text };
}
