import { registry } from './registry.js';
import { del, get, post, put } from './api.js';
import { ctx, navigate } from './state.js';
import { $, $$, confirmDialog, debounce, fmtDateTime, formData, html, modal, pager, raw, setHtml, toast, toastError } from './ui.js';

const CORE_TABS = [
  { id: 'website', label: 'Website', order: 0, render: websiteTab },
  { id: 'modules', label: 'Module', order: 80, adminOnly: true, render: modulesTab },
  { id: 'users', label: 'Benutzer', order: 90, adminOnly: true, render: usersTab },
  { id: 'api', label: 'API', order: 95, adminOnly: true, render: apiTab },
  { id: 'backup', label: 'Backup & Wartung', order: 96, adminOnly: true, render: backupTab },
  { id: 'audit', label: 'Protokoll', order: 97, adminOnly: true, render: auditTab },
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
      <div class="card">
        <h2>E-Mail-Absender</h2>
        <p class="muted small">Für Systemmails (Passwort-Reset, Formular-Benachrichtigungen) und als Standard für Newsletter.</p>
        <div class="inline-fields">
          <div class="field"><label for="w-sname">Absendername</label><input id="w-sname" name="sender_name" type="text" value="${s.sender_name}" ${disabled}></div>
          <div class="field"><label for="w-semail">Absender-E-Mail</label><input id="w-semail" name="sender_email" type="email" value="${s.sender_email}" required ${disabled}></div>
        </div>
        <div class="field"><label for="w-reply">Antwortadresse (optional)</label><input id="w-reply" name="reply_to" type="email" value="${s.reply_to}" ${disabled}></div>
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

const ROLE_LABELS = { admin: 'Administrator', editor: 'Redakteur', author: 'Autor' };
const ROLE_BADGE = { admin: 'badge-info', editor: 'badge-muted', author: 'badge-warn' };

function userDialog(user, onSaved) {
  modal({
    title: user ? 'Benutzer bearbeiten' : 'Benutzer anlegen',
    body: html`
      <div class="field"><label for="u-name">Name</label><input id="u-name" name="name" type="text" value="${user?.name || ''}"></div>
      <div class="field"><label for="u-email">E-Mail *</label><input id="u-email" name="email" type="email" required value="${user?.email || ''}"></div>
      <div class="field"><label for="u-role">Rolle</label><select id="u-role" name="role">
        <option value="author" ${user?.role === 'author' ? raw('selected') : ''}>Autor – eigene Seiten und Beiträge als Entwurf, Medien</option>
        <option value="editor" ${!user || user.role === 'editor' ? raw('selected') : ''}>Redakteur – alle Inhalte, Veröffentlichen, Newsletter</option>
        <option value="admin" ${user?.role === 'admin' ? raw('selected') : ''}>Administrator – zusätzlich Einstellungen, Benutzer, API</option>
      </select></div>
      ${
        user
          ? html`<div class="field"><label for="u-pw">Neues Passwort (optional)</label><input id="u-pw" name="password" type="password" minlength="10" autocomplete="new-password"><div class="help">Mindestens 10 Zeichen</div></div>`
          : html`<label class="checkline"><input type="checkbox" name="invite" id="u-invite" checked> Zugangslink per E-Mail senden (Benutzer legt das Passwort selbst fest)</label>
              <div class="field hidden" id="u-pw-field"><label for="u-pw">Passwort *</label><input id="u-pw" name="password" type="password" minlength="10" autocomplete="new-password"><div class="help">Mindestens 10 Zeichen</div></div>`
      }`,
    onOpen: (d) => {
      const invite = $('#u-invite', d);
      invite?.addEventListener('change', () => {
        $('#u-pw-field', d).classList.toggle('hidden', invite.checked);
        $('#u-pw', d).required = !invite.checked;
      });
    },
    onSubmit: async (form) => {
      const d = formData(form);
      if (!d.password) delete d.password;
      if (user) await put(`/users/${user.id}`, d);
      else await post('/users', d);
      toast(d.invite ? 'Benutzer angelegt – Zugangslink wurde verschickt' : 'Benutzer gespeichert');
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
        <thead><tr><th>Name</th><th>E-Mail</th><th>Rolle</th><th>2FA</th><th>Letzte Anmeldung</th><th></th></tr></thead>
        <tbody>${users.map(
          (u) => html`<tr><td>${u.name || '–'}</td><td>${u.email}</td>
            <td><span class="badge ${ROLE_BADGE[u.role]}">${ROLE_LABELS[u.role] || u.role}</span></td>
            <td>${u.totp_enabled ? html`<span class="badge badge-good">aktiv</span>` : html`<span class="muted small">–</span>`}</td>
            <td class="small">${fmtDateTime(u.last_login_at)}</td>
            <td class="right nowrap"><button class="btn btn-sm" data-edit="${u.id}">Bearbeiten</button>
              <button class="btn btn-sm btn-ghost" data-reset="${u.id}" title="Link zum Festlegen eines neuen Passworts senden">Reset-Link</button>
              ${u.totp_enabled && u.id !== ctx.user.id ? html`<button class="btn btn-sm btn-ghost" data-tfa="${u.id}">2FA zurücksetzen</button>` : ''}
              ${u.id !== ctx.user.id ? html`<button class="btn btn-sm btn-ghost" data-del="${u.id}" aria-label="Löschen">🗑</button>` : ''}</td></tr>`,
        )}</tbody>
      </table></div>
      <p class="muted small" style="margin-top:12px">Autoren können eigene Entwürfe schreiben und zur Prüfung einreichen; veröffentlichen dürfen Redakteure und Administratoren.</p>
    </div>`,
  );
  const reload = () => usersTab(box);
  const byId = (id) => users.find((u) => u.id === Number(id));
  $('#add-user', box).addEventListener('click', () => userDialog(null, reload));
  $$('[data-edit]', box).forEach((b) => b.addEventListener('click', () => userDialog(byId(b.dataset.edit), reload)));
  $$('[data-reset]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const u = byId(b.dataset.reset);
      if (!(await confirmDialog('Reset-Link senden', `${u.email} erhält per E-Mail einen Link, um ein neues Passwort festzulegen.`, { submitLabel: 'Senden', danger: false }))) return;
      try {
        await post(`/users/${u.id}/send-reset`);
        toast('Link verschickt');
      } catch (err) {
        toastError(err);
      }
    }),
  );
  $$('[data-tfa]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const u = byId(b.dataset.tfa);
      if (!(await confirmDialog('2FA zurücksetzen', `Die Zwei-Faktor-Anmeldung von ${u.email} wird deaktiviert und alle Sitzungen beendet.`, { submitLabel: 'Zurücksetzen' }))) return;
      try {
        await post(`/users/${u.id}/reset-2fa`);
        toast('Zwei-Faktor-Anmeldung zurückgesetzt');
        reload();
      } catch (err) {
        toastError(err);
      }
    }),
  );
  $$('[data-del]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const u = byId(b.dataset.del);
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

const fmtBytes = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`);

async function backupTab(box) {
  const [list, s, cacheInfo] = await Promise.all([get('/system/backups'), ctx.getSettings(true), get('/system/cache')]);
  setHtml(
    box,
    html`<div class="card">
      <div class="card-head"><h2>Backup</h2>
        <div class="toolbar"><a class="btn" href="/api/system/backup" id="dl-now">Jetzt herunterladen</a><button class="btn btn-primary" id="create">Auf dem Server sichern</button></div></div>
      <p class="muted">Ein Backup enthält die komplette Datenbank (Inhalte, Abonnenten, Einstellungen, Benutzer) und alle hochgeladenen Dateien als ZIP.
      Wiederherstellen bei gestopptem Server mit <code>npm run restore -- &lt;datei.zip&gt;</code>.</p>
      <div class="table-wrap"><table><thead><tr><th>Datei</th><th>Erstellt</th><th class="right">Größe</th><th></th></tr></thead><tbody>${
        list.length
          ? list.map(
              (b) => html`<tr><td><code>${b.name}</code></td><td class="small">${fmtDateTime(b.created_at)}</td><td class="right num">${fmtBytes(b.size)}</td>
                <td class="right nowrap"><a class="btn btn-sm" href="/api/system/backups/${b.name}">Herunterladen</a><button class="btn btn-sm btn-ghost" data-del="${b.name}" aria-label="Löschen">🗑</button></td></tr>`,
            )
          : html`<tr><td colspan="4" class="empty">Noch keine Backups auf dem Server.</td></tr>`
      }</tbody></table></div>
    </div>
    <div class="card">
      <h2>Suchindex</h2>
      <p class="muted">Die Website-Suche aktualisiert sich automatisch. Nach einer Wiederherstellung oder einem Import kann der Index hier neu aufgebaut werden.</p>
      <button class="btn" id="reindex">Suchindex neu aufbauen</button>
    </div>
    <form class="card" id="cache-settings">
      <h2>Seiten-Cache</h2>
      <p class="muted">Öffentliche Seiten werden für kurze Zeit im Arbeitsspeicher gehalten und dadurch deutlich schneller ausgeliefert.
      Jede Änderung im Admin-Bereich leert den Cache automatisch.</p>
      <div class="inline-fields">
        <div class="field"><label for="c-ttl">Gültigkeit in Sekunden</label><input id="c-ttl" name="cache_ttl_seconds" type="number" min="0" max="86400" value="${s.cache_ttl_seconds}"><div class="help">0 = Cache aus</div></div>
      </div>
      <p class="muted small" id="cache-info">${cacheInfo.entries} Seiten im Cache · ${cacheInfo.hits} Treffer · ${cacheInfo.misses} Fehlgriffe seit dem Start</p>
      <div class="toolbar"><button class="btn btn-primary" type="submit">Speichern</button><button class="btn" type="button" id="cache-clear">Cache leeren</button></div>
    </form>
    <form class="card" id="backup-settings">
      <h2>Automatische Backups</h2>
      <div class="inline-fields">
        <div class="field"><label for="b-int">Abstand in Stunden</label><input id="b-int" name="backup_interval_hours" type="number" min="0" max="720" value="${s.backup_interval_hours}"><div class="help">0 = aus, 24 = täglich</div></div>
        <div class="field"><label for="b-keep">Anzahl aufbewahren</label><input id="b-keep" name="backup_keep" type="number" min="1" max="100" value="${s.backup_keep}"></div>
      </div>
      <p class="muted small">Gespeichert im Ordner <code>BACKUPS_DIR</code> (Standard <code>data/backups</code>). Bewahre Kopien zusätzlich außerhalb des Servers auf.</p>
      <button class="btn btn-primary" type="submit">Speichern</button>
    </form>`,
  );
  $('#create', box).addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await post('/system/backups');
      toast('Backup erstellt');
      backupTab(box);
    } catch (err) {
      toastError(err);
      e.target.disabled = false;
    }
  });
  $('#reindex', box).addEventListener('click', async () => {
    try {
      const r = await post('/system/search/rebuild');
      toast(`Suchindex mit ${r.documents} Dokumenten neu aufgebaut`);
    } catch (err) {
      toastError(err);
    }
  });
  $('#cache-clear', box).addEventListener('click', async () => {
    try {
      await del('/system/cache');
      const c = await get('/system/cache');
      $('#cache-info', box).textContent = `${c.entries} Seiten im Cache · ${c.hits} Treffer · ${c.misses} Fehlgriffe seit dem Start`;
      toast('Cache geleert');
    } catch (err) {
      toastError(err);
    }
  });
  $('#cache-settings', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveSettings({ cache_ttl_seconds: Number(formData(e.target).cache_ttl_seconds) });
    } catch (err) {
      toastError(err);
    }
  });
  $$('[data-del]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Backup löschen', `${b.dataset.del} löschen?`, { submitLabel: 'Löschen' }))) return;
      await del(`/system/backups/${b.dataset.del}`);
      backupTab(box);
    }),
  );
  $('#backup-settings', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    try {
      await saveSettings({ backup_interval_hours: Number(d.backup_interval_hours), backup_keep: Number(d.backup_keep) });
    } catch (err) {
      toastError(err);
    }
  });
}

