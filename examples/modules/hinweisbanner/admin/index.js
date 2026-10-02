// Admin-Skript des Beispielmoduls. Gemeinsame Hilfen liegen unter /admin/js/.
import { saveSettings } from '/admin/js/settings.js';
import { ctx } from '/admin/js/state.js';
import { $, formData, html, setHtml, toastError } from '/admin/js/ui.js';

async function bannerTab(box) {
  const s = await ctx.getSettings(true);
  setHtml(
    box,
    html`<form class="card" id="banner-form">
      <h2>Hinweisbanner</h2>
      <div class="field"><label for="hb-text">Text</label><input id="hb-text" name="banner_text" type="text" value="${s.banner_text}" placeholder="Leer lassen, um das Banner auszublenden"></div>
      <div class="inline-fields">
        <div class="field"><label for="hb-url">Link (optional)</label><input id="hb-url" name="banner_link_url" type="text" value="${s.banner_link_url}" placeholder="/aktion oder https://…"></div>
        <div class="field"><label for="hb-label">Linktext</label><input id="hb-label" name="banner_link_label" type="text" value="${s.banner_link_label}"></div>
      </div>
      <button class="btn btn-primary" type="submit">Speichern</button>
    </form>`,
  );
  $('#banner-form', box).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveSettings(formData(e.target));
    } catch (err) {
      toastError(err);
    }
  });
}

export default function register(cms) {
  cms.settingsTab({ id: 'hinweisbanner', label: 'Hinweisbanner', order: 60, adminOnly: true, render: bannerTab });
  cms.widget({
    id: 'hinweisbanner',
    size: 'tile',
    order: 40,
    render(el, data) {
      setHtml(el, html`<div class="label">Banner-Klicks</div><div class="value">${data.hinweisbanner?.clicks ?? 0}</div><div class="hint"><a href="#/settings/hinweisbanner">Banner bearbeiten</a></div>`);
    },
  });
}
