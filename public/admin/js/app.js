import { get, post, put, session } from './api.js';
import { dashboardView } from './dashboard.js';
import { ICONS, cms, registry } from './registry.js';
import { settingsView } from './settings.js';
import { ctx } from './state.js';
import { $, $$, formData, html, modal, raw, setHtml, toast, toastError } from './ui.js';

const icon = (name) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.modules}</svg>`);
const LOGO = raw('<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#2a78d6"/><path d="M6 7h12M6 12h12M6 17h7" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>');
const GROUP_ORDER = ['Übersicht', 'Inhalte', 'Newsletter', 'System'];

// Kernansichten; Module ergänzen weitere über die Registry
const CORE_ROUTES = [
  [/^\/$/, dashboardView],
  [/^\/settings(?:\/([a-z0-9-]+))?$/, settingsView],
];
let modulesLoaded = false;

/** Lädt die Admin-Skripte aller aktiven Module. */
async function loadModules() {
  if (modulesLoaded) return;
  registry.modules = await get('/system/modules');
  cms.nav({ href: '#/', label: 'Dashboard', icon: 'dashboard', group: 'Übersicht', order: 0 });
  cms.nav({ href: '#/settings', label: 'Einstellungen', icon: 'settings', group: 'System', order: 90 });
  for (const mod of registry.modules) {
    if (!mod.enabled || !mod.admin_entry) continue;
    try {
      const entry = await import(mod.admin_entry);
      entry.default?.(cms);
    } catch (err) {
      console.error(`Admin-Skript von ${mod.name} konnte nicht geladen werden`, err);
      toast(`Modul „${mod.label}“: Admin-Oberfläche konnte nicht geladen werden`, 'error');
    }
  }
  modulesLoaded = true;
}

const app = document.getElementById('app');
let cleanup = null;

function navGroups() {
  const groups = new Map();
  for (const item of [...registry.nav].sort((a, b) => a.order - b.order)) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  const rank = (g) => (GROUP_ORDER.includes(g) ? GROUP_ORDER.indexOf(g) : 2.5);
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

function renderShell() {
  setHtml(
    app,
    html`<div class="shell">
      <aside class="sidebar" aria-label="Hauptnavigation">
        <div class="brand">${LOGO}<span id="brand-name">${ctx.settings?.site_name || 'CMS'}</span></div>
        <nav class="nav">${navGroups().map(
          ([group, items]) => html`<div class="nav-group">${group !== 'Übersicht' ? html`<div class="nav-heading">${group}</div>` : ''}
            ${items.map((n) => html`<a href="${n.href}" data-nav="${n.href}">${icon(n.icon)}<span>${n.label}</span></a>`)}</div>`,
        )}</nav>
        <div class="spacer"></div>
        <div class="userbox">
          <div class="name">${session.user.name || session.user.email}</div>
          <div class="muted">${session.user.role === 'admin' ? 'Administrator' : 'Redakteur'}</div>
          <div class="actions">
            <a class="small" href="/" target="_blank" rel="noopener">Website ansehen ↗</a>
            <button class="linklike small" id="account-btn">Mein Konto</button>
            <button class="linklike small" id="logout-btn">Abmelden</button>
          </div>
        </div>
      </aside>
      <main class="main">
        <button class="btn btn-sm menu-toggle" id="menu-toggle" aria-label="Menü öffnen">☰ Menü</button>
        <div id="view"></div>
      </main>
    </div>`,
  );
  $('#logout-btn').addEventListener('click', logout);
  $('#account-btn').addEventListener('click', accountDialog);
  $('#menu-toggle').addEventListener('click', () => $('.shell').classList.toggle('nav-open'));
}

function highlightNav(path) {
  const links = $$('.nav a');
  const match = links
    .map((a) => a.dataset.nav.slice(1))
    .filter((t) => (t === '/' ? path === '/' : path === t || path.startsWith(`${t}/`) || path.startsWith(`${t}?`)))
    .sort((a, b) => b.length - a.length)[0];
  links.forEach((a) => a.classList.toggle('active', a.dataset.nav.slice(1) === match));
  $('.shell')?.classList.remove('nav-open');
}

async function route() {
  if (!session.user) return;
  if (!$('.shell')) renderShell();
  const path = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  highlightNav(path);
  const view = $('#view');
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  for (const [re, fn] of [...CORE_ROUTES, ...registry.routes]) {
    const m = path.match(re);
    if (m) {
      view.setAttribute('aria-busy', 'true');
      setHtml(view, html`<p class="muted">Lädt …</p>`);
      try {
        cleanup = await fn(view, ...m.slice(1));
      } catch (err) {
        setHtml(view, html`<div class="card"><h2>Fehler</h2><p>${err.message}</p></div>`);
      }
      view.removeAttribute('aria-busy');
      window.scrollTo(0, 0);
      return;
    }
  }
  setHtml(view, html`<div class="card"><h2>Seite nicht gefunden</h2><p><a href="#/">Zur Übersicht</a></p></div>`);
}

async function logout() {
  try {
    await post('/auth/logout');
  } catch {
    /* ignorieren */
  }
  session.user = null;
  showLogin();
}

function accountDialog() {
  const u = session.user;
  modal({
    title: 'Mein Konto',
    body: html`
      <div class="field"><label for="acc-name">Name</label><input id="acc-name" name="name" type="text" value="${u.name}"></div>
      <div class="field"><label for="acc-email">E-Mail</label><input id="acc-email" name="email" type="email" required value="${u.email}"></div>
      <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">
      <h3>Passwort ändern</h3>
      <div class="field"><label for="acc-cur">Aktuelles Passwort</label><input id="acc-cur" name="current_password" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="acc-new">Neues Passwort</label><input id="acc-new" name="new_password" type="password" minlength="10" autocomplete="new-password"><div class="help">Mindestens 10 Zeichen. Leer lassen, um es nicht zu ändern. Zum Ändern der E-Mail-Adresse wird das aktuelle Passwort benötigt.</div></div>
      <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">
      <h3>Zwei-Faktor-Anmeldung</h3>
      ${
        u.totp_enabled
          ? html`<p><span class="badge badge-good">Aktiv</span> <span class="muted small">${u.recovery_codes_left ?? '–'} Wiederherstellungscodes übrig</span></p>
              <button type="button" class="btn btn-sm" id="tfa-off">Deaktivieren</button>`
          : html`<p class="muted small">Schützt dein Konto zusätzlich mit einem Code aus einer Authenticator-App (z. B. Aegis, Google Authenticator, 1Password).</p>
              <button type="button" class="btn btn-sm" id="tfa-on">Einrichten</button>`
      }`,
    onOpen: (d) => {
      $('#tfa-on', d)?.addEventListener('click', () => {
        d.close();
        d.remove();
        twoFactorSetup();
      });
      $('#tfa-off', d)?.addEventListener('click', () => {
        d.close();
        d.remove();
        modal({
          title: 'Zwei-Faktor-Anmeldung deaktivieren',
          submitLabel: 'Deaktivieren',
          danger: true,
          body: html`<div class="field"><label for="tfa-pw">Passwort zur Bestätigung</label><input id="tfa-pw" name="password" type="password" required autocomplete="current-password"></div>`,
          onSubmit: async (f) => {
            await post('/auth/2fa/disable', { password: f.password.value });
            session.user = await get('/auth/me');
            toast('Zwei-Faktor-Anmeldung deaktiviert');
          },
        });
      });
    },
    onSubmit: async (form) => {
      const data = formData(form);
      if (!data.new_password) delete data.new_password;
      if (!data.current_password) delete data.current_password;
      await put('/auth/me', data);
      session.user = await get('/auth/me');
      toast('Konto gespeichert');
      renderShell();
      route();
    },
  });
}

function twoFactorSetup() {
  modal({
    title: 'Zwei-Faktor-Anmeldung einrichten',
    submitLabel: 'Weiter',
    body: html`<div class="field"><label for="tfa-pw">Passwort zur Bestätigung</label><input id="tfa-pw" name="password" type="password" required autocomplete="current-password"></div>`,
    onSubmit: async (f) => {
      const setup = await post('/auth/2fa/setup', { password: f.password.value });
      modal({
        title: 'App verbinden',
        submitLabel: 'Aktivieren',
        body: html`<p>Scanne den QR-Code mit deiner Authenticator-App und gib den angezeigten 6-stelligen Code ein.</p>
          <p style="text-align:center"><img src="${setup.qr}" alt="QR-Code für die Authenticator-App" width="220" height="220" style="background:#fff;padding:6px;border-radius:8px"></p>
          <p class="small muted">Manuell eingeben: <code>${setup.secret}</code></p>
          <div class="field"><label for="tfa-code">Code aus der App</label><input id="tfa-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9 ]{6,7}"></div>`,
        onSubmit: async (f2) => {
          const { recovery_codes } = await post('/auth/2fa/enable', { code: f2.code.value });
          session.user = await get('/auth/me');
          modal({
            title: 'Wiederherstellungscodes',
            cancelLabel: 'Ich habe die Codes gesichert',
            body: html`<p>Zwei-Faktor-Anmeldung ist aktiv. Bewahre diese Codes sicher auf – jeder funktioniert <strong>einmal</strong>, falls du keinen Zugriff auf die App hast. Sie werden nicht erneut angezeigt.</p>
              <div class="keybox" style="columns:2">${recovery_codes.map((c) => html`<div>${c}</div>`)}</div>`,
          });
        },
      });
    },
  });
}

function authCard(title, subtitle, body) {
  return html`<div class="auth"><div class="card">
    <div class="brand" style="padding:0 0 16px">${LOGO}<span>CMS</span></div>
    <h1>${title}</h1><p class="muted">${subtitle}</p>${body}</div></div>`;
}

function showLogin() {
  app.removeAttribute('aria-busy');
  setHtml(
    app,
    authCard(
      'Anmelden',
      'Melde dich mit deinem Konto an.',
      html`<form id="login-form">
        <div class="field"><label for="email">E-Mail</label><input id="email" name="email" type="email" required autocomplete="username" autofocus></div>
        <div class="field"><label for="password">Passwort</label><input id="password" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn btn-primary" type="submit">Anmelden</button>
        <p class="small" style="margin-top:14px;text-align:center"><a href="#/forgot">Passwort vergessen?</a></p>
      </form>`,
    ),
  );
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await post('/auth/login', formData(e.target));
      if (res.two_factor) return showSecondFactor(res.challenge);
      await startSession(res.user);
    } catch (err) {
      toastError(err);
    }
  });
}

function showSecondFactor(challenge) {
  setHtml(
    app,
    authCard(
      'Bestätigungscode',
      'Gib den 6-stelligen Code aus deiner Authenticator-App ein – oder einen Wiederherstellungscode.',
      html`<form id="tfa-form">
        <div class="field"><label for="code">Code</label><input id="code" name="code" type="text" required autocomplete="one-time-code" inputmode="numeric" autofocus></div>
        <button class="btn btn-primary" type="submit">Bestätigen</button>
        <p class="small" style="margin-top:14px;text-align:center"><a href="#/" id="back">Zurück zur Anmeldung</a></p>
      </form>`,
    ),
  );
  $('#back').addEventListener('click', (e) => {
    e.preventDefault();
    showLogin();
  });
  $('#tfa-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await post('/auth/login/2fa', { challenge, code: e.target.code.value });
      await startSession(res.user);
    } catch (err) {
      toastError(err);
      if (err.status === 401 && /abgelaufen/.test(err.message)) showLogin();
    }
  });
}

function showForgot() {
  app.removeAttribute('aria-busy');
  setHtml(
    app,
    authCard(
      'Passwort vergessen',
      'Wir schicken dir einen Link, mit dem du ein neues Passwort festlegen kannst.',
      html`<form id="forgot-form">
        <div class="field"><label for="email">E-Mail</label><input id="email" name="email" type="email" required autocomplete="username" autofocus></div>
        <button class="btn btn-primary" type="submit">Link anfordern</button>
        <p class="small" style="margin-top:14px;text-align:center"><a href="#/">Zurück zur Anmeldung</a></p>
      </form>`,
    ),
  );
  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await post('/auth/forgot', formData(e.target));
      setHtml(app, authCard('E-Mail unterwegs', res.message, html`<p><a href="#/">Zurück zur Anmeldung</a></p>`));
    } catch (err) {
      toastError(err);
    }
  });
}

function showReset(token) {
  app.removeAttribute('aria-busy');
  setHtml(
    app,
    authCard(
      'Neues Passwort',
      'Lege ein neues Passwort für dein Konto fest.',
      html`<form id="reset-form">
        <div class="field"><label for="password">Neues Passwort</label><input id="password" name="password" type="password" minlength="10" required autocomplete="new-password" autofocus><div class="help">Mindestens 10 Zeichen</div></div>
        <div class="field"><label for="password2">Wiederholen</label><input id="password2" name="password2" type="password" minlength="10" required autocomplete="new-password"></div>
        <button class="btn btn-primary" type="submit">Passwort speichern</button>
      </form>`,
    ),
  );
  $('#reset-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    const { password, password2 } = formData(e.target);
    if (password !== password2) return toastError(new Error('Die Passwörter stimmen nicht überein'));
    try {
      const res = await post('/auth/reset', { token, password });
      history.replaceState(null, '', '#/');
      setHtml(app, authCard('Fertig', res.message, html`<p><a href="#/" id="to-login">Zur Anmeldung</a></p>`));
      $('#to-login').addEventListener('click', (ev) => {
        ev.preventDefault();
        showLogin();
      });
    } catch (err) {
      toastError(err);
    }
  });
}

function showSetup() {
  app.removeAttribute('aria-busy');
  setHtml(
    app,
    authCard(
      'Willkommen! 👋',
      'Lege das erste Administratorkonto an, um loszulegen.',
      html`<form id="setup-form">
        <div class="field"><label for="site_name">Name der Website</label><input id="site_name" name="site_name" type="text" placeholder="z. B. Musterfirma" required></div>
        <div class="field"><label for="name">Dein Name</label><input id="name" name="name" type="text" autocomplete="name"></div>
        <div class="field"><label for="email">E-Mail</label><input id="email" name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label for="password">Passwort</label><input id="password" name="password" type="password" minlength="10" required autocomplete="new-password"><div class="help">Mindestens 10 Zeichen</div></div>
        <div class="field"><label for="setup_token">Einrichtungscode</label><input id="setup_token" name="setup_token" type="text" required autocomplete="off" spellcheck="false"><div class="help">Steht beim Start im Server-Log (z. B. <code>docker compose logs</code>) oder wurde als <code>SETUP_TOKEN</code> gesetzt.</div></div>
        <button class="btn btn-primary" type="submit">Konto anlegen</button>
      </form>`,
    ),
  );
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try {
      const res = await post('/auth/setup', formData(e.target));
      await startSession(res.user);
    } catch (err) {
      toastError(err);
    }
  });
}

async function startSession(user) {
  session.user = await get('/auth/me').catch(() => user);
  ctx.lists = null;
  await ctx.getSettings(true).catch(() => null);
  await loadModules();
  renderShell();
  route();
}

/** Seiten, die ohne Anmeldung erreichbar sind (Passwort vergessen / zurücksetzen). */
function publicRoute() {
  const path = location.hash.replace(/^#/, '');
  const reset = path.match(/^\/reset\/([\w-]+)$/);
  if (reset) {
    showReset(reset[1]);
    return true;
  }
  if (path === '/forgot') {
    showForgot();
    return true;
  }
  return false;
}

window.addEventListener('hashchange', () => {
  if (!session.user) {
    if (!publicRoute()) showLogin();
    return;
  }
  route();
});
window.addEventListener('auth:expired', () => {
  if (session.user) toast('Sitzung abgelaufen – bitte erneut anmelden', 'error');
  session.user = null;
  showLogin();
});
// Markenname nach Änderung der Einstellungen aktualisieren
window.addEventListener('settings:changed', (e) => {
  const el = $('#brand-name');
  if (el) el.textContent = e.detail.site_name;
});

async function boot() {
  if (publicRoute()) return;
  try {
    const user = await get('/auth/me');
    return startSession(user);
  } catch {
    const status = await get('/auth/status').catch(() => ({ needs_setup: false }));
    return status.needs_setup ? showSetup() : showLogin();
  }
}

boot();