// Lesbare Beschreibung eines Protokolleintrags
const ENTITY_LABELS = {
  pages: 'Seite', posts: 'Beitrag', categories: 'Kategorie', media: 'Datei', menus: 'Menü', subscribers: 'Abonnent', lists: 'Liste',
  templates: 'Vorlage', campaigns: 'Kampagne', settings: 'Einstellungen', users: 'Benutzer', 'api-keys': 'API-Schlüssel', system: 'System',
  forms: 'Formular', redirects: 'Weiterleitung', segments: 'Segment', automations: 'Automation', webhooks: 'Webhook',
};
const EVENT_LABELS = {
  login: 'Anmeldung', login_failed: 'Fehlgeschlagene Anmeldung', login_2fa_failed: 'Falscher 2FA-Code', password_changed: 'Passwort geändert',
  password_reset_requested: 'Passwort-Reset angefordert', password_reset: 'Passwort zurückgesetzt', '2fa_enabled': '2FA aktiviert', '2fa_disabled': '2FA deaktiviert',
};
const SUB_ACTIONS = { submit: 'zur Prüfung eingereicht', decline: 'zur Überarbeitung zurückgegeben', send: 'versendet', optimize: 'optimiert' };
function describeAudit(e) {
  if (EVENT_LABELS[e.action]) return { text: EVENT_LABELS[e.action], detail: e.target };
  const parts = e.target.split('/').filter(Boolean);
  const entity = ENTITY_LABELS[parts[0]] || parts[0] || '';
  const id = /^\d+$/.test(parts[1] || '') ? ` #${parts[1]}` : '';
  const sub = parts.slice(id ? 2 : 1).join('/');
  if (e.action === 'POST' && SUB_ACTIONS[sub]) return { text: `${entity}${id} ${SUB_ACTIONS[sub]}`, detail: `${e.action} ${e.target}` };
  const verb = { POST: sub ? 'Aktion' : 'angelegt', PUT: 'geändert', DELETE: 'gelöscht', PATCH: 'geändert' }[e.action] || e.action;
  return { text: `${entity}${id} ${verb}${sub ? `: ${sub}` : ''}`, detail: `${e.action} ${e.target}` };
}

