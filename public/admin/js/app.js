import { get, post, put, session } from './api.js';
import { ctx } from './state.js';
import { $, $$, formData, html, modal, raw, setHtml, toast, toastError } from './ui.js';
import { campaignEditorView, campaignReportView, campaignsView } from './views/campaigns.js';
import { dashboardView } from './views/dashboard.js';
import { listsView } from './views/lists.js';
import { settingsView } from './views/settings.js';
import { subscriberDetailView, subscribersView } from './views/subscribers.js';
import { templateEditorView, templatesView } from './views/templates.js';

const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  subscribers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  lists: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  campaigns: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  templates: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};
const icon = (name) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`);
const LOGO = raw('<svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#2a78d6"/><path d="M5 8l7 5 7-5M5 8v8h14V8" stroke="#fff" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg>');

const NAV = [
  ['#/', 'Übersicht', 'dashboard'],
  ['#/campaigns', 'Kampagnen', 'campaigns'],
  ['#/subscribers', 'Abonnenten', 'subscribers'],
  ['#/lists', 'Listen', 'lists'],
  ['#/templates', 'Vorlagen', 'templates'],
  ['#/settings', 'Einstellungen', 'settings'],
];

const ROUTES = [
  [/^\/$/, dashboardView],
  [/^\/subscribers$/, subscribersView],
  [/^\/subscribers\/(\d+)$/, subscriberDetailView],
  [/^\/lists$/, listsView],
  [/^\/campaigns$/, campaignsView],
  [/^\/campaigns\/new$/, (el) => campaignEditorView(el, null)],
  [/^\/campaigns\/(\d+)$/, campaignEditorView],
  [/^\/campaigns\/(\d+)\/report$/, campaignReportView],
  [/^\/templates$/, templatesView],
  [/^\/templates\/(new|\d+)$/, templateEditorView],
  [/^\/settings(?:\/([a-z-]+))?$/, settingsView],
];

const app = document.getElementById('app');
let cleanup = null;

function renderShell() {
  setHtml(
    app,
    html`<div class="shell">
      <aside class="sidebar" aria-label="Hauptnavigation">
        <div class="brand">${LOGO}<span id="brand-name">${ctx.settings?.site_name || 'Newsletter'}</span></div>
        <nav class="nav">
          ${NAV.map(([href, label, ic]) => html`<a href="${href}" data-nav="${href}">${icon(ic)}<span>${label}</span></a>`)}
        </nav>
        <div class="spacer"></div>
        <div class="userbox">
          <div class="name">${session.user.name || session.user.email}</div>
          <div class="muted">${session.user.role === 'admin' ? 'Administrator' : 'Redakteur'}</div>
          <div class="actions">
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
  $$('.nav a').forEach((a) => {
    const target = a.dataset.nav.slice(1);
    a.classList.toggle('active', target === '/' ? path === '/' : path.startsWith(target));
  });
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
  for (const [re, fn] of ROUTES) {
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
  session.token = null;
  session.user = null;
  showLogin();
}

function accountDialog() {
  modal({
    title: 'Mein Konto',
    body: html`
      <div class="field"><label for="acc-name">Name</label><input id="acc-name" name="name" type="text" value="${session.user.name}"></div>
      <div class="field"><label for="acc-email">E-Mail</label><input id="acc-email" name="email" type="email" required value="${session.user.email}"></div>
      <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">
      <h3>Passwort ändern</h3>
      <div class="field"><label for="acc-cur">Aktuelles Passwort</label><input id="acc-cur" name="current_password" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="acc-new">Neues Passwort</label><input id="acc-new" name="new_password" type="password" minlength="10" autocomplete="new-password"><div class="help">Mindestens 10 Zeichen. Leer lassen, um es nicht zu ändern.</div></div>`,
    onSubmit: async (form) => {
      const data = formData(form);
      if (!data.new_password) {
        delete data.new_password;
        delete data.current_password;
      }
      session.user = await put('/auth/me', data);
      toast('Konto gespeichert');
      renderShell();
      route();
    },
  });
}

function authCard(title, subtitle, body) {
  return html`<div class="auth"><div class="card">
    <div class="brand" style="padding:0 0 16px">${LOGO}<span>Newsletter</span></div>
    <h1>${title}</h1><p class="muted">${subtitle}</p>${body}</div></div>`;
}

function showLogin() {
  app.removeAttribute('aria-busy');
  setHtml(
    app,
    authCard(
      'Anmelden',
      'Melde dich mit deinem Administrationskonto an.',
      html`<form id="login-form">
        <div class="field"><label for="email">E-Mail</label><input id="email" name="email" type="email" required autocomplete="username" autofocus></div>
        <div class="field"><label for="password">Passwort</label><input id="password" name="password" type="password" required autocomplete="current-password"></div>
        <button class="btn btn-primary" type="submit">Anmelden</button>
      </form>`,
    ),
  );
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await post('/auth/login', formData(e.target));
      await startSession(res.token, res.user);
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
        <div class="field"><label for="site_name">Name des Newsletters</label><input id="site_name" name="site_name" type="text" placeholder="z. B. Firmen-News" required></div>
        <div class="field"><label for="name">Dein Name</label><input id="name" name="name" type="text" autocomplete="name"></div>
        <div class="field"><label for="email">E-Mail</label><input id="email" name="email" type="email" required autocomplete="username"></div>
        <div class="field"><label for="password">Passwort</label><input id="password" name="password" type="password" minlength="10" required autocomplete="new-password"><div class="help">Mindestens 10 Zeichen</div></div>
        <button class="btn btn-primary" type="submit">Konto anlegen</button>
      </form>`,
    ),
  );
  $('#setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try {
      const res = await post('/auth/setup', formData(e.target));
      await startSession(res.token, res.user);
    } catch (err) {
      toastError(err);
    }
  });
}

async function startSession(token, user) {
  session.token = token;
  session.user = user;
  ctx.lists = null;
  await ctx.getSettings(true).catch(() => null);
  renderShell();
  route();
}

window.addEventListener('hashchange', route);
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
  try {
    if (session.token) {
      const user = await get('/auth/me');
      return startSession(session.token, user);
    }
    const { needs_setup } = await get('/auth/status');
    return needs_setup ? showSetup() : showLogin();
  } catch {
    session.token = null;
    const status = await get('/auth/status').catch(() => ({ needs_setup: false }));
    return status.needs_setup ? showSetup() : showLogin();
  }
}

boot();
