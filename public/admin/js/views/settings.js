import { del, get, post, put } from '../api.js';
import { ctx, navigate } from '../state.js';
import { $, $$, confirmDialog, fmtDateTime, formData, html, modal, raw, setHtml, toast, toastError } from '../ui.js';

const TABS = [
  ['general', 'Allgemein'],
  ['emails', 'System-E-Mails'],
  ['users', 'Benutzer', true],
  ['api', 'API & Integration', true],
];

const TRANSPORT_INFO = {
  smtp: 'SMTP – E-Mails werden über den konfigurierten SMTP-Server versendet.',
  file: 'Datei – E-Mails werden nur als .eml-Dateien im Outbox-Ordner gespeichert (Entwicklungsmodus). Für den Echtbetrieb SMTP_URL setzen.',
  log: 'Log – E-Mails werden nur auf der Konsole protokolliert (Entwicklungsmodus).',
};

export async function settingsView(el, tab = 'general') {
  const tabs = TABS.filter(([, , adminOnly]) => !adminOnly || ctx.isAdmin);
  setHtml(
    el,
    html`<div class="page-head"><div><h1>Einstellungen</h1><div class="sub">${ctx.isAdmin ? '' : 'Nur Administratoren können Einstellungen ändern.'}</div></div></div>
      <div class="tabs" role="tablist">${tabs.map(([k, label]) => html`<button role="tab" class="${k === tab ? 'active' : ''}" data-tab="${k}">${label}</button>`)}</div>
      <div id="tab"></div>`,
  );
  $$('[data-tab]', el).forEach((b) => b.addEventListener('click', () => navigate(`#/settings/${b.dataset.tab}`)));
  const box = $('#tab', el);
  if (tab === 'general') return generalTab(box);
  if (tab === 'emails') return emailsTab(box);
  if (tab === 'users' && ctx.isAdmin) return usersTab(box);
  if (tab === 'api' && ctx.isAdmin) return apiTab(box);
  navigate('#/settings');
}

async function saveSettings(data) {
  const saved = await put('/settings', data);
  ctx.settings = saved;
  window.dispatchEvent(new CustomEvent('settings:changed', { detail: saved }));
  toast('Einstellungen gespeichert');
  return saved;
}

