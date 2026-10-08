// Stellt ein Backup wieder her:  npm run restore -- data/backups/backup-20261008-120000.zip
// Der Server muss dabei gestoppt sein. Die bisherige Datenbank und die Uploads werden
// vorher mit dem Zusatz „.vor-wiederherstellung“ gesichert.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { readZip } from '../lib/zip.js';

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error('Aufruf: npm run restore -- <backup.zip>');
  process.exit(1);
}

const config = loadConfig();
const entries = readZip(fs.readFileSync(file));
const manifest = entries.find((e) => e.name === 'backup.json');
const database = entries.find((e) => e.name === 'database.db');
if (!manifest || !database) {
  console.error('Das Archiv ist kein Backup dieses CMS (backup.json oder database.db fehlt).');
  process.exit(1);
}
const info = JSON.parse(manifest.data.toString('utf8'));
console.log(`Backup vom ${info.created_at} mit ${entries.length - 2} Upload-Dateien`);

const stamp = '.vor-wiederherstellung';
for (const suffix of ['', '-wal', '-shm']) {
  const current = config.databasePath + suffix;
  if (fs.existsSync(current)) fs.renameSync(current, current + stamp);
}
fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
fs.writeFileSync(config.databasePath, database.data);

if (fs.existsSync(config.uploadsDir)) {
  fs.rmSync(config.uploadsDir + stamp, { recursive: true, force: true });
  fs.renameSync(config.uploadsDir, config.uploadsDir + stamp);
}
const uploadsRoot = path.resolve(config.uploadsDir);
for (const entry of entries.filter((e) => e.name.startsWith('uploads/'))) {
  const target = path.resolve(uploadsRoot, entry.name.slice('uploads/'.length));
  // Schutz vor Pfaden außerhalb des Upload-Ordners
  if (!target.startsWith(uploadsRoot + path.sep)) {
    console.warn(`Übersprungen (ungültiger Pfad): ${entry.name}`);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, entry.data);
}

console.log(`Wiederhergestellt nach ${config.databasePath} und ${config.uploadsDir}.`);
console.log(`Der vorherige Stand liegt unter *${stamp}. Server jetzt wieder starten.`);
