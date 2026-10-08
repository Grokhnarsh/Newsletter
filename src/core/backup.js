import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notFound } from '../lib/errors.js';
import { randomToken } from '../lib/security.js';
import { ZipWriter } from '../lib/zip.js';

export const BACKUP_SETTINGS = {
  defaults: { backup_interval_hours: 0, backup_keep: 7 },
  rules: {
    backup_interval_hours: { type: 'int', min: 0, max: 720 },
    backup_keep: { type: 'int', min: 1, max: 100 },
  },
};

const NAME_RE = /^backup-\d{8}-\d{6}\.zip$/;

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push({ full, rel: path.relative(base, full) });
  }
  return out;
}

/**
 * Backups als ZIP: konsistenter Datenbank-Snapshot (VACUUM INTO) plus alle Uploads.
 * Optional automatisch in festem Abstand, ältere Sicherungen werden aufgeräumt.
 */
export class BackupService {
  constructor({ db, config, settings, modules, logger = console }) {
    Object.assign(this, { db, config, settings, modules, logger });
    this.dir = config.backupsDir;
    this.timer = null;
    this.running = false;
  }

  /** Schreibt ein vollständiges Backup in den Stream. */
  async write(stream) {
    const snapshot = path.join(os.tmpdir(), `cms-snapshot-${process.pid}-${randomToken(6)}.db`);
    try {
      this.db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      const zip = new ZipWriter(stream);
      const manifest = {
        created_at: new Date().toISOString(),
        app: 'modular-cms',
        modules: this.modules.describe().map(({ name, version, enabled }) => ({ name, version, enabled })),
      };
      await zip.addBuffer('backup.json', Buffer.from(JSON.stringify(manifest, null, 2)));
      await zip.addFile('database.db', snapshot);
      for (const file of walk(this.config.uploadsDir)) await zip.addFile(`uploads/${file.rel}`, file.full);
      await zip.finish();
    } finally {
      fs.rmSync(snapshot, { force: true });
    }
  }

  fileName(date = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `backup-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.zip`;
  }

  /** Legt ein Backup im Backup-Ordner an und räumt alte auf. */
  async createFile() {
    fs.mkdirSync(this.dir, { recursive: true });
    const name = this.fileName();
    const target = path.join(this.dir, name);
    const tmp = `${target}.part`;
    const stream = fs.createWriteStream(tmp);
    try {
      await this.write(stream);
      await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
      fs.renameSync(tmp, target);
    } catch (err) {
      stream.destroy();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    this.prune();
    return this.list().find((b) => b.name === name);
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((n) => NAME_RE.test(n))
      .map((name) => {
        const stat = fs.statSync(path.join(this.dir, name));
        return { name, size: stat.size, created_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  pathFor(name) {
    if (!NAME_RE.test(name)) throw notFound('Backup nicht gefunden');
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) throw notFound('Backup nicht gefunden');
    return file;
  }

  remove(name) {
    fs.rmSync(this.pathFor(name));
  }

  prune() {
    const keep = this.settings.get('backup_keep');
    for (const b of this.list().slice(keep)) fs.rmSync(path.join(this.dir, b.name), { force: true });
  }

  /** Prüft stündlich, ob ein automatisches Backup fällig ist. */
  start(intervalMs = 3600_000) {
    if (this.timer) return;
    const check = async () => {
      const hours = this.settings.get('backup_interval_hours');
      if (!hours || this.running) return;
      const last = this.list()[0];
      if (last && Date.now() - new Date(last.created_at).getTime() < hours * 3600_000 - 60_000) return;
      this.running = true;
      try {
        const b = await this.createFile();
        this.logger.log(`[backup] ${b.name} erstellt`);
      } catch (err) {
        this.logger.error('[backup] fehlgeschlagen:', err.message);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(check, intervalMs);
    this.timer.unref?.();
    setTimeout(check, 30_000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
