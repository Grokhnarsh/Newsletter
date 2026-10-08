import { get, post } from '/admin/js/api.js';
import { saveSettings } from '/admin/js/settings.js';
import { ctx } from '/admin/js/state.js';
import { $, confirmDialog, formData, html, raw, setHtml, toast, toastError } from '/admin/js/ui.js';

const TRANSPORT_INFO = {
  smtp: 'SMTP – E-Mails werden über den konfigurierten SMTP-Server versendet.',
  file: 'Datei – E-Mails werden nur als .eml-Dateien im Outbox-Ordner gespeichert (Entwicklungsmodus). Für den Echtbetrieb SMTP_URL setzen.',
  log: 'Log – E-Mails werden nur auf der Konsole protokolliert (Entwicklungsmodus).',
};

export async function newsletterSettingsTab(box) {
  const [s, templates] = await Promise.all([ctx.getSettings(true), get('/templates')]);
  const disabled = ctx.isAdmin ? '' : raw('disabled');
  setHtml(
    box,
    html`<form id="general" class="stack">
      <div class="card">
        <h2>Newsletter &amp; Absender</h2>
        <div class="inline-fields">
          <div class="field"><label for="s-sname">Absendername</label><input id="s-sname" name="sender_name" type="text" value="${s.sender_name}" ${disabled}></div>
          <div class="field"><label for="s-semail">Absender-E-Mail</label><input id="s-semail" name="sender_email" type="email" value="${s.sender_email}" required ${disabled}>
            <div class="help">Die Domain sollte per SPF/DKIM/DMARC für deinen SMTP-Server autorisiert sein.</div></div>
        </div>
        <div class="field"><label for="s-reply">Antwortadresse (optional)</label><input id="s-reply" name="reply_to" type="email" value="${s.reply_to}" ${disabled}></div>
        <p class="muted small">Postanschrift und Datenschutzlink werden unter Einstellungen › Website gepflegt und als <code>{{company_address}}</code> bzw. <code>{{privacy_url}}</code> in Newslettern genutzt.</p>
      </div>
      <div class="card">
        <h2>Anmeldung &amp; Versand</h2>
        <label class="checkline"><input type="checkbox" name="double_opt_in" ${s.double_opt_in ? raw('checked') : ''} ${disabled}> Double-Opt-in (Bestätigung per E-Mail – empfohlen und in der EU üblich)</label>
        <div class="inline-fields" style="margin-top:12px">
          <div class="field"><label for="s-rate">Versandrate (E-Mails pro Minute)</label><input id="s-rate" name="send_rate_per_minute" type="number" min="1" max="100000" value="${s.send_rate_per_minute}" ${disabled}>
            <div class="help">An die Limits deines E-Mail-Anbieters anpassen.</div></div>
          <div class="field"><label for="s-tpl">Standardvorlage</label><select id="s-tpl" name="default_template_id" ${disabled}>
            <option value="">Eingebautes Layout</option>${templates.map((t) => html`<option value="${t.id}" ${s.default_template_id === t.id ? raw('selected') : ''}>${t.name}</option>`)}
          </select></div>
        </div>
      </div>
      <div class="card">
        <h2>Öffnungs- und Klick-Tracking</h2>
        <div class="field"><label for="s-track">Tracking</label><select id="s-track" name="tracking_mode" ${disabled}>
          <option value="all" ${s.tracking_mode === 'all' ? raw('selected') : ''}>Für alle Abonnenten (je Kampagne abschaltbar)</option>
          <option value="consent" ${s.tracking_mode === 'consent' ? raw('selected') : ''}>Nur mit ausdrücklicher Einwilligung</option>
          <option value="off" ${s.tracking_mode === 'off' ? raw('selected') : ''}>Aus – keine Öffnungs- und Klickauswertung</option>
        </select><div class="help">Mit „Einwilligung“ erscheint im Anmeldeformular und auf der Einstellungsseite der Abonnenten ein zusätzliches Häkchen.</div></div>
        <div class="field"><label for="s-ctext">Text der Einwilligung</label><textarea id="s-ctext" name="tracking_consent_text" maxlength="1000" style="min-height:70px" ${disabled}>${s.tracking_consent_text}</textarea></div>
      </div>
      <div class="card">
        <h2>Website-Integration</h2>
        <label class="checkline"><input type="checkbox" name="newsletter_footer_widget" ${s.newsletter_footer_widget ? raw('checked') : ''} ${disabled}> Anmeldeformular in der Fußzeile der Website anzeigen</label>
        <label class="checkline"><input type="checkbox" name="newsletter_auto_campaign" ${s.newsletter_auto_campaign ? raw('checked') : ''} ${disabled}> Neue Blogbeiträge automatisch als Kampagnenentwurf anlegen</label>
        <p class="muted small">Auf jeder Seite einsetzbar: Baustein <code>[newsletter_form]</code>.</p>
      </div>
      ${ctx.isAdmin ? html`<div><button class="btn btn-primary" type="submit">Speichern</button></div>` : ''}
    </form>
    <div class="card">
      <h2>E-Mail-Versand</h2>
      <p><span class="badge badge-${s.mail_transport === 'smtp' ? 'good' : 'warn'}">${s.mail_transport}</span> ${TRANSPORT_INFO[s.mail_transport] || ''}</p>
      ${
        ctx.isAdmin
          ? html`<form id="test-mail" class="toolbar"><input type="email" name="to" required value="${ctx.user.email}" style="max-width:300px" aria-label="Empfänger"><button class="btn" type="submit">Testnachricht senden</button></form>`
          : ''
      }
    </div>
    <div class="card">
      <h2>Bounce- und Beschwerde-Webhooks</h2>
      <p class="muted">Trage die passende Adresse beim E-Mail-Anbieter als Webhook für Bounces und Spam-Beschwerden ein. Betroffene Adressen werden automatisch gesperrt
      (Hard-Bounce und Beschwerde sofort, Soft-Bounces nach drei Fehlschlägen in 30 Tagen). Bei Amazon SES ein SNS-Thema mit HTTPS-Abonnement auf die Adresse anlegen – die Bestätigung erfolgt automatisch.</p>
      <div class="table-wrap"><table><tbody id="hook-rows"><tr><td class="muted">Lädt …</td></tr></tbody></table></div>
      ${ctx.isAdmin ? html`<button class="btn btn-sm" id="hook-renew" style="margin-top:10px">Adressen erneuern</button>` : ''}
    </div>`,
  );

  const renderHooks = (rows) =>
    setHtml(
      $('#hook-rows', box),
      html`${rows.map(
        (h) => html`<tr><td class="nowrap"><strong>${h.label}</strong></td><td><code style="overflow-wrap:anywhere">${h.url}</code></td>
          <td class="right"><button class="btn btn-sm" data-copy="${h.url}">Kopieren</button></td></tr>`,
      )}`,
    );
  get('/newsletter/bounce-urls').then(renderHooks).catch(toastError);
  $('#hook-rows', box).addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast('Adresse kopiert');
    } catch {
      toast('Kopieren nicht möglich – bitte manuell markieren', 'error');
    }
  });
  $('#hook-renew', box)?.addEventListener('click', async () => {
    if (!(await confirmDialog('Webhook-Adressen erneuern', 'Die bisherigen Adressen funktionieren danach nicht mehr und müssen beim Anbieter ersetzt werden.', { submitLabel: 'Erneuern' }))) return;
    try {
      renderHooks(await post('/newsletter/bounce-urls/renew'));
      toast('Neue Adressen erzeugt');
    } catch (err) {
      toastError(err);
    }
  });

  $('#general', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    d.send_rate_per_minute = Number(d.send_rate_per_minute);
    d.default_template_id = d.default_template_id ? Number(d.default_template_id) : null;
    try {
      await saveSettings(d);
    } catch (err) {
      toastError(err);
    }
  });
  $('#test-mail', box)?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await post('/settings/test-email', { to: e.target.to.value });
      toast(res.message);
    } catch (err) {
      toastError(err);
    }
  });
}

