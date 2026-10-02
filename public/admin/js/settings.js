import { registry } from './registry.js';
import { del, get, post, put } from './api.js';
import { ctx, navigate } from './state.js';
import { $, $$, confirmDialog, fmtDateTime, formData, html, modal, raw, setHtml, toast, toastError } from './ui.js';

const CORE_TABS = [
  { id: 'website', label: 'Website', order: 0, render: websiteTab },
  { id: 'modules', label: 'Module', order: 80, adminOnly: true, render: modulesTab },
  { id: 'users', label: 'Benutzer', order: 90, adminOnly: true, render: usersTab },
  { id: 'api', label: 'API', order: 95, adminOnly: true, render: apiTab },
];

export async function settingsView(el, tab = 'website') {
  const tabs = [...CORE_TABS, ...registry.settingsTabs].filter((t) => !t.adminOnly || ctx.isAdmin).sort((a, b) => a.order - b.order);
  const current = tabs.find((t) => t.id === tab);
  if (!current) return navigate('#/settings');
  setHtml(
    el,
    html`<div class="page-head"><div><h1>Einstellungen</h1><div class="sub">${ctx.isAdmin ? '' : 'Nur Administratoren können Einstellungen ändern.'}</div></div></div>
      <div class="tabs" role="tablist">${tabs.map((t) => html`<button role="tab" class="${t.id === tab ? 'active' : ''}" data-tab="${t.id}">${t.label}</button>`)}</div>
      <div id="tab"></div>`,
  );
  $$('[data-tab]', el).forEach((b) => b.addEventListener('click', () => navigate(`#/settings/${b.dataset.tab}`)));
  return current.render($('#tab', el));
}

/** Speichert Einstellungen und benachrichtigt die Oberfläche. */
export async function saveSettings(data) {
  const saved = await put('/settings', data);
  ctx.settings = saved;
  window.dispatchEvent(new CustomEvent('settings:changed', { detail: saved }));
  toast('Einstellungen gespeichert');
  return saved;
}

async function websiteTab(box) {
  const s = await ctx.getSettings(true);
  const pages = registry.modules.some((m) => m.name === 'pages' && m.enabled) ? await get('/pages') : null;
  const disabled = ctx.isAdmin ? '' : raw('disabled');
  setHtml(
    box,
    html`<form id="website" class="stack">
      <div class="card">
        <h2>Allgemein</h2>
        <div class="field"><label for="w-name">Name der Website</label><input id="w-name" name="site_name" type="text" value="${s.site_name}" required ${disabled}></div>
        <div class="field"><label for="w-tag">Untertitel / Slogan</label><input id="w-tag" name="site_tagline" type="text" value="${s.site_tagline}" ${disabled}></div>
        <div class="field"><label for="w-desc">Beschreibung (für Suchmaschinen)</label><textarea id="w-desc" name="site_description" style="min-height:70px" ${disabled}>${s.site_description}</textarea></div>
        ${
          pages
            ? html`<div class="field"><label for="w-home">Startseite</label><select id="w-home" name="home_page_id" ${disabled}>
                <option value="">${registry.modules.some((m) => m.name === 'blog' && m.enabled) ? 'Neueste Blogbeiträge' : 'Standard-Willkommensseite'}</option>
                ${pages.filter((p) => p.status === 'published').map((p) => html`<option value="${p.id}" ${s.home_page_id === p.id ? raw('selected') : ''}>${'– '.repeat(p.depth)}${p.title}</option>`)}
              </select><div class="help">Nur veröffentlichte Seiten sind wählbar.</div></div>`
            : ''
        }
      </div>
      <div class="card">
        <h2>Erscheinungsbild</h2>
        <div class="inline-fields">
          <div class="field"><label for="w-accent">Akzentfarbe</label><input id="w-accent" name="theme_accent_color" type="color" value="${s.theme_accent_color}" ${disabled} style="height:40px;padding:4px"></div>
          <div class="field"><label for="w-logo">Logo-URL</label>
            <div class="toolbar" style="flex-wrap:nowrap"><input id="w-logo" name="theme_logo_url" type="text" value="${s.theme_logo_url}" placeholder="/uploads/… oder https://…" ${disabled}>
            ${registry.services.mediaPicker && ctx.isAdmin ? html`<button type="button" class="btn" id="pick-logo">Auswählen</button>` : ''}</div></div>
        </div>
        <div class="field"><label for="w-foot">Zusatztext in der Fußzeile</label><input id="w-foot" name="theme_footer_text" type="text" value="${s.theme_footer_text}" ${disabled}></div>
      </div>
      <div class="card">
        <h2>Rechtliches</h2>
        <div class="field"><label for="w-addr">Anbieter / Postanschrift</label><textarea id="w-addr" name="company_address" ${disabled}>${s.company_address}</textarea>
          <div class="help">Erscheint in der Fußzeile der Website und in Newslettern (<code>{{company_address}}</code>).</div></div>
        <div class="inline-fields">
          <div class="field"><label for="w-imp">Link zum Impressum</label><input id="w-imp" name="imprint_url" type="text" value="${s.imprint_url}" placeholder="/impressum" ${disabled}></div>
          <div class="field"><label for="w-priv">Link zur Datenschutzerklärung</label><input id="w-priv" name="privacy_url" type="text" value="${s.privacy_url}" placeholder="/datenschutz" ${disabled}></div>
        </div>
      </div>
      ${ctx.isAdmin ? html`<div><button class="btn btn-primary" type="submit">Speichern</button></div>` : ''}
    </form>`,
  );
  $('#pick-logo', box)?.addEventListener('click', async () => {
    const media = await registry.services.mediaPicker({ type: 'image' });
    if (media) $('#w-logo', box).value = media.url;
  });
  $('#website', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if ('home_page_id' in d) d.home_page_id = d.home_page_id ? Number(d.home_page_id) : null;
    try {
      await saveSettings(d);
    } catch (err) {
      toastError(err);
    }
  });
}

async function modulesTab(box) {
  const mods = await get('/system/modules');
  setHtml(
    box,
    html`<div class="card">
      <h2>Module</h2>
      <p class="muted">Module erweitern das CMS um Funktionen. Deaktivierte Module behalten ihre Daten; ihre Seiten, Schnittstellen und Menüpunkte sind dann ausgeblendet.
      Eigene Module legst du im Ordner <code>modules/</code> ab (siehe README).</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Modul</th><th>Version</th><th>Benötigt</th><th>Status</th><th></th></tr></thead>
        <tbody>${mods.map(
          (m) => html`<tr>
            <td><strong>${m.label}</strong> <span class="muted small">(${m.name})</span><div class="muted small">${m.description}</div></td>
            <td class="small">${m.version}</td>
            <td class="small">${m.requires.length ? m.requires.join(', ') : '–'}</td>
            <td>${m.enabled ? html`<span class="badge badge-good">Aktiv</span>` : html`<span class="badge badge-muted">Inaktiv</span>`}</td>
            <td class="right">${m.core ? html`<span class="muted small">Kernmodul</span>` : html`<button class="btn btn-sm" data-toggle="${m.name}" data-on="${m.enabled ? '0' : '1'}">${m.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>`}</td>
          </tr>`,
        )}</tbody>
      </table></div>
    </div>`,
  );
  $$('[data-toggle]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await put(`/system/modules/${b.dataset.toggle}`, { enabled: b.dataset.on === '1' });
        toast('Modul aktualisiert – Oberfläche wird neu geladen');
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        toastError(err);
      }
    }),
  );
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
