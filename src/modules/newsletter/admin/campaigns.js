import { del, get, post, put } from '/admin/js/api.js';
import { ctx, navigate } from '/admin/js/state.js';
import {
  $, $$, CAMPAIGN_STATUS, RECIPIENT_STATUS, badge, confirmDialog, debounce, fmtDateTime, fmtNum, fmtPct, formData, html, modal,
  pager, raw, setHtml, toLocalInput, toast, toastError, setText,
} from '/admin/js/ui.js';

const MERGE_TAGS = [
  ['{{first_name}}', 'Vorname'],
  ['{{last_name}}', 'Nachname'],
  ['{{first_name | "Leser"}}', 'Vorname mit Fallback'],
  ['{{email}}', 'E-Mail'],
  ['{{unsubscribe_url}}', 'Abmeldelink'],
  ['{{preferences_url}}', 'Einstellungen'],
  ['{{webview_url}}', 'Webansicht'],
  ['{{site_name}}', 'Newsletter-Name'],
  ['{{date}}', 'Datum'],
];

const SNIPPETS = {
  h2: ['<h2>', '</h2>', 'Überschrift'],
  p: ['<p>', '</p>', 'Absatz'],
  b: ['<strong>', '</strong>', 'fett'],
  i: ['<em>', '</em>', 'kursiv'],
  ul: ['<ul>\n  <li>', '</li>\n  <li>Punkt 2</li>\n</ul>', 'Punkt 1'],
  hr: ['<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">', '', ''],
};

export async function campaignsView(el) {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = params.get('status') || '';
  const campaigns = await get(`/campaigns${status ? `?status=${status}` : ''}`);
  const filters = [['', 'Alle'], ['draft', 'Entwürfe'], ['scheduled', 'Geplant'], ['sending', 'Laufend'], ['sent', 'Versendet']];

  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Kampagnen</h1><div class="sub">Erstelle, plane und analysiere deine Newsletter</div></div>
        <div class="toolbar"><a class="btn btn-primary" href="#/campaigns/new">+ Neue Kampagne</a></div>
      </div>
      <div class="tabs" role="tablist">${filters.map(
        ([k, label]) => html`<button role="tab" class="${status === k ? 'active' : ''}" data-status="${k}">${label}</button>`,
      )}</div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>Kampagne</th><th>Status</th><th>Datum</th><th class="right">Empfänger</th><th class="right">Öffnungen</th><th class="right">Klicks</th><th></th></tr></thead>
          <tbody>${
            campaigns.length
              ? campaigns.map(
                  (c) => html`<tr class="clickable" data-id="${c.id}" data-status="${c.status}">
                    <td><strong>${c.name}</strong><div class="muted small">${c.subject || '(kein Betreff)'}</div></td>
                    <td>${badge(c.status, CAMPAIGN_STATUS)}</td>
                    <td class="nowrap small">${
                      c.status === 'scheduled' ? html`geplant: ${fmtDateTime(c.scheduled_at)}` : c.started_at ? fmtDateTime(c.started_at) : html`<span class="muted">erstellt ${fmtDateTime(c.created_at)}</span>`
                    }</td>
                    <td class="right num">${c.recipient_count ? fmtNum(c.sent_count) : '–'}</td>
                    <td class="right num">${c.sent_count ? fmtPct(c.open_rate) : '–'}</td>
                    <td class="right num">${c.sent_count ? fmtPct(c.click_rate) : '–'}</td>
                    <td class="right nowrap"><button class="btn btn-sm" data-dup="${c.id}">Duplizieren</button></td>
                  </tr>`,
                )
              : html`<tr><td colspan="7" class="empty">Keine Kampagnen vorhanden. <a href="#/campaigns/new">Jetzt die erste erstellen</a></td></tr>`
          }</tbody>
        </table></div>
      </div>`,
  );

  $$('[data-status]', el).forEach((b) => {
    if (b.tagName === 'BUTTON') b.addEventListener('click', () => navigate(`#/campaigns${b.dataset.status ? `?status=${b.dataset.status}` : ''}`));
  });
  $('tbody', el).addEventListener('click', async (e) => {
    const dup = e.target.closest('[data-dup]');
    if (dup) {
      e.stopPropagation();
      try {
        const copy = await post(`/campaigns/${dup.dataset.dup}/duplicate`);
        toast('Kampagne dupliziert');
        navigate(`#/campaigns/${copy.id}`);
      } catch (err) {
        toastError(err);
      }
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const editable = ['draft', 'scheduled'].includes(tr.dataset.status);
    navigate(`#/campaigns/${tr.dataset.id}${editable ? '' : '/report'}`);
  });
}

