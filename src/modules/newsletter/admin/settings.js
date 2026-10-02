import { get, post } from '/admin/js/api.js';
import { saveSettings } from '/admin/js/settings.js';
import { ctx } from '/admin/js/state.js';
import { $, formData, html, raw, setHtml, toast, toastError } from '/admin/js/ui.js';

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
    </div>`,
  );

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
