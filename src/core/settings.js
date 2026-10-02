/**
 * Schlüssel-Wert-Einstellungen. Module registrieren ihre Standardwerte und
 * Validierungsregeln über `register()`; gespeichert wird JSON pro Schlüssel.
 */
export class SettingsService {
  constructor(db) {
    this.db = db;
    this.defaults = {};
    this.rules = {};
    this.owners = {};
  }

  register(module, defaults, rules = {}) {
    for (const key of Object.keys(defaults)) {
      this.defaults[key] = defaults[key];
      this.owners[key] = module;
      if (rules[key]) this.rules[key] = rules[key];
    }
  }

  all() {
    const stored = Object.fromEntries(this.db.all('SELECT key, value FROM settings').map((r) => [r.key, JSON.parse(r.value)]));
    const out = { ...this.defaults };
    for (const [k, v] of Object.entries(stored)) if (k in this.defaults) out[k] = v;
    return out;
  }

  get(key) {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? JSON.parse(row.value) : this.defaults[key];
  }

  /** Speichert Werte; unbekannte Schlüssel werden ignoriert. */
  update(values) {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (!(key in this.defaults)) continue;
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          JSON.stringify(value),
        );
      }
    });
    return this.all();
  }

  /** Interner Zustand, der nicht über die Einstellungs-API änderbar ist. */
  getInternal(key, fallback = null) {
    const row = this.db.get('SELECT value FROM settings WHERE key = ?', `_${key}`);
    return row ? JSON.parse(row.value) : fallback;
  }

  setInternal(key, value) {
    this.db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      `_${key}`,
      JSON.stringify(value),
    );
  }
}