// ---------------------------------------------------------------------------
// Editor

export async function campaignEditorView(el, id) {
  const [lists, templates, settings, segments] = await Promise.all([ctx.getLists(true), get('/templates'), ctx.getSettings(), get('/segments')]);
  let campaign = id
    ? await get(`/campaigns/${id}`)
    : {
        name: '',
        subject: '',
        preheader: '',
        content_html: '<h1>Hallo {{first_name | "zusammen"}},</h1>\n<p>hier sind unsere Neuigkeiten …</p>\n',
        list_ids: lists.filter((l) => l.is_public).map((l) => l.id).slice(0, 1),
        template_id: settings.default_template_id,
        track_opens: true,
        track_clicks: true,
        archive: false,
        from_name: '',
        from_email: '',
        reply_to: '',
        content_text: '',
        status: 'draft',
        segment_id: null,
        subject_b: '',
        ab_test_percent: 0,
        ab_wait_hours: 4,
        ab_metric: 'opens',
      };
  if (!['draft', 'scheduled'].includes(campaign.status)) return navigate(`#/campaigns/${id}/report`);
  let dirty = false;

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/campaigns" class="small">‹ Kampagnen</a><h1>${id ? campaign.name : 'Neue Kampagne'}</h1>
          <div class="sub">${badge(campaign.status, CAMPAIGN_STATUS)} ${campaign.status === 'scheduled' ? html`Versand geplant für ${fmtDateTime(campaign.scheduled_at)}` : ''}
          <span id="dirty" class="muted small"></span></div></div>
        <div class="toolbar">
          ${id ? html`<button class="btn btn-ghost" id="delete-btn">Löschen</button>` : ''}
          <button class="btn" id="save-btn">Speichern</button>
          <button class="btn" id="test-btn">Testversand</button>
          ${campaign.status === 'scheduled' ? html`<button class="btn" id="unschedule-btn">Planung aufheben</button>` : html`<button class="btn" id="schedule-btn">Planen</button>`}
          <button class="btn btn-primary" id="send-btn">Jetzt senden</button>
        </div>
      </div>
      <form id="campaign-form" class="editor" novalidate>
        <div class="stack">
          <div class="card">
            <div class="field"><label for="c-name">Interner Name *</label><input id="c-name" name="name" type="text" required value="${campaign.name}" placeholder="z. B. Newsletter Oktober"></div>
            <div class="field"><label for="c-subject">Betreff *</label><input id="c-subject" name="subject" type="text" value="${campaign.subject}" placeholder="Was gibt es Neues?"></div>
            <details ${campaign.subject_b ? raw('open') : ''} style="margin-bottom:14px">
              <summary class="small" style="cursor:pointer;font-weight:600">A/B-Test des Betreffs</summary>
              <p class="muted small" style="margin:8px 0">Ein Teil der Empfänger erhält zufällig Betreff A oder B. Nach der Wartezeit bekommen alle übrigen den Betreff mit der besseren Öffnungs- bzw. Klickrate.</p>
              <div class="field"><label for="c-subject-b">Betreff B</label><input id="c-subject-b" name="subject_b" type="text" value="${campaign.subject_b}" placeholder="Alternative Betreffzeile"></div>
              <div class="inline-fields">
                <div class="field"><label for="c-ab-pct">Testgruppe (%)</label><input id="c-ab-pct" name="ab_test_percent" type="number" min="0" max="100" value="${campaign.ab_test_percent}"><div class="help">0 = kein Test, z. B. 20 = je 10 % A und B</div></div>
                <div class="field"><label for="c-ab-wait">Wartezeit (Stunden)</label><input id="c-ab-wait" name="ab_wait_hours" type="number" min="1" max="168" value="${campaign.ab_wait_hours}"></div>
                <div class="field"><label for="c-ab-metric">Gewinner nach</label><select id="c-ab-metric" name="ab_metric">
                  <option value="opens" ${campaign.ab_metric === 'opens' ? raw('selected') : ''}>Öffnungsrate</option>
                  <option value="clicks" ${campaign.ab_metric === 'clicks' ? raw('selected') : ''}>Klickrate</option>
                </select></div>
              </div>
            </details>
            <div class="field"><label for="c-pre">Vorschautext (Preheader)</label><input id="c-pre" name="preheader" type="text" value="${campaign.preheader}"><div class="help">Wird in vielen Postfächern neben dem Betreff angezeigt.</div></div>
            <div class="inline-fields">
              <div class="field"><label>Empfängerlisten</label>
                <div class="checks">${
                  lists.length
                    ? lists.map(
                        (l) => html`<label class="checkline"><input type="checkbox" name="list_ids" data-array value="${l.id}" ${campaign.list_ids.includes(l.id) ? raw('checked') : ''}> ${l.name} <span class="muted small">(${fmtNum(l.active_count)})</span></label>`,
                      )
                    : html`<span class="muted">Keine Listen – <a href="#/lists">Liste anlegen</a></span>`
                }</div>
                <div class="field" style="margin-top:10px"><label for="c-segment">Segment (optional)</label>
                  <select id="c-segment" name="segment_id"><option value="">– kein Segment –</option>${segments.map(
                    (sg) => html`<option value="${sg.id}" ${campaign.segment_id === sg.id ? raw('selected') : ''}>${sg.name} (${fmtNum(sg.count)})</option>`,
                  )}</select>
                  <div class="help">Schränkt die Listen weiter ein. Ohne Liste gilt das Segment für alle Abonnenten. <a href="#/segments">Segmente verwalten</a></div></div>
                <div class="help" id="audience"></div>
              </div>
              <div class="field"><label for="c-template">Vorlage</label>
                <select id="c-template" name="template_id"><option value="">Eingebautes Standardlayout</option>${templates.map(
                  (t) => html`<option value="${t.id}" ${campaign.template_id === t.id ? raw('selected') : ''}>${t.name}</option>`,
                )}</select>
                <label class="checkline" style="margin-top:12px"><input type="checkbox" name="track_opens" ${campaign.track_opens ? raw('checked') : ''}> Öffnungen tracken</label>
                <label class="checkline"><input type="checkbox" name="track_clicks" ${campaign.track_clicks ? raw('checked') : ''}> Klicks tracken</label>
                <label class="checkline"><input type="checkbox" name="archive" ${campaign.archive ? raw('checked') : ''}> Im öffentlichen Archiv zeigen</label>
              </div>
            </div>
            <details>
              <summary class="small" style="cursor:pointer;font-weight:600">Absender &amp; Antwortadresse</summary>
              <div class="inline-fields" style="margin-top:12px">
                <div class="field"><label for="c-fromname">Absendername</label><input id="c-fromname" name="from_name" type="text" value="${campaign.from_name}" placeholder="${settings.sender_name}"></div>
                <div class="field"><label for="c-fromemail">Absender-E-Mail</label><input id="c-fromemail" name="from_email" type="email" value="${campaign.from_email}" placeholder="${settings.sender_email}"></div>
              </div>
              <div class="field"><label for="c-reply">Antwort an</label><input id="c-reply" name="reply_to" type="email" value="${campaign.reply_to}" placeholder="${settings.reply_to || 'wie Absender'}"></div>
            </details>
          </div>
          <div class="card">
            <div class="card-head"><h2>Inhalt (HTML)</h2></div>
            <div class="editor-toolbar">
              <button type="button" class="btn" data-snip="h2">Überschrift</button>
              <button type="button" class="btn" data-snip="p">Absatz</button>
              <button type="button" class="btn" data-snip="b"><strong>F</strong></button>
              <button type="button" class="btn" data-snip="i"><em>K</em></button>
              <button type="button" class="btn" data-snip="ul">Liste</button>
              <button type="button" class="btn" data-action="link">Link</button>
              <button type="button" class="btn" data-action="button">Button</button>
              <button type="button" class="btn" data-action="image">Bild</button>
              <button type="button" class="btn" data-snip="hr">Trenner</button>
            </div>
            <textarea id="c-html" name="content_html" class="code" spellcheck="false">${campaign.content_html}</textarea>
            <div class="field" style="margin-top:10px"><label>Platzhalter einfügen</label>
              <div class="tag-list">${MERGE_TAGS.map(([tag, label]) => html`<button type="button" data-tag="${tag}" title="${tag}">${label}</button>`)}</div>
            </div>
            <details>
              <summary class="small" style="cursor:pointer;font-weight:600">Eigene Textversion (optional)</summary>
              <textarea name="content_text" class="code" style="min-height:140px;margin-top:8px" placeholder="Leer lassen, um die Textversion automatisch aus dem HTML zu erzeugen.">${campaign.content_text}</textarea>
            </details>
          </div>
        </div>
        <div>
          <div class="card" style="position:sticky;top:16px">
            <div class="card-head"><h2>Vorschau</h2>
              <div class="toolbar"><button type="button" class="btn btn-sm" data-view="desktop">Desktop</button><button type="button" class="btn btn-sm" data-view="mobile">Mobil</button></div>
            </div>
            <div class="muted small" id="preview-subject"></div>
            <iframe id="preview" class="preview-frame" sandbox="" title="E-Mail-Vorschau"></iframe>
          </div>
        </div>
      </form>`,
  );

  const form = $('#campaign-form', el);
  const textarea = $('#c-html', el);
  const frame = $('#preview', el);

  const collect = () => {
    const d = formData(form);
    return {
      ...d,
      list_ids: (d.list_ids || []).map(Number),
      template_id: d.template_id ? Number(d.template_id) : null,
      segment_id: d.segment_id ? Number(d.segment_id) : null,
      ab_test_percent: Number(d.ab_test_percent) || 0,
      ab_wait_hours: Number(d.ab_wait_hours) || 4,
    };
  };

  const refreshPreview = debounce(async () => {
    const d = collect();
    try {
      const res = await post('/campaigns/preview', { subject: d.subject, preheader: d.preheader, content_html: d.content_html, template_id: d.template_id || undefined });
      frame.srcdoc = res.html;
      setText($('#preview-subject', el), `Betreff: ${res.subject || '–'}`);
    } catch (err) {
      setText($('#preview-subject', el), err.message);
    }
  }, 400);

  const refreshAudience = debounce(async () => {
    const { list_ids, segment_id } = collect();
    const { count } = await post('/campaigns/audience', { list_ids, segment_id: segment_id || undefined });
    setText($('#audience', el), `${fmtNum(count)} aktive Empfänger (Duplikate werden nur einmal beliefert)`);
  }, 200);

  const markDirty = () => {
    dirty = true;
    setText($('#dirty', el), '· Ungespeicherte Änderungen');
  };

  form.addEventListener('input', (e) => {
    markDirty();
    if (['content_html', 'subject', 'preheader'].includes(e.target.name)) refreshPreview();
  });
  form.addEventListener('change', (e) => {
    markDirty();
    if (e.target.name === 'list_ids' || e.target.name === 'segment_id') refreshAudience();
    if (e.target.name === 'template_id') refreshPreview();
  });

  const insert = (before, after = '', placeholder = '') => {
    const { selectionStart: s, selectionEnd: e, value } = textarea;
    const selected = value.slice(s, e) || placeholder;
    textarea.setRangeText(before + selected + after, s, e, 'end');
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  $$('[data-snip]', el).forEach((b) => b.addEventListener('click', () => insert(...SNIPPETS[b.dataset.snip])));
  $$('[data-tag]', el).forEach((b) => b.addEventListener('click', () => insert(b.dataset.tag)));
  $$('[data-action]', el).forEach((b) =>
    b.addEventListener('click', () => {
      const action = b.dataset.action;
      modal({
        title: { link: 'Link einfügen', button: 'Button einfügen', image: 'Bild einfügen' }[action],
        submitLabel: 'Einfügen',
        body: html`<div class="field"><label for="ins-url">${action === 'image' ? 'Bild-URL' : 'Ziel-URL'}</label><input id="ins-url" name="url" type="url" required placeholder="https://"></div>
          <div class="field"><label for="ins-text">${action === 'image' ? 'Alternativtext' : 'Text'}</label><input id="ins-text" name="text" type="text" value="${textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)}"></div>`,
        onSubmit: (f) => {
          const url = f.url.value.replace(/"/g, '%22');
          const text = f.text.value.replace(/</g, '&lt;');
          if (action === 'link') insert(`<a href="${url}">${text || url}</a>`);
          else if (action === 'button')
            insert(`<p><a href="${url}" style="display:inline-block;background:#2a78d6;color:#ffffff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold;">${text || 'Mehr erfahren'}</a></p>`);
          else insert(`<img src="${url}" alt="${text.replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;display:block;border:0;">`);
        },
      });
    }),
  );
  $$('[data-view]', el).forEach((b) => b.addEventListener('click', () => frame.classList.toggle('mobile', b.dataset.view === 'mobile')));

  async function save({ quiet = false } = {}) {
    const data = collect();
    if (!data.name.trim()) {
      $('#c-name', el).focus();
      throw new Error('Bitte einen internen Namen angeben');
    }
    if (campaign.id) campaign = await put(`/campaigns/${campaign.id}`, data);
    else {
      campaign = await post('/campaigns', data);
      history.replaceState(null, '', `#/campaigns/${campaign.id}`);
    }
    dirty = false;
    setText($('#dirty', el), '');
    if (!quiet) toast('Kampagne gespeichert');
    return campaign;
  }

  const guarded = (fn) => async () => {
    try {
      await fn();
    } catch (err) {
      toastError(err);
    }
  };

  $('#save-btn', el).addEventListener('click', guarded(() => save()));
  $('#delete-btn', el)?.addEventListener(
    'click',
    guarded(async () => {
      if (!(await confirmDialog('Kampagne löschen', `„${campaign.name}“ endgültig löschen?`, { submitLabel: 'Löschen' }))) return;
      await del(`/campaigns/${campaign.id}`);
      toast('Kampagne gelöscht');
      navigate('#/campaigns');
    }),
  );
  $('#test-btn', el).addEventListener(
    'click',
    guarded(async () => {
      await save({ quiet: true });
      modal({
        title: 'Testversand',
        submitLabel: 'Test senden',
        body: html`<div class="field"><label for="t-emails">Empfänger</label><input id="t-emails" name="emails" type="text" required value="${ctx.user.email}">
          <div class="help">Bis zu 10 Adressen, durch Komma getrennt. Ist eine Adresse als Abonnent eingetragen, werden deren Daten für die Platzhalter verwendet.</div></div>`,
        onSubmit: async (f) => {
          const res = await post(`/campaigns/${campaign.id}/test`, { emails: f.emails.value });
          toast(`Test an ${res.sent.join(', ')} gesendet`);
        },
      });
    }),
  );
  $('#schedule-btn', el)?.addEventListener(
    'click',
    guarded(async () => {
      await save({ quiet: true });
      modal({
        title: 'Versand planen',
        submitLabel: 'Planen',
        body: html`<div class="field"><label for="s-at">Zeitpunkt (Ortszeit)</label><input id="s-at" name="at" type="datetime-local" required value="${toLocalInput()}"></div>
          <p class="muted small">Die Empfänger werden zum Versandzeitpunkt aus den gewählten Listen ermittelt.</p>`,
        onSubmit: async (f) => {
          await post(`/campaigns/${campaign.id}/schedule`, { scheduled_at: new Date(f.at.value).toISOString() });
          toast('Versand geplant');
          navigate('#/campaigns');
        },
      });
    }),
  );
  $('#unschedule-btn', el)?.addEventListener(
    'click',
    guarded(async () => {
      await post(`/campaigns/${campaign.id}/unschedule`);
      toast('Planung aufgehoben');
      campaignEditorView(el, campaign.id);
    }),
  );
  $('#send-btn', el).addEventListener(
    'click',
    guarded(async () => {
      await save({ quiet: true });
      const { count } = await post('/campaigns/audience', { list_ids: campaign.list_ids, segment_id: campaign.segment_id || undefined });
      const ab = campaign.subject_b && campaign.ab_test_percent > 0;
      const text = ab
        ? `A/B-Test: ${campaign.ab_test_percent} % von ${fmtNum(count)} Empfängern erhalten jetzt Betreff A oder B, die übrigen nach ${campaign.ab_wait_hours} Stunden den Gewinner.`
        : `„${campaign.subject}“ wird jetzt an ${fmtNum(count)} Empfänger versendet.`;
      if (!(await confirmDialog('Jetzt senden?', `${text} Dies kann nicht rückgängig gemacht werden.`, { submitLabel: 'Jetzt senden', danger: false }))) return;
      await post(`/campaigns/${campaign.id}/send`);
      toast('Versand gestartet');
      navigate(`#/campaigns/${campaign.id}/report`);
    }),
  );

  const beforeUnload = (e) => {
    if (dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);

  refreshPreview();
  refreshAudience();
  return () => window.removeEventListener('beforeunload', beforeUnload);
}

