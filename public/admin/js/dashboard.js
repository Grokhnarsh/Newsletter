import { get } from './api.js';
import { registry } from './registry.js';
import { ctx } from './state.js';
import { html, setHtml } from './ui.js';

/**
 * Dashboard: zeigt die Widgets aller aktiven Module. Kleine Kennzahlen
 * (`size: 'tile'`) stehen in einer Reihe, große Widgets darunter.
 */
export async function dashboardView(el) {
  const data = await get('/system/dashboard');
  const widgets = [...registry.widgets].sort((a, b) => a.order - b.order);
  const tiles = widgets.filter((w) => w.size === 'tile');
  const wide = widgets.filter((w) => w.size !== 'tile');

  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Dashboard</h1><div class="sub">Willkommen zurück${ctx.user?.name ? `, ${ctx.user.name}` : ''}!</div></div>
        <div class="toolbar"><a class="btn" href="/" target="_blank" rel="noopener">Website ansehen ↗</a></div>
      </div>
      ${tiles.length ? html`<div class="grid grid-4">${tiles.map((w) => html`<div class="card stat" data-widget="${w.id}"></div>`)}</div>` : ''}
      ${wide.map((w) => html`<div class="card" data-widget="${w.id}"></div>`)}
      ${!widgets.length ? html`<div class="card empty">Keine Dashboard-Widgets – aktiviere Module unter Einstellungen › Module.</div>` : ''}`,
  );

  for (const w of widgets) {
    const box = el.querySelector(`[data-widget="${CSS.escape(w.id)}"]`);
    try {
      await w.render(box, data);
    } catch (err) {
      setHtml(box, html`<p class="muted">Widget konnte nicht geladen werden: ${err.message}</p>`);
    }
  }
}
