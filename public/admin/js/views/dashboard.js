import { get } from '../api.js';
import { growthChart } from '../chart.js';
import { $, CAMPAIGN_STATUS, badge, fmtDateTime, fmtNum, fmtPct, html, setHtml } from '../ui.js';

export async function dashboardView(el) {
  const data = await get('/stats/overview?days=30');
  const s = data.subscribers;
  const c = data.campaigns;

  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Übersicht</h1><div class="sub">Die letzten ${data.period_days} Tage auf einen Blick</div></div>
        <div class="toolbar"><a class="btn btn-primary" href="#/campaigns/new">+ Neue Kampagne</a></div>
      </div>
      <div class="grid grid-4">
        <div class="card stat"><div class="label">Aktive Abonnenten</div><div class="value">${fmtNum(s.active)}</div>
          <div class="hint">${fmtNum(s.pending)} unbestätigt · ${fmtNum(s.total)} gesamt</div></div>
        <div class="card stat"><div class="label">Neu (${data.period_days} Tage)</div><div class="value">${fmtNum(s.new_in_period)}</div>
          <div class="hint">${fmtNum(s.lost_in_period)} Abmeldungen · netto ${s.new_in_period - s.lost_in_period >= 0 ? '+' : ''}${fmtNum(s.new_in_period - s.lost_in_period)}</div></div>
        <div class="card stat"><div class="label">⌀ Öffnungsrate</div><div class="value">${fmtPct(c.avg_open_rate)}</div>
          <div class="hint">letzte ${Math.min(10, c.sent)} Kampagnen</div></div>
        <div class="card stat"><div class="label">⌀ Klickrate</div><div class="value">${fmtPct(c.avg_click_rate)}</div>
          <div class="hint">${fmtNum(c.sent)} versendet · ${fmtNum(c.scheduled)} geplant${data.queue ? ` · ${fmtNum(data.queue)} in der Warteschlange` : ''}</div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <h2>Abonnenten-Entwicklung</h2>
        <div id="growth"></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Letzte Kampagnen</h2><a href="#/campaigns" class="small">Alle anzeigen</a></div>
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
        }
      </div>`,
  );

  growthChart($('#growth', el), data.growth);
  el.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => (location.hash = tr.dataset.href)));
}
