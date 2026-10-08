// Admin-Oberfläche der Besucherstatistik
import { get } from '/admin/js/api.js';
import { $, esc, fmtNum, html, raw, setHtml } from '/admin/js/ui.js';

const dayFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const longFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'long' });

function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= v) * 4;
}

/** Säulendiagramm der Seitenaufrufe pro Tag (eine Reihe), Tooltip mit Besuchern, Tabellenansicht. */
function viewsChart(container, data) {
  const W = 760;
  const H = 240;
  const pad = { l: 40, r: 8, t: 10, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...data.map((d) => d.views)));
  const y = (v) => pad.t + innerH - (v / max) * innerH;
  const slot = innerW / data.length;
  const barW = Math.max(2, Math.min(18, slot - 2));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Seitenaufrufe pro Tag">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg += `<line class="${i === 0 ? 'baseline' : 'gridline'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    svg += `<text class="axis-label" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(Math.round(v))}</text>`;
  }
  const every = Math.ceil(data.length / 8);
  data.forEach((d, i) => {
    const x = pad.l + i * slot + (slot - barW) / 2;
    const top = y(d.views);
    const h = pad.t + innerH - top;
    if (d.views) {
      const r = Math.min(4, h, barW / 2);
      svg += `<path class="bar-up" d="M${x},${pad.t + innerH}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${pad.t + innerH}Z"/>`;
    }
    if ((i % every === 0 && data.length - 1 - i >= every / 2) || i === data.length - 1) {
      svg += `<text class="axis-label" x="${pad.l + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${dayFmt.format(new Date(d.day))}</text>`;
    }
    svg += `<rect class="hit" data-i="${i}" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${innerH}" rx="3"/>`;
  });
  svg += '</svg>';
  container.innerHTML = `
    <div class="card-head"><div class="muted small">Seitenaufrufe pro Tag</div><button class="btn btn-sm" data-toggle>Als Tabelle</button></div>
    <div class="chart">${svg}<div class="tooltip hidden"></div></div>
    <div class="table-wrap hidden" data-table><table><thead><tr><th>Tag</th><th class="right">Aufrufe</th><th class="right">Besucher</th></tr></thead><tbody>${data
      .slice()
      .reverse()
      .map((d) => `<tr><td>${esc(longFmt.format(new Date(d.day)))}</td><td class="right num">${fmtNum(d.views)}</td><td class="right num">${fmtNum(d.visitors)}</td></tr>`)
      .join('')}</tbody></table></div>`;
  const chart = container.querySelector('.chart');
  const tip = container.querySelector('.tooltip');
  chart.addEventListener('mousemove', (e) => {
    const hit = e.target.closest('.hit');
    chart.querySelectorAll('.hit.on').forEach((h) => h !== hit && h.classList.remove('on'));
    if (!hit) return tip.classList.add('hidden');
    hit.classList.add('on');
    const d = data[Number(hit.dataset.i)];
    tip.innerHTML = `<div class="t-title">${esc(longFmt.format(new Date(d.day)))}</div>
      <div class="t-row"><span><i style="background:var(--series-1)"></i>Aufrufe</span><strong class="num">${fmtNum(d.views)}</strong></div>
      <div class="t-row"><span>Besucher</span><strong class="num">${fmtNum(d.visitors)}</strong></div>`;
    tip.classList.remove('hidden');
    const box = chart.getBoundingClientRect();
    const hx = (Number(hit.getAttribute('x')) + slot / 2) * (box.width / W);
    tip.style.left = `${Math.max(0, hx + 12 + tip.offsetWidth > box.width ? hx - tip.offsetWidth - 12 : hx + 12)}px`;
    tip.style.top = `${Math.max(0, e.clientY - box.top - tip.offsetHeight / 2)}px`;
  });
  chart.addEventListener('mouseleave', () => {
    tip.classList.add('hidden');
    chart.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
  });
  container.querySelector('[data-toggle]').addEventListener('click', (e) => {
    const showTable = !container.querySelector('[data-table]').classList.toggle('hidden');
    chart.classList.toggle('hidden', showTable);
    e.target.textContent = showTable ? 'Als Diagramm' : 'Als Tabelle';
  });
}

function topList(title, rows, unit, empty) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return html`<div class="card"><h2>${title}</h2>${
    rows.length
      ? html`<table><tbody>${rows.map(
          (r) => html`<tr><td style="overflow-wrap:anywhere">${r.key}
            <div class="progress" style="margin-top:4px;height:4px"><span style="width:${raw(String(Math.round((r.n / max) * 100)))}%"></span></div></td>
            <td class="right num nowrap">${fmtNum(r.n)} <span class="muted small">${unit}</span></td></tr>`,
        )}</tbody></table>`
      : html`<p class="muted">${empty}</p>`
  }</div>`;
}

async function statsView(el) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const days = Number(params.get('tage')) || 30;
  const data = await get(`/analytics?days=${days}`);
  const avg = data.totals.visitors ? (data.totals.views / data.totals.visitors).toFixed(1).replace('.', ',') : '–';
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Statistik</h1><div class="sub">Ohne Cookies und ohne Speicherung von IP-Adressen – kein Cookie-Banner nötig</div></div>
        <div class="toolbar">${[7, 30, 90, 365].map((d) => html`<a class="btn btn-sm ${d === days ? 'btn-primary' : ''}" href="#/stats?tage=${d}">${d === 365 ? '1 Jahr' : `${d} Tage`}</a>`)}</div>
      </div>
      <div class="grid grid-4">
        <div class="card stat"><div class="label">Seitenaufrufe</div><div class="value">${fmtNum(data.totals.views)}</div><div class="hint">letzte ${days} Tage</div></div>
        <div class="card stat"><div class="label">Besucher</div><div class="value">${fmtNum(data.totals.visitors)}</div><div class="hint">eindeutig pro Tag</div></div>
        <div class="card stat"><div class="label">Aufrufe je Besucher</div><div class="value">${avg}</div><div class="hint">Durchschnitt</div></div>
        <div class="card stat"><div class="label">Top-Seite</div><div class="value" style="font-size:1.1rem;overflow-wrap:anywhere">${data.pages[0]?.key || '–'}</div><div class="hint">${data.pages[0] ? `${fmtNum(data.pages[0].n)} Aufrufe` : ''}</div></div>
      </div>
      <div class="card" style="margin-top:16px"><div id="views-chart"></div></div>
      <div class="grid grid-3" style="margin-top:16px">
        ${topList('Beliebteste Seiten', data.pages, 'Aufrufe', 'Noch keine Daten.')}
        ${topList('Herkunft', data.referrers, 'Aufrufe', 'Keine externen Verweise.')}
        ${topList('Geräte', data.devices, 'Besucher', 'Noch keine Daten.')}
      </div>`,
  );
  viewsChart($('#views-chart', el), data.days);
}

export default function register(cms) {
  cms.nav({ href: '#/stats', label: 'Statistik', icon: 'stats', group: 'Übersicht', order: 5 });
  cms.route(/^\/stats$/, statsView);
  cms.widget({
    id: 'stats',
    size: 'tile',
    order: 5,
    render(el, data) {
      const s = data.stats || { views: 0, visitors: 0 };
      setHtml(el, html`<div class="label">Besucher (30 Tage)</div><div class="value">${fmtNum(s.visitors)}</div><div class="hint">${fmtNum(s.views)} Seitenaufrufe · <a href="#/stats">Statistik</a></div>`);
    },
  });
}
