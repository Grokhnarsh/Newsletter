import { esc, fmtNum } from './ui.js';

const dayFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const longFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: 'long' });

function niceMax(v) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s * 4 >= v);
  return step * 4;
}

/** Pfad für einen Balken mit abgerundetem Datenende (4px) und flachem Ende an der Nulllinie. */
function barPath(x, w, y0, y1) {
  const h = Math.abs(y1 - y0);
  if (h < 0.5) return '';
  const r = Math.min(4, h, w / 2);
  if (y1 < y0) {
    // nach oben
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  // nach unten
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

/**
 * Zeichnet An- (nach oben) und Abmeldungen (nach unten) pro Tag auf einer gemeinsamen
 * Nulllinie, mit Hover-Tooltip pro Tag und umschaltbarer Tabellenansicht.
 */
export function growthChart(container, data) {
  const W = 760;
  const H = 260;
  const pad = { l: 36, r: 8, t: 12, b: 26 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const maxUp = niceMax(Math.max(1, ...data.map((d) => d.subscribed)));
  const maxDown = Math.max(...data.map((d) => d.unsubscribed));
  const downMax = maxDown ? niceMax(maxDown) : 0;
  // Eine gemeinsame Skala für beide Richtungen (eine Achse)
  const unit = innerH / (maxUp + (downMax ? Math.max(downMax, maxUp / 4) : 0));
  const zeroY = pad.t + maxUp * unit;
  const y = (v) => zeroY - v * unit;
  const slot = innerW / data.length;
  const barW = Math.max(2, Math.min(18, slot - 2));

  const ticks = [];
  for (let i = 0; i <= 4; i++) ticks.push((maxUp / 4) * i);
  if (downMax) ticks.push(-Math.max(downMax, maxUp / 4));

  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Anmeldungen und Abmeldungen pro Tag">`;
  for (const t of ticks) {
    const ty = y(t);
    svg += `<line class="${t === 0 ? 'baseline' : 'gridline'}" x1="${pad.l}" x2="${W - pad.r}" y1="${ty}" y2="${ty}"/>`;
    svg += `<text class="axis-label" x="${pad.l - 6}" y="${ty + 4}" text-anchor="end">${fmtNum(Math.abs(Math.round(t)))}</text>`;
  }
  const labelEvery = Math.ceil(data.length / 8);
  data.forEach((d, i) => {
    const x = pad.l + i * slot + (slot - barW) / 2;
    if (d.subscribed) svg += `<path class="bar-up" d="${barPath(x, barW, zeroY - 1, y(d.subscribed))}"/>`;
    if (d.unsubscribed) svg += `<path class="bar-down" d="${barPath(x, barW, zeroY + 1, y(-d.unsubscribed))}"/>`;
    if ((i % labelEvery === 0 && data.length - 1 - i >= labelEvery / 2) || i === data.length - 1) {
      svg += `<text class="axis-label" x="${pad.l + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${dayFmt.format(new Date(d.day))}</text>`;
    }
    svg += `<rect class="hit" data-i="${i}" x="${pad.l + i * slot}" y="${pad.t}" width="${slot}" height="${innerH}" rx="3"/>`;
  });
  svg += '</svg>';

  container.innerHTML = `
    <div class="card-head">
      <div class="chart-legend" aria-hidden="true">
        <span><i style="background:var(--series-1)"></i>Anmeldungen</span>
        <span><i style="background:var(--series-2)"></i>Abmeldungen &amp; Bounces</span>
      </div>
      <button class="btn btn-sm" data-toggle>Als Tabelle</button>
    </div>
    <div class="chart">${svg}<div class="tooltip hidden"></div></div>
    <div class="table-wrap hidden" data-table>
      <table><thead><tr><th>Tag</th><th class="right">Anmeldungen</th><th class="right">Abmeldungen</th></tr></thead>
      <tbody>${data
        .slice()
        .reverse()
        .map((d) => `<tr><td>${esc(longFmt.format(new Date(d.day)))}</td><td class="right num">${fmtNum(d.subscribed)}</td><td class="right num">${fmtNum(d.unsubscribed)}</td></tr>`)
        .join('')}</tbody></table>
    </div>`;

  const chart = container.querySelector('.chart');
  const tip = container.querySelector('.tooltip');
  chart.addEventListener('mousemove', (e) => {
    const hit = e.target.closest('.hit');
    chart.querySelectorAll('.hit.on').forEach((h) => h !== hit && h.classList.remove('on'));
    if (!hit) return tip.classList.add('hidden');
    hit.classList.add('on');
    const d = data[Number(hit.dataset.i)];
    tip.innerHTML = `<div class="t-title">${esc(longFmt.format(new Date(d.day)))}</div>
      <div class="t-row"><span><i style="background:var(--series-1)"></i>Anmeldungen</span><strong class="num">${fmtNum(d.subscribed)}</strong></div>
      <div class="t-row"><span><i style="background:var(--series-2)"></i>Abmeldungen</span><strong class="num">${fmtNum(d.unsubscribed)}</strong></div>`;
    tip.classList.remove('hidden');
    const box = chart.getBoundingClientRect();
    const scale = box.width / W;
    const hx = (Number(hit.getAttribute('x')) + slot / 2) * scale;
    const left = hx + 12 + tip.offsetWidth > box.width ? hx - tip.offsetWidth - 12 : hx + 12;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${Math.max(0, e.clientY - box.top - tip.offsetHeight / 2)}px`;
  });
  chart.addEventListener('mouseleave', () => {
    tip.classList.add('hidden');
    chart.querySelectorAll('.hit.on').forEach((h) => h.classList.remove('on'));
  });
  const toggle = container.querySelector('[data-toggle]');
  toggle.addEventListener('click', () => {
    const showTable = !container.querySelector('[data-table]').classList.toggle('hidden');
    chart.classList.toggle('hidden', showTable);
    toggle.textContent = showTable ? 'Als Diagramm' : 'Als Tabelle';
  });
}
