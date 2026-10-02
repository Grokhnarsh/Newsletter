import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations.js';

/**
 * Dünner Wrapper um node:sqlite mit Hilfsfunktionen für Abfragen und
 * Transaktionen. Prepared Statements werden pro SQL-String gecacht.
 */
export class Database {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.cache = new Map();
    this.depth = 0;
  }

  prepare(sql) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  /** Führt `fn` in einer (ggf. verschachtelten) Transaktion aus. */
  transaction(fn) {
    const savepoint = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw err;
    }
  }

  migrate() {
    this.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.all('SELECT version FROM schema_migrations').map((r) => r.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.exec(migration.sql);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', migration.version, new Date().toISOString());
      });
    }
  }

  close() {
    this.raw.close();
  }
}

export function openDatabase(file) {
  const db = new Database(file);
  db.migrate();
  return db;
}