async function auditTab(box) {
  const state = { q: '', page: 1 };
  setHtml(
    box,
    html`<div class="card">
      <div class="card-head"><h2>Änderungsprotokoll</h2><input type="search" id="audit-q" placeholder="Filtern …" style="max-width:240px" aria-label="Filtern"></div>
      <p class="muted small">Anmeldungen und alle Änderungen über die Verwaltung bzw. API. Einträge werden nach 365 Tagen gelöscht.</p>
      <div id="audit-rows"></div>
    </div>`,
  );
  const load = async () => {
    const qs = new URLSearchParams({ page: state.page, per_page: 50 });
    if (state.q) qs.set('q', state.q);
    const data = await get(`/system/audit?${qs}`);
    const rows = $('#audit-rows', box);
    setHtml(
      rows,
      html`<div class="table-wrap"><table><thead><tr><th>Zeit</th><th>Wer</th><th>Was</th><th>IP</th></tr></thead><tbody>${
        data.items.length
          ? data.items.map((e) => {
              const d = describeAudit(e);
              return html`<tr><td class="small nowrap">${fmtDateTime(e.created_at)}</td><td class="small">${e.actor}</td>
                <td>${d.text}<div class="muted small">${d.detail}</div></td><td class="small muted">${e.ip || ''}</td></tr>`;
            })
          : html`<tr><td colspan="4" class="empty">Keine Einträge.</td></tr>`
      }</tbody></table></div>`,
    );
    rows.append(pager(data, (p) => ((state.page = p), load())));
  };
  $('#audit-q', box).addEventListener('input', debounce((e) => ((state.q = e.target.value.trim()), (state.page = 1), load())));
  await load();
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
