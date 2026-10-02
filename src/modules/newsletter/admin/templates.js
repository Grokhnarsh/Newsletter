import { del, get, post, put } from '/admin/js/api.js';
import { ctx, navigate } from '/admin/js/state.js';
import { $, confirmDialog, debounce, fmtDateTime, html, setHtml, toast, toastError } from '/admin/js/ui.js';

const STARTER = `<!DOCTYPE html>
<html lang="de">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{{subject}}</title></head>
<body style="margin:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;">
      <tr><td style="padding:32px;font-size:16px;line-height:1.6;color:#1f2937;">
        {{{content}}}
      </td></tr>
      <tr><td style="padding:16px 32px;font-size:12px;color:#6b7280;">
        {{company_address}}<br>
        <a href="{{unsubscribe_url}}" style="color:#6b7280;">Abmelden</a> · <a href="{{preferences_url}}" style="color:#6b7280;">Einstellungen</a>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;

export async function templatesView(el) {
  const [templates, settings] = await Promise.all([get('/templates'), ctx.getSettings(true)]);
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Vorlagen</h1><div class="sub">Layouts, in die der Kampagneninhalt über <code>{{{content}}}</code> eingesetzt wird</div></div>
        <div class="toolbar"><a class="btn btn-primary" href="#/templates/new">+ Neue Vorlage</a></div>
      </div>
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Verwendet in</th><th>Geändert</th><th></th></tr></thead>
        <tbody>${
          templates.length
            ? templates.map(
                (t) => html`<tr>
                  <td><a href="#/templates/${t.id}"><strong>${t.name}</strong></a> ${settings.default_template_id === t.id ? html`<span class="badge badge-info">Standard</span>` : ''}</td>
                  <td>${t.campaign_count} Kampagne(n)</td>
                  <td class="nowrap small">${fmtDateTime(t.updated_at)}</td>
                  <td class="right nowrap">
                    ${ctx.isAdmin && settings.default_template_id !== t.id ? html`<button class="btn btn-sm" data-default="${t.id}">Als Standard</button>` : ''}
                    <button class="btn btn-sm" data-dup="${t.id}">Duplizieren</button>
                    <button class="btn btn-sm btn-ghost" data-del="${t.id}" aria-label="Löschen">🗑</button>
                  </td></tr>`,
              )
            : html`<tr><td colspan="4" class="empty">Keine Vorlagen vorhanden.</td></tr>`
        }</tbody>
      </table></div></div>`,
  );

  el.querySelectorAll('[data-dup]').forEach((b) =>
    b.addEventListener('click', async () => {
      const t = await post(`/templates/${b.dataset.dup}/duplicate`);
      navigate(`#/templates/${t.id}`);
    }),
  );
  el.querySelectorAll('[data-default]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await put('/settings', { default_template_id: Number(b.dataset.default) });
        toast('Standardvorlage geändert');
        templatesView(el);
      } catch (err) {
        toastError(err);
      }
    }),
  );
  el.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!(await confirmDialog('Vorlage löschen', 'Vorlage löschen? Kampagnen, die sie nutzen, verwenden danach das Standardlayout.', { submitLabel: 'Löschen' }))) return;
      try {
        await del(`/templates/${b.dataset.del}`);
        toast('Vorlage gelöscht');
        templatesView(el);
      } catch (err) {
        toastError(err);
      }
    }),
  );
}

export async function templateEditorView(el, id) {
  const isNew = id === 'new';
  const template = isNew ? { name: '', html: STARTER } : await get(`/templates/${id}`);

  setHtml(
    el,
    html`<div class="page-head">
        <div><a href="#/templates" class="small">‹ Vorlagen</a><h1>${isNew ? 'Neue Vorlage' : template.name}</h1></div>
        <div class="toolbar"><button class="btn btn-primary" id="save">Speichern</button></div>
      </div>
      <div class="editor">
        <div class="card">
          <div class="field"><label for="t-name">Name *</label><input id="t-name" type="text" required value="${template.name}"></div>
          <div class="field"><label for="t-html">HTML</label><textarea id="t-html" class="code" spellcheck="false" style="min-height:520px">${template.html}</textarea>
            <div class="help">Pflicht: <code>{{{content}}}</code>. Weitere Platzhalter: <code>{{unsubscribe_url}}</code>, <code>{{preferences_url}}</code>, <code>{{webview_url}}</code>,
            <code>{{site_name}}</code>, <code>{{company_address}}</code>, <code>{{subject}}</code>, <code>{{first_name}}</code> …
            Fehlt der Abmeldelink, wird er automatisch ergänzt.</div></div>
        </div>
        <div class="card"><h2>Vorschau</h2><iframe id="t-preview" class="preview-frame" sandbox="" title="Vorlagen-Vorschau"></iframe></div>
      </div>`,
  );

  const frame = $('#t-preview', el);
  const area = $('#t-html', el);
  const sample = '<h1>Beispielüberschrift</h1><p>So sieht dein Inhalt in dieser Vorlage aus. <a href="https://example.com">Ein Link</a>.</p>';
  // Lokale Vorschau: Inhalt einsetzen, Platzhalter mit Beispielwerten füllen
  const refresh = debounce(() => {
    frame.srcdoc = area.value
      .replace(/\{\{\{\s*content\s*\}\}\}|\{\{\s*content\s*\}\}/, sample)
      .replace(/\{\{\s*site_name\s*\}\}/g, ctx.settings?.site_name || 'Newsletter')
      .replace(/\{\{\s*company_address\s*\}\}/g, ctx.settings?.company_address || 'Firmenadresse')
      .replace(/\{\{\s*subject\s*\}\}/g, 'Betreff')
      .replace(/\{\{[^}]*\}\}/g, '#');
  }, 300);
  area.addEventListener('input', refresh);
  refresh();

  $('#save', el).addEventListener('click', async () => {
    const data = { name: $('#t-name', el).value, html: area.value };
    try {
      if (isNew) {
        const created = await post('/templates', data);
        toast('Vorlage angelegt');
        navigate(`#/templates/${created.id}`);
      } else {
        await put(`/templates/${id}`, data);
        toast('Vorlage gespeichert');
      }
    } catch (err) {
      toastError(err);
    }
  });
}
