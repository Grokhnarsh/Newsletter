import { growthChart } from './chart.js';
import { $, CAMPAIGN_STATUS, badge, fmtDateTime, fmtNum, fmtPct, html, setHtml } from '/admin/js/ui.js';

/** Dashboard-Widget des Newsletter-Moduls. */
export function newsletterWidget(el, all) {
  const data = all.newsletter;
  if (!data) return setHtml(el, html`<p class="muted">Keine Daten.</p>`);
  const s = data.subscribers;
  const c = data.campaigns;
  setHtml(
    el,
    html`<div class="card-head"><h2>Newsletter</h2><div class="toolbar"><a class="btn btn-sm" href="#/subscribers">Abonnenten</a><a class="btn btn-sm btn-primary" href="#/campaigns/new">+ Kampagne</a></div></div>
      <div class="grid grid-4">
        <div class="stat"><div class="label">Aktive Abonnenten</div><div class="value">${fmtNum(s.active)}</div>
          <div class="hint">${fmtNum(s.pending)} unbestätigt · ${fmtNum(s.total)} gesamt</div></div>
        <div class="stat"><div class="label">Neu (${data.period_days} Tage)</div><div class="value">${fmtNum(s.new_in_period)}</div>
          <div class="hint">${fmtNum(s.lost_in_period)} Abmeldungen · netto ${s.new_in_period - s.lost_in_period >= 0 ? '+' : ''}${fmtNum(s.new_in_period - s.lost_in_period)}</div></div>
        <div class="stat"><div class="label">⌀ Öffnungsrate</div><div class="value">${fmtPct(c.avg_open_rate)}</div>
          <div class="hint">letzte ${Math.min(10, c.sent)} Kampagnen</div></div>
        <div class="stat"><div class="label">⌀ Klickrate</div><div class="value">${fmtPct(c.avg_click_rate)}</div>
          <div class="hint">${fmtNum(c.sent)} versendet · ${fmtNum(c.scheduled)} geplant${data.queue ? ` · ${fmtNum(data.queue)} in der Warteschlange` : ''}</div></div>
      </div>
      <h3 style="margin-top:20px">Abonnenten-Entwicklung</h3>
      <div data-growth></div>
      <h3 style="margin-top:20px">Letzte Kampagnen</h3>
      ${
        data.recent_campaigns.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>Kampagne</th><th>Status</th><th>Versand</th><th class="right">Empfänger</th><th class="right">Öffnungen</th><th class="right">Klicks</th></tr></thead>
              <tbody>${data.recent_campaigns.map(
                (k) => html`<tr class="clickable" data-href="#/campaigns/${k.id}/report">
                  <td><strong>${k.name}</strong><div class="muted small">${k.subject}</div></td>
                  <td>${badge(k.status, CAMPAIGN_STATUS)}</td>
                  <td class="nowrap">${fmtDateTime(k.started_at)}</td>
                  <td class="right num">${fmtNum(k.sent_count)}</td>
                  <td class="right num">${fmtPct(k.open_rate)}</td>
                  <td class="right num">${fmtPct(k.click_rate)}</td>
                </tr>`,
              )}</tbody></table></div>`
          : html`<div class="empty">Noch keine Kampagnen versendet. <a href="#/campaigns/new">Erste Kampagne erstellen</a></div>`
      }`,
  );
  growthChart($('[data-growth]', el), data.growth);
  el.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
}