async function generalTab(box) {
  const [s, templates] = await Promise.all([ctx.getSettings(true), get('/templates')]);
  const disabled = ctx.isAdmin ? '' : raw('disabled');
  setHtml(
    box,
    html`<form id="general" class="stack">
      <div class="card">
        <h2>Newsletter &amp; Absender</h2>
        <div class="field"><label for="s-site">Name des Newsletters</label><input id="s-site" name="site_name" type="text" value="${s.site_name}" ${disabled}></div>
        <div class="inline-fields">
          <div class="field"><label for="s-sname">Absendername</label><input id="s-sname" name="sender_name" type="text" value="${s.sender_name}" ${disabled}></div>
          <div class="field"><label for="s-semail">Absender-E-Mail</label><input id="s-semail" name="sender_email" type="email" value="${s.sender_email}" required ${disabled}>
            <div class="help">Die Domain sollte per SPF/DKIM/DMARC für deinen SMTP-Server autorisiert sein.</div></div>
        </div>
        <div class="field"><label for="s-reply">Antwortadresse (optional)</label><input id="s-reply" name="reply_to" type="email" value="${s.reply_to}" ${disabled}></div>
        <div class="field"><label for="s-addr">Impressum / Postanschrift (Fußzeile)</label><textarea id="s-addr" name="company_address" ${disabled}>${s.company_address}</textarea>
          <div class="help">Platzhalter <code>{{company_address}}</code>. In Deutschland ist eine Anbieterkennzeichnung im Newsletter Pflicht.</div></div>
        <div class="field"><label for="s-privacy">Link zur Datenschutzerklärung</label><input id="s-privacy" name="privacy_url" type="url" value="${s.privacy_url}" placeholder="https://" ${disabled}></div>
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

async function emailsTab(box) {
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

function userDialog(user, onSaved) {
  modal({
    title: user ? 'Benutzer bearbeiten' : 'Benutzer anlegen',
    body: html`
      <div class="field"><label for="u-name">Name</label><input id="u-name" name="name" type="text" value="${user?.name || ''}"></div>
      <div class="field"><label for="u-email">E-Mail *</label><input id="u-email" name="email" type="email" required value="${user?.email || ''}"></div>
      <div class="field"><label for="u-role">Rolle</label><select id="u-role" name="role">
        <option value="editor" ${user?.role === 'editor' ? raw('selected') : ''}>Redakteur – Kampagnen, Abonnenten, Listen, Vorlagen</option>
        <option value="admin" ${user?.role === 'admin' ? raw('selected') : ''}>Administrator – zusätzlich Einstellungen, Benutzer, API</option>
      </select></div>
      <div class="field"><label for="u-pw">${user ? 'Neues Passwort (optional)' : 'Passwort *'}</label><input id="u-pw" name="password" type="password" minlength="10" ${user ? '' : raw('required')} autocomplete="new-password"><div class="help">Mindestens 10 Zeichen</div></div>`,
    onSubmit: async (form) => {
      const d = formData(form);
      if (!d.password) delete d.password;
      if (user) await put(`/users/${user.id}`, d);
      else await post('/users', d);
      toast('Benutzer gespeichert');
      onSaved();
    },
  });
}

async function usersTab(box) {
  const users = await get('/users');
  setHtml(
    box,
    html`<div class="card">
      <div class="card-head"><h2>Benutzer</h2><button class="btn btn-primary" id="add-user">+ Benutzer</button></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>Letzte Anmeldung</th><th></th></tr></thead>
        <tbody>${users.map(
          (u) => html`<tr><td>${u.name || '–'}</td><td>${u.email}</td>
            <td>${u.role === 'admin' ? html`<span class="badge badge-info">Administrator</span>` : html`<span class="badge badge-muted">Redakteur</span>`}</td>
            <td class="small">${fmtDateTime(u.last_login_at)}</td>
            <td class="right nowrap"><button class="btn btn-sm" data-edit="${u.id}">Bearbeiten</button>
              ${u.id !== ctx.user.id ? html`<button class="btn btn-sm btn-ghost" data-del="${u.id}" aria-label="Löschen">🗑</button>` : ''}</td></tr>`,
        )}</tbody>
      </table></div>
    </div>`,
  );
  const reload = () => usersTab(box);
  $('#add-user', box).addEventListener('click', () => userDialog(null, reload));
  $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => userDialog(users.find((u) => u.id === Number(b.dataset.edit)), reload)));
  $$('[data-del]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const u = users.find((x) => x.id === Number(b.dataset.del));
      if (!(await confirmDialog('Benutzer löschen', `${u.email} löschen?`, { submitLabel: 'Löschen' }))) return;
      try {
        await del(`/users/${u.id}`);
        toast('Benutzer gelöscht');
        reload();
      } catch (err) {
        toastError(err);
      }
    }),
  );
}

async function apiTab(box) {
  const keys = await get('/api-keys');
  const base = location.origin;
  setHtml(
    box,
    html`<div class="card">
      <div class="card-head"><h2>API-Schlüssel</h2><button class="btn btn-primary" id="add-key">+ Schlüssel erstellen</button></div>
      <p class="muted">API-Schlüssel erlauben externen Systemen Zugriff mit Redakteursrechten (Abonnenten, Listen, Kampagnen, Vorlagen, Webhooks).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Präfix</th><th>Erstellt</th><th>Zuletzt genutzt</th><th></th></tr></thead>
        <tbody>${
          keys.length
            ? keys.map(
                (k) => html`<tr><td>${k.name}</td><td><code>${k.prefix}…</code></td><td class="small">${fmtDateTime(k.created_at)}${k.created_by_email ? html`<div class="muted">${k.created_by_email}</div>` : ''}</td>
                  <td class="small">${fmtDateTime(k.last_used_at)}</td><td class="right"><button class="btn btn-sm btn-ghost" data-del="${k.id}">Widerrufen</button></td></tr>`,
              )
            : html`<tr><td colspan="5" class="empty">Noch keine API-Schlüssel.</td></tr>`
        }</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Integration</h2>
      <h3>Authentifizierung</h3>
      <pre class="keybox">Authorization: Bearer nlk_…</pre>
      <h3 style="margin-top:16px">Abonnent per API anlegen</h3>
      <pre class="keybox">curl -X POST ${base}/api/subscribers \\
  -H "Authorization: Bearer nlk_…" -H "Content-Type: application/json" \\
  -d '{"email":"anna@example.com","first_name":"Anna","list_ids":[1]}'</pre>
      <h3 style="margin-top:16px">Öffentliche Anmeldung (mit Double-Opt-in, ohne Schlüssel)</h3>
      <pre class="keybox">POST ${base}/api/public/subscribe  {"email":"…","first_name":"…","list_ids":[1]}</pre>
      <h3 style="margin-top:16px">Bounce-/Beschwerde-Webhook</h3>
      <pre class="keybox">POST ${base}/api/webhooks/bounce  {"email":"…","type":"hard|soft|complaint","reason":"…"}</pre>
      <p class="muted small">Hard-Bounces und Beschwerden sperren die Adresse sofort, drei Soft-Bounces innerhalb von 30 Tagen ebenfalls.</p>
    </div>`,
  );
  const reload = () => apiTab(box);
  $('#add-key', box).addEventListener('click', () =>
    modal({
      title: 'API-Schlüssel erstellen',
      submitLabel: 'Erstellen',
      body: html`<div class="field"><label for="k-name">Bezeichnung</label><input id="k-name" name="name" type="text" required placeholder="z. B. Website-Shop"></div>`,
      onSubmit: async (form) => {
        const key = await post('/api-keys', { name: form.name.value });
        modal({
          title: 'Schlüssel erstellt',
          cancelLabel: 'Fertig',
          body: html`<p>Kopiere den Schlüssel jetzt – er wird aus Sicherheitsgründen <strong>nicht erneut angezeigt</strong>.</p><div class="keybox">${key.key}</div>`,
        });
        reload();
      },
    }),
  );
  $$('[data-del]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Schlüssel widerrufen', 'Anwendungen mit diesem Schlüssel verlieren sofort den Zugriff.', { submitLabel: 'Widerrufen' }))) return;
      try {
        await del(`/api-keys/${b.dataset.del}`);
        toast('Schlüssel widerrufen');
        reload();
      } catch (err) {
        toastError(err);
      }
    }),
  );
}
