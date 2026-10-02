import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Router } from 'express';
import { badRequest, notFound } from '../lib/errors.js';

/**
 * Verwaltet die Module des CMS: Laden, Abhängigkeiten, Migrationen,
 * Aktivierung/Deaktivierung und Lebenszyklus.
 *
 * Ein Modul ist ein Objekt (Default-Export von `index.js`) mit:
 *   name, label, description, version
 *   requires        – Namen anderer Module, die aktiv sein müssen
 *   core            – true: kann nicht deaktiviert werden
 *   defaultEnabled  – Standardzustand (true, wenn nicht angegeben)
 *   migrations      – [{ version, sql }]
 *   settings        – { defaults, rules }
 *   setup(ctx)      – Services, Hooks und Shortcodes registrieren
 *   api(router, ctx)            – authentifizierte Routen unter /api
 *   publicRoutes(router, ctx)   – öffentliche Routen
 *   fallbackRoutes(router, ctx) – öffentliche Routen nach allen anderen (z. B. Seiten-Slugs)
 *   adminDir        – Ordner mit Admin-Skripten (wird unter /admin/modules/<name>/ ausgeliefert)
 *   adminEntry      – Einstiegsdatei im adminDir (Standard: index.js)
 *   start(ctx) / stop(ctx)
 */
export class ModuleManager {
  constructor({ settings, logger = console }) {
    this.settings = settings;
    this.logger = logger;
    this.modules = new Map();
    this.order = [];
  }

  add(mod) {
    if (!mod?.name || !/^[a-z][a-z0-9_-]*$/.test(mod.name)) throw new Error(`Ungültiger Modulname: ${mod?.name}`);
    if (this.modules.has(mod.name)) throw new Error(`Modul ${mod.name} ist doppelt vorhanden`);
    this.modules.set(mod.name, { requires: [], defaultEnabled: true, migrations: [], ...mod });
  }

  /** Lädt zusätzliche Module aus einem Verzeichnis (je Unterordner eine index.js). */
  async loadDirectory(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name, 'index.js');
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      const mod = (await import(pathToFileURL(file).href)).default;
      if (mod) {
        mod.adminDir ??= fs.existsSync(path.join(dir, entry.name, 'admin')) ? path.join(dir, entry.name, 'admin') : undefined;
        this.add(mod);
      }
    }
  }

  /** Topologische Sortierung nach Abhängigkeiten; Module mit fehlenden Abhängigkeiten werden entfernt. */
  resolve() {
    const order = [];
    const state = new Map();
    const visit = (name, chain = []) => {
      if (state.get(name) === 'done') return true;
      if (state.get(name) === 'visiting') throw new Error(`Zirkuläre Modulabhängigkeit: ${[...chain, name].join(' → ')}`);
      const mod = this.modules.get(name);
      if (!mod) return false;
      state.set(name, 'visiting');
      for (const dep of mod.requires) {
        if (!visit(dep, [...chain, name])) {
          this.logger.warn(`[module] ${name} benötigt ${dep}, das nicht vorhanden ist – Modul wird nicht geladen`);
          this.modules.delete(name);
          state.set(name, 'done');
          return false;
        }
      }
      state.set(name, 'done');
      order.push(name);
      return true;
    };
    for (const name of [...this.modules.keys()]) visit(name);
    this.order = order.filter((n) => this.modules.has(n));
  }

  get(name) {
    return this.modules.get(name);
  }

  list() {
    return this.order.map((n) => this.modules.get(n));
  }

  enabledMap() {
    return this.settings.getInternal('modules', {});
  }

  /** Aktiv, wenn eingeschaltet und alle Abhängigkeiten aktiv sind. */
  isEnabled(name) {
    if (name === 'core') return true;
    const mod = this.modules.get(name);
    if (!mod) return false;
    if (mod.core) return true;
    const stored = this.enabledMap()[name];
    const on = stored === undefined ? mod.defaultEnabled !== false : stored;
    return on && mod.requires.every((dep) => this.isEnabled(dep));
  }

  setEnabled(name, enabled) {
    const mod = this.modules.get(name);
    if (!mod) throw notFound('Modul nicht gefunden');
    if (mod.core && !enabled) throw badRequest('Kernmodule können nicht deaktiviert werden');
    if (!enabled) {
      const dependents = this.list().filter((m) => m.requires.includes(name) && this.isEnabled(m.name));
      if (dependents.length) throw badRequest(`Wird benötigt von: ${dependents.map((m) => m.label || m.name).join(', ')}`);
    } else {
      const missing = mod.requires.filter((dep) => !this.isEnabled(dep));
      if (missing.length) throw badRequest(`Bitte zuerst aktivieren: ${missing.join(', ')}`);
    }
    this.settings.setInternal('modules', { ...this.enabledMap(), [name]: Boolean(enabled) });
  }

  describe() {
    return this.list().map((m) => ({
      name: m.name,
      label: m.label || m.name,
      description: m.description || '',
      version: m.version || '1.0.0',
      requires: m.requires,
      core: Boolean(m.core),
      enabled: this.isEnabled(m.name),
      admin_entry: m.adminDir ? `/admin/modules/${m.name}/${m.adminEntry || 'index.js'}` : null,
    }));
  }

  migrate(db) {
    for (const mod of this.list()) if (mod.migrations.length) db.migrate(mod.migrations, mod.name);
  }

  registerSettings() {
    for (const mod of this.list()) if (mod.settings) this.settings.register(mod.name, mod.settings.defaults || {}, mod.settings.rules || {});
  }

  setup(ctx) {
    for (const mod of this.list()) mod.setup?.(ctx);
  }

  /** Router, der nur antwortet, solange das Modul aktiv ist. */
  guardedRouter(name) {
    const router = Router();
    router.use((req, res, next) => (this.isEnabled(name) ? next() : next('router')));
    return router;
  }

  mount(kind, ctx) {
    const routers = [];
    for (const mod of this.list()) {
      if (typeof mod[kind] !== 'function') continue;
      const router = this.guardedRouter(mod.name);
      mod[kind](router, ctx);
      routers.push(router);
    }
    return routers;
  }

  async start(ctx) {
    for (const mod of this.list()) await mod.start?.(ctx);
  }

  async stop(ctx) {
    for (const mod of [...this.list()].reverse()) await mod.stop?.(ctx);
  }
}
