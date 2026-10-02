import { del, post, put } from '../api.js';
import { ctx } from '../state.js';
import { $, confirmDialog, esc, fmtNum, html, modal, raw, setHtml, toast, toastError } from '../ui.js';

function listDialog(list, onSaved) {
  modal({
    title: list ? 'Liste bearbeiten' : 'Neue Liste',
    body: html`
      <div class="field"><label for="l-name">Name *</label><input id="l-name" name="name" type="text" required value="${list?.name || ''}"></div>
      <div class="field"><label for="l-desc">Beschreibung</label><textarea id="l-desc" name="description" style="min-height:70px">${list?.description || ''}</textarea></div>
      <label class="checkline"><input type="checkbox" name="is_public" ${list?.is_public ? raw('checked') : ''}> Öffentlich (im Anmeldeformular und auf der Einstellungsseite wählbar)</label>`,
    onSubmit: async (form) => {
      const data = { name: form.name.value, description: form.description.value, is_public: form.is_public.checked };
      if (list) await put(`/lists/${list.id}`, data);
      else await post('/lists', data);
      toast('Liste gespeichert');
      ctx.invalidateLists();
      onSaved();
    },
  });
}

function embedCode(lists) {
  const base = location.origin;
  const publicLists = lists.filter((l) => l.is_public);
  const listInputs =
    publicLists.length > 1
      ? publicLists.map((l) => `  <label><input type="checkbox" name="list_ids" value="${l.id}" checked> ${esc(l.name)}</label><br>\n`).join('')
      : '';
  return `<form action="${base}/subscribe" method="post">
  <input type="email" name="email" placeholder="E-Mail-Adresse" required>
  <input type="text" name="first_name" placeholder="Vorname">
${listInputs}  <!-- Spam-Schutz: dieses Feld muss leer bleiben -->
  <input type="text" name="website" style="display:none" tabindex="-1" autocomplete="off">
  <label><input type="checkbox" name="consent" value="1" required> Ich stimme der Datenschutzerklärung zu.</label>
  <button type="submit">Abonnieren</button>
</form>`;
}

export async function listsView(el) {
  const lists = await ctx.getLists(true);
  setHtml(
    el,
    html`<div class="page-head">
        <div><h1>Listen</h1><div class="sub">Gruppiere Abonnenten nach Themen oder Zielgruppen</div></div>
        <div class="toolbar"><button class="btn" id="embed-btn">Formular einbetten</button><button class="btn btn-primary" id="add-btn">+ Neue Liste</button></div>
      </div>
      <div class="card">
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Sichtbarkeit</th><th class="right">Aktiv</th><th class="right">Gesamt</th><th></th></tr></thead>
          <tbody>${
            lists.length
              ? lists.map(
                  (l) => html`<tr>
                    <td><strong>${l.name}</strong>${l.description ? html`<div class="muted small">${l.description}</div>` : ''}</td>
                    <td>${l.is_public ? html`<span class="badge badge-info">Öffentlich</span>` : html`<span class="badge badge-muted">Intern</span>`}</td>
                    <td class="right num">${fmtNum(l.active_count)}</td>
                    <td class="right num">${fmtNum(l.total_count)}</td>
                    <td class="right nowrap">
                      <a class="btn btn-sm" href="#/subscribers?list=${l.id}">Abonnenten</a>
                      <button class="btn btn-sm" data-edit="${l.id}">Bearbeiten</button>
                      <button class="btn btn-sm btn-ghost" data-del="${l.id}" aria-label="Löschen">🗑</button>
                    </td>
                  </tr>`,
                )
              : html`<tr><td colspan="5" class="empty">Noch keine Listen angelegt.</td></tr>`
          }</tbody>
        </table></div>
      </div>`,
  );

  const reload = () => listsView(el);
  $('#add-btn', el).addEventListener('click', () => listDialog(null, reload));
  el.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => listDialog(lists.find((l) => l.id === Number(b.dataset.edit)), reload)),
  );
  el.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const list = lists.find((l) => l.id === Number(b.dataset.del));
      if (!(await confirmDialog('Liste löschen', `Liste „${list.name}“ löschen? Die Abonnenten bleiben erhalten.`, { submitLabel: 'Löschen' }))) return;
      try {
        await del(`/lists/${list.id}`);
        ctx.invalidateLists();
        toast('Liste gelöscht');
        reload();
      } catch (err) {
        toastError(err);
      }
    }),
  );
  $('#embed-btn', el).addEventListener('click', () => {
    const code = embedCode(lists);
    modal({
      title: 'Anmeldeformular einbetten',
      wide: true,
      cancelLabel: 'Schließen',
      body: html`
        <p>Gehostete Anmeldeseite: <a href="/subscribe" target="_blank" rel="noopener">${location.origin}/subscribe</a></p>
        <p>HTML-Formular für deine Website (Abonnenten landen in allen bzw. den ausgewählten öffentlichen Listen):</p>
        <textarea class="code" readonly style="min-height:240px" id="embed-code">${code}</textarea>
        <p class="muted small" style="margin-top:12px">Per JavaScript/API: <code>POST ${location.origin}/api/public/subscribe</code> mit JSON
        <code>{"email": "…", "first_name": "…", "list_ids": [1]}</code> (CORS aktiviert).</p>
        <button type="button" class="btn btn-sm" id="copy-embed">In Zwischenablage kopieren</button>`,
      onOpen: (dialog) => {
        $('#copy-embed', dialog).addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(code);
            toast('Kopiert');
          } catch {
            $('#embed-code', dialog).select();
          }
        });
      },
    });
  });
}