// ---------------------------------------------------------------------------
// Bericht

/** Vergleich der beiden Betreffzeilen eines A/B-Tests. */
function abCard(c, ab) {
  const metric = c.ab_metric === 'clicks' ? 'click_rate' : 'open_rate';
  const leader = ab.b[metric] > ab.a[metric] ? 'b' : 'a';
  const pending = !c.ab_winner && ['sending', 'paused'].includes(c.status);
  const row = (v, subject) => html`<tr>
    <td><strong>${v.toUpperCase()}</strong> ${c.ab_winner === v ? html`<span class="badge badge-good">Gewinner</span>` : pending && leader === v ? html`<span class="badge badge-info">vorn</span>` : ''}</td>
    <td style="overflow-wrap:anywhere">${subject}</td>
    <td class="right num">${fmtNum(ab[v].sent)}</td>
    <td class="right num">${fmtPct(ab[v].open_rate)}</td>
    <td class="right num">${fmtPct(ab[v].click_rate)}</td>
    <td class="right">${pending ? html`<button class="btn btn-sm" data-ab-win="${v}">Als Gewinner wählen</button>` : ''}</td></tr>`;
  return html`<div class="card" style="margin-top:16px">
    <div class="card-head"><h2>A/B-Test des Betreffs</h2>
      <span class="muted small">${
        c.ab_winner
          ? `Entschieden nach ${c.ab_metric === 'clicks' ? 'Klickrate' : 'Öffnungsrate'}`
          : pending
            ? `Automatische Entscheidung ${c.ab_test_ends_at ? `am ${fmtDateTime(c.ab_test_ends_at)}` : ''} nach ${c.ab_metric === 'clicks' ? 'Klickrate' : 'Öffnungsrate'} · ${fmtNum(c.held_count)} Empfänger warten`
            : ''
      }</span></div>
    <div class="table-wrap"><table><thead><tr><th>Variante</th><th>Betreff</th><th class="right">Zugestellt</th><th class="right">Öffnungsrate</th><th class="right">Klickrate</th><th></th></tr></thead>
      <tbody>${row('a', c.subject)}${row('b', c.subject_b)}</tbody></table></div>
  </div>`;
}