export async function emailsSettingsTab(box) {
  const s = await ctx.getSettings(true);
  const disabled = ctx.isAdmin ? '' : raw('disabled');
  setHtml(
    box,
    html`<form id="emails" class="stack">
      <div class="card">
        <h2>Bestätigungs-E-Mail (Double-Opt-in)</h2>
        <div class="field"><label for="e-cs">Betreff</label><input id="e-cs" name="confirm_subject" type="text" value="${s.confirm_subject}" ${disabled}></div>
        <div class="field"><label for="e-ch">Inhalt (HTML)</label><textarea id="e-ch" name="confirm_html" class="code" style="min-height:180px" ${disabled}>${s.confirm_html}</textarea>
          <div class="help">Muss <code>{{confirm_url}}</code> enthalten.</div></div>
      </div>
      <div class="card">
        <h2>Willkommens-E-Mail</h2>
        <label class="checkline"><input type="checkbox" name="welcome_enabled" ${s.welcome_enabled ? raw('checked') : ''} ${disabled}> Nach erfolgreicher Anmeldung eine Willkommens-E-Mail senden</label>
        <div class="field" style="margin-top:12px"><label for="e-ws">Betreff</label><input id="e-ws" name="welcome_subject" type="text" value="${s.welcome_subject}" ${disabled}></div>
        <div class="field"><label for="e-wh">Inhalt (HTML)</label><textarea id="e-wh" name="welcome_html" class="code" style="min-height:180px" ${disabled}>${s.welcome_html}</textarea></div>
      </div>
      ${ctx.isAdmin ? html`<div><button class="btn btn-primary" type="submit">Speichern</button></div>` : ''}
    </form>`,
  );
  $('#emails', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.confirm_html.includes('{{confirm_url}}')) return toastError(new Error('Die Bestätigungs-E-Mail muss {{confirm_url}} enthalten'));
    try {
      await saveSettings(d);
    } catch (err) {
      toastError(err);
    }
  });
}
