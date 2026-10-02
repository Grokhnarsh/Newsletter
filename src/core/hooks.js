/**
 * Hook-System für die Kommunikation zwischen Modulen.
 *
 *  - Ereignisse (`emit`): asynchron, Fehler einzelner Handler werden protokolliert
 *  - Filter (`filter`): synchron, jeder Handler verändert einen Wert
 *  - Sammler (`collect`): synchron, sammelt Ergebnisse aller Handler in einer Liste
 *  - `first`: synchron, liefert das erste Ergebnis ≠ undefined
 *
 * Handler von deaktivierten Modulen werden übersprungen.
 */
export class HookBus {
  constructor({ isEnabled = () => true, logger = console } = {}) {
    this.handlers = new Map();
    this.isEnabled = isEnabled;
    this.logger = logger;
  }

  on(name, fn, { module = 'core', priority = 10 } = {}) {
    const list = this.handlers.get(name) || [];
    list.push({ fn, module, priority });
    list.sort((a, b) => a.priority - b.priority);
    this.handlers.set(name, list);
    return () => this.handlers.set(name, (this.handlers.get(name) || []).filter((h) => h.fn !== fn));
  }

  active(name) {
    return (this.handlers.get(name) || []).filter((h) => this.isEnabled(h.module));
  }

  async emit(name, ...args) {
    for (const h of this.active(name)) {
      try {
        await h.fn(...args);
      } catch (err) {
        this.logger.error(`[hook ${name} / ${h.module}]`, err);
      }
    }
  }

  filter(name, value, ...args) {
    let out = value;
    for (const h of this.active(name)) out = h.fn(out, ...args);
    return out;
  }

  collect(name, ...args) {
    const results = [];
    for (const h of this.active(name)) {
      const r = h.fn(...args);
      if (Array.isArray(r)) results.push(...r);
      else if (r !== undefined && r !== null) results.push(r);
    }
    return results;
  }

  first(name, ...args) {
    for (const h of this.active(name)) {
      const r = h.fn(...args);
      if (r !== undefined) return r;
    }
    return undefined;
  }
}