export async function campaignReportView(el, id) {
  let timer = null;
  let stopped = false;
  const state = { filter: '', page: 1 };

  async function render() {
    const report = await get(`/campaigns/${id}/report`);
    if (stopped) return;
    const c = report.campaign;
    const t = report.totals;
    const done = c.sent_count + c.failed_count;
    const progress = c.recipient_count ? Math.round((done / c.recipient_count) * 100) : 0;
    const running = ['sending', 'paused'].includes(c.status);

    setHtml(
      el,
      html`<div class="page-head">
          <div><a href="#/campaigns" class="small">‹ Kampagnen</a><h1>${c.name}</h1>
            <div class="sub">${badge(c.status, CAMPAIGN_STATUS)} Betreff: ${c.subject}</div></div>
          <div class="toolbar">
            <a class="btn" href="/api/campaigns/${c.id}/preview" id="preview-btn">Vorschau</a>
            <button class="btn" id="dup-btn">Duplizieren</button>
            ${c.status === 'sending' ? html`<button class="btn" id="pause-btn">Pausieren</button>` : ''}
            ${c.status === 'paused' ? html`<button class="btn btn-primary" id="resume-btn">Fortsetzen</button>` : ''}
            ${running ? html`<button class="btn btn-danger" id="cancel-btn">Abbrechen</button>` : ''}
          </div>
        </div>
        ${
          running
            ? html`<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>Versandfortschritt</h2><span class="num">${fmtNum(done)} / ${fmtNum(c.recipient_count)} (${progress} %)</span></div>
                <div class="progress" role="progressbar" aria-valuenow="${progress}" aria-valuemin="0" aria-valuemax="100"><span style="width:${progress}%"></span></div></div>`
            : ''
        }
        <div class="grid grid-4">
          <div class="card stat"><div class="label">Zugestellt</div><div class="value">${fmtNum(c.sent_count)}</div><div class="hint">von ${fmtNum(c.recipient_count)} Empfängern${c.failed_count ? ` · ${fmtNum(c.failed_count)} Fehler` : ''}</div></div>
          <div class="card stat"><div class="label">Öffnungsrate</div><div class="value">${fmtPct(c.open_rate)}</div><div class="hint">${fmtNum(c.unique_opens)} eindeutig · ${fmtNum(t.total_opens)} gesamt</div></div>
          <div class="card stat"><div class="label">Klickrate</div><div class="value">${fmtPct(c.click_rate)}</div><div class="hint">${fmtNum(c.unique_clicks)} eindeutig · Klick-zu-Öffnung ${fmtPct(t.click_to_open_rate)}</div></div>
          <div class="card stat"><div class="label">Abmeldungen</div><div class="value">${fmtNum(c.unsubscribes)}</div><div class="hint">${fmtNum(t.bounces)} Bounces/Beschwerden</div></div>
        </div>
        ${report.ab ? abCard(c, report.ab) : ''}
        <div class="grid grid-2" style="margin-top:16px">
          <div class="card">
            <h2>Details</h2>
            <dl class="summary-list">
              <dt>Gestartet</dt><dd>${fmtDateTime(c.started_at)}</dd>
              <dt>Abgeschlossen</dt><dd>${fmtDateTime(c.finished_at)}</dd>
              <dt>Tracking</dt><dd>${c.track_opens ? 'Öffnungen' : ''}${c.track_opens && c.track_clicks ? ', ' : ''}${c.track_clicks ? 'Klicks' : ''}${!c.track_opens && !c.track_clicks ? 'aus' : ''}</dd>
              <dt>Archiv</dt><dd><label class="checkline" style="margin:0"><input type="checkbox" id="archive-toggle" ${c.archive ? raw('checked') : ''}> öffentlich im Archiv</label></dd>
            </dl>
          </div>
          <div class="card">
            <h2>Links</h2>
            ${
              report.links.length
                ? html`<div class="table-wrap"><table><thead><tr><th>URL</th><th class="right">Eindeutig</th><th class="right">Gesamt</th></tr></thead><tbody>${report.links.map(
                    (l) => html`<tr><td style="overflow-wrap:anywhere"><a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.url}</a></td><td class="right num">${fmtNum(l.unique_clicks)}</td><td class="right num">${fmtNum(l.clicks)}</td></tr>`,
                  )}</tbody></table></div>`
                : html`<p class="muted">Keine getrackten Links.</p>`
            }
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>Empfänger</h2>
            <select id="r-filter" style="max-width:200px" aria-label="Filter">
              ${[['', 'Alle'], ['sent', 'Zugestellt'], ['opened', 'Geöffnet'], ['clicked', 'Geklickt'], ['queued', 'Wartend'], ['held', 'Wartet auf A/B'], ['failed', 'Fehlgeschlagen'], ['skipped', 'Übersprungen']].map(
                ([k, v]) => html`<option value="${k}" ${state.filter === k ? raw('selected') : ''}>${v}</option>`,
              )}
            </select>
          </div>
          <div id="recipients"></div>
        </div>`,
    );

    const act = (sel, path, msg, confirmText) =>
      $(sel, el)?.addEventListener('click', async () => {
        if (confirmText && !(await confirmDialog('Bestätigen', confirmText))) return;
        try {
          await post(`/campaigns/${id}/${path}`);
          toast(msg);
          render();
        } catch (err) {
          toastError(err);
        }
      });
    $$('[data-ab-win]', el).forEach((b) =>
      b.addEventListener('click', async () => {
        const v = b.dataset.abWin;
        if (!(await confirmDialog('Gewinner festlegen', `Alle übrigen Empfänger erhalten jetzt Betreff ${v.toUpperCase()}.`, { submitLabel: 'Festlegen', danger: false }))) return;
        try {
          await post(`/campaigns/${id}/ab-winner`, { variant: v });
          toast(`Betreff ${v.toUpperCase()} wird an die übrigen Empfänger versendet`);
          render();
        } catch (err) {
          toastError(err);
        }
      }),
    );
    act('#pause-btn', 'pause', 'Versand pausiert');
    act('#resume-btn', 'resume', 'Versand fortgesetzt');
    act('#cancel-btn', 'cancel', 'Versand abgebrochen', 'Versand endgültig abbrechen? Noch nicht versendete E-Mails werden verworfen.');
    $('#dup-btn', el).addEventListener('click', async () => {
      const copy = await post(`/campaigns/${id}/duplicate`);
      navigate(`#/campaigns/${copy.id}`);
    });
    $('#preview-btn', el).addEventListener('click', async (e) => {
      e.preventDefault();
      const res = await get(`/campaigns/${id}/preview?format=json`);
      modal({ title: 'Vorschau', wide: true, cancelLabel: 'Schließen', body: html`<iframe class="preview-frame" sandbox="" title="Vorschau"></iframe>`, onOpen: (d) => ($('iframe', d).srcdoc = res.html) });
    });
    $('#archive-toggle', el).addEventListener('change', async (e) => {
      try {
        await put(`/campaigns/${id}`, { archive: e.target.checked });
        toast(e.target.checked ? 'Im Archiv veröffentlicht' : 'Aus dem Archiv entfernt');
      } catch (err) {
        toastError(err);
      }
    });
    $('#r-filter', el).addEventListener('change', (e) => {
      state.filter = e.target.value;
      state.page = 1;
      loadRecipients();
    });
    await loadRecipients();

    clearTimeout(timer);
    if (c.status === 'sending' && !stopped) timer = setTimeout(render, 3000);
  }

  async function loadRecipients() {
    const qs = new URLSearchParams({ page: state.page, per_page: 25 });
    if (state.filter) qs.set('status', state.filter);
    const data = await get(`/campaigns/${id}/recipients?${qs}`);
    const box = $('#recipients', el);
    setHtml(
      box,
      html`<div class="table-wrap"><table><thead><tr><th>E-Mail</th><th>Status</th><th>Betreff</th><th>Gesendet</th><th>Geöffnet</th><th>Klicks</th></tr></thead><tbody>${
        data.items.length
          ? data.items.map(
              (r) => html`<tr>
                <td>${r.subscriber_id ? html`<a href="#/subscribers/${r.subscriber_id}">${r.email}</a>` : r.email}</td>
                <td>${badge(r.status, RECIPIENT_STATUS)}${r.error ? html`<div class="muted small">${r.error}</div>` : ''}</td>
                <td class="small">${r.variant ? r.variant.toUpperCase() : '–'}</td>
                <td class="nowrap small">${fmtDateTime(r.sent_at)}</td>
                <td class="nowrap small">${r.opened_at ? `${fmtDateTime(r.opened_at)} (${r.open_count}×)` : '–'}</td>
                <td class="num">${r.click_count || '–'}</td></tr>`,
            )
          : html`<tr><td colspan="6" class="empty">Keine Empfänger.</td></tr>`
      }</tbody></table></div>`,
    );
    box.append(
      pager(data, (p) => {
        state.page = p;
        loadRecipients();
      }),
    );
  }

  await render();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
