import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { badRequest, notFound } from '../../lib/errors.js';
import { now } from '../../lib/time.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const LOCATIONS = { main: 'Hauptmenü', footer: 'Fußzeile' };
const TYPES = ['custom', 'page', 'blog', 'home'];

export class MenuService {
  constructor({ db, hooks }) {
    this.db = db;
    this.hooks = hooks;
  }

  list() {
    return Object.entries(LOCATIONS).map(([location, label]) => ({ location, label, items: this.items(location) }));
  }

  menuId(location) {
    if (!LOCATIONS[location]) throw notFound('Unbekannter Menübereich');
    let row = this.db.get('SELECT id FROM menus WHERE location = ?', location);
    if (!row) {
      const { lastInsertRowid } = this.db.run('INSERT INTO menus (location, name, updated_at) VALUES (?, ?, ?)', location, LOCATIONS[location], now());
      row = { id: lastInsertRowid };
    }
    return row.id;
  }

  /** Einträge als Baum (eine Unterebene). */
  items(location) {
    const rows = this.db.all(
      'SELECT i.* FROM menu_items i JOIN menus m ON m.id = i.menu_id WHERE m.location = ? ORDER BY i.position, i.id',
      location,
    );
    const top = rows.filter((r) => !r.parent_id).map((r) => ({ ...r, new_tab: Boolean(r.new_tab), children: [] }));
    for (const r of rows.filter((x) => x.parent_id)) top.find((t) => t.id === r.parent_id)?.children.push({ ...r, new_tab: Boolean(r.new_tab) });
    return top;
  }

  /** Ersetzt alle Einträge eines Menüs. */
  replace(location, items) {
    if (!Array.isArray(items)) throw badRequest('items muss eine Liste sein');
    const menuId = this.menuId(location);
    const clean = (item, depth) => {
      const type = TYPES.includes(item.type) ? item.type : 'custom';
      const label = String(item.label ?? '').trim().slice(0, 100);
      if (!label) throw badRequest('Jeder Menüeintrag braucht eine Beschriftung');
      const url = String(item.url ?? '').trim().slice(0, 500);
      if (type === 'custom' && !/^(https?:\/\/|\/|#|mailto:|tel:)/i.test(url)) throw badRequest(`Ungültige URL bei „${label}“`);
      return {
        type,
        label,
        url: type === 'custom' ? url : '',
        target_id: type === 'page' ? Number(item.target_id) || null : null,
        new_tab: item.new_tab ? 1 : 0,
        children: depth === 0 && Array.isArray(item.children) ? item.children.map((c) => clean(c, 1)) : [],
      };
    };
    const tree = items.map((i) => clean(i, 0));
    this.db.transaction(() => {
      this.db.run('DELETE FROM menu_items WHERE menu_id = ?', menuId);
      const insert = (item, parentId, position) =>
        this.db.run(
          'INSERT INTO menu_items (menu_id, parent_id, label, type, target_id, url, new_tab, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          menuId, parentId, item.label, item.type, item.target_id, item.url, item.new_tab, position,
        ).lastInsertRowid;
      tree.forEach((item, i) => {
        const id = insert(item, null, i);
        item.children.forEach((child, j) => insert(child, id, j));
      });
      this.db.run('UPDATE menus SET updated_at = ? WHERE id = ?', now(), menuId);
    });
    return this.items(location);
  }

  /** Aufgelöste Einträge für das Theme; nicht (mehr) verfügbare Ziele entfallen. */
  resolved(location) {
    const resolve = (item) => {
      let url = item.url;
      if (item.type === 'home') url = '/';
      else if (item.type !== 'custom') url = this.hooks.first('menus.resolve', item);
      if (!url) return null;
      return { label: item.label, url, new_tab: item.new_tab, children: (item.children || []).map(resolve).filter(Boolean) };
    };
    return this.items(location).map(resolve).filter(Boolean);
  }
}

export default {
  name: 'menus',
  label: 'Menüs',
  description: 'Navigation für Kopf- und Fußbereich der Website, mit Verweisen auf Seiten, Blog und eigene Links.',
  version: '1.0.0',
  adminDir: path.join(dir, 'admin'),
  migrations: [
    {
      version: 1,
      sql: `
        CREATE TABLE menus (
          id INTEGER PRIMARY KEY,
          location TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE menu_items (
          id INTEGER PRIMARY KEY,
          menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
          parent_id INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
          label TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'custom',
          target_id INTEGER,
          url TEXT NOT NULL DEFAULT '',
          new_tab INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0
        );
      `,
    },
  ],

  setup(ctx) {
    ctx.menus = new MenuService(ctx);
    const opts = { module: 'menus' };
    ctx.hooks.on('site.menu', (location) => (LOCATIONS[location] ? ctx.menus.resolved(location) : undefined), opts);
    ctx.hooks.on(
      'system.setup',
      () => {
        if (ctx.menus.items('main').length) return;
        const items = [{ type: 'home', label: 'Start' }];
        const about = ctx.modules.isEnabled('pages') && ctx.db.get("SELECT id FROM pages WHERE slug = 'ueber-uns' AND parent_id IS NULL");
        if (about) items.push({ type: 'page', label: 'Über uns', target_id: about.id });
        if (ctx.modules.isEnabled('blog')) items.push({ type: 'blog', label: 'Blog' });
        if (ctx.modules.isEnabled('newsletter')) items.push({ type: 'custom', label: 'Newsletter', url: '/subscribe' });
        ctx.menus.replace('main', items);
        const footer = [];
        for (const slug of ['impressum', 'datenschutz']) {
          const page = ctx.modules.isEnabled('pages') && ctx.db.get('SELECT id, title FROM pages WHERE slug = ? AND parent_id IS NULL', slug);
          if (page) footer.push({ type: 'page', label: page.title, target_id: page.id });
        }
        ctx.menus.replace('footer', footer);
      },
      { ...opts, priority: 50 },
    );
  },

  api(router, ctx) {
    const r = Router();
    r.get('/', (req, res) => res.json(ctx.menus.list()));
    r.put('/:location', (req, res) => res.json(ctx.menus.replace(req.params.location, req.body?.items)));
    router.use('/menus', r);
  },
};
