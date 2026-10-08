/**
 * Erweiterungspunkte der Admin-Oberfläche. Jedes Modul mit Admin-Skript
 * exportiert `default function register(cms)` und meldet darüber an:
 *
 *   cms.nav({ href, label, icon, group, order })
 *   cms.route(/^\/pfad\/(\d+)$/, (el, ...params) => cleanup?)
 *   cms.widget({ id, order, render(el, dashboardData) })
 *   cms.settingsTab({ id, label, order, adminOnly, render(el) })
 *   cms.provide('mediaPicker', fn)  /  cms.use('mediaPicker')
 */
export const registry = {
  modules: [],
  nav: [],
  routes: [],
  widgets: [],
  settingsTabs: [],
  services: {},
};

export const ICONS = {
  dashboard: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  subscribers: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  lists: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  campaigns: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  templates: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  pages: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  blog: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  media: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  menus: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  redirects: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  forms: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  stats: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  segments: '<circle cx="12" cy="12" r="10"/><path d="M12 2v10l7 7"/>',
  automations: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  modules: '<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  site: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
};

export const cms = {
  nav(item) {
    registry.nav.push({ group: 'Inhalte', order: 50, ...item });
  },
  route(pattern, view) {
    registry.routes.push([pattern, view]);
  },
  widget(widget) {
    registry.widgets.push({ order: 50, ...widget });
  },
  settingsTab(tab) {
    registry.settingsTabs.push({ order: 50, ...tab });
  },
  provide(name, fn) {
    registry.services[name] = fn;
  },
  use(name) {
    return registry.services[name];
  },
  isEnabled(name) {
    return registry.modules.some((m) => m.name === name && m.enabled);
  },
  get modules() {
    return registry.modules;
  },
};

export function resetRegistry() {
  for (const key of ['nav', 'routes', 'widgets', 'settingsTabs']) registry[key].length = 0;
  registry.services = {};
}
