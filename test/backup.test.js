import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { readZip, ZipWriter } from '../src/lib/zip.js';
import { startTestServer } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

describe('ZIP', () => {
  test('Schreiben und Lesen (gepackt und ungepackt, UTF-8-Namen)', async () => {
    const chunks = [];
    const stream = new (await import('node:stream')).Writable({
      write(chunk, enc, cb) {
        chunks.push(chunk);
        cb();
      },
    });
    const zip = new ZipWriter(stream);
    await zip.addBuffer('text/ä.txt', Buffer.from('Hallo '.repeat(100)));
    await zip.addBuffer('bild.png', PNG);
    await zip.finish();
    const entries = readZip(Buffer.concat(chunks));
    assert.deepEqual(entries.map((e) => e.name), ['text/ä.txt', 'bild.png']);
    assert.equal(entries[0].data.toString(), 'Hallo '.repeat(100));
    assert.deepEqual(entries[1].data, PNG);
  });
});

describe('Backups', () => {
  let t;
  let tmp;
  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-backup-test-'));
    t = await startTestServer({ uploadsDir: path.join(tmp, 'uploads') });
    t.services.config.backupsDir = path.join(tmp, 'backups');
    t.services.backups.dir = path.join(tmp, 'backups');
    await t.setupAdmin();
    await t.request('POST', '/api/media', { raw: PNG, headers: { 'Content-Type': 'image/png', 'X-Filename': 'logo.png' } });
    await t.post('/api/pages', { title: 'Gesicherte Seite', status: 'published' });
  });
  after(async () => {
    await t.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('Download enthält Datenbank-Snapshot, Uploads und Manifest', async () => {
    const res = await fetch(`${t.base}/api/system/backup`, { headers: { Authorization: `Bearer ${(await t.post('/api/auth/login', { email: 'admin@example.com', password: 'sehrgeheim123' }, { auth: false })).data.token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    const entries = readZip(Buffer.from(await res.arrayBuffer()));
    const names = entries.map((e) => e.name);
    assert.ok(names.includes('backup.json'));
    assert.ok(names.includes('database.db'));
    assert.ok(names.some((n) => /^uploads\/\d{4}\/\d{2}\/logo-[0-9a-f]+\.png$/.test(n)));

    const dbFile = path.join(tmp, 'snapshot.db');
    fs.writeFileSync(dbFile, entries.find((e) => e.name === 'database.db').data);
    const db = new DatabaseSync(dbFile);
    assert.equal(db.prepare("SELECT title FROM pages WHERE slug = 'gesicherte-seite'").get().title, 'Gesicherte Seite');
    db.close();
  });

  test('Backups auf dem Server: anlegen, auflisten, aufräumen, löschen', async () => {
    await t.put('/api/settings', { backup_keep: 2 });
    for (let i = 0; i < 3; i++) {
      const b = await t.post('/api/system/backups');
      assert.equal(b.status, 201);
      await new Promise((r) => setTimeout(r, 1100)); // Dateinamen enthalten Sekunden
    }
    const list = (await t.get('/api/system/backups')).data;
    assert.equal(list.length, 2, 'nur die neuesten werden aufbewahrt');
    const dl = await t.get(`/api/system/backups/${list[0].name}`);
    assert.equal(dl.status, 200);
    assert.equal((await t.get('/api/system/backups/..%2F..%2Fetc%2Fpasswd')).status, 404);
    assert.equal((await t.del(`/api/system/backups/${list[1].name}`)).status, 204);
    assert.equal((await t.get('/api/system/backups')).data.length, 1);
  });

  test('Wiederherstellung per Skript', async () => {
    const [latest] = (await t.get('/api/system/backups')).data;
    const restoreDir = path.join(tmp, 'restore');
    const env = { ...process.env, DATABASE_PATH: path.join(restoreDir, 'cms.db'), UPLOADS_DIR: path.join(restoreDir, 'uploads') };
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/tools/restore.js', path.join(tmp, 'backups', latest.name)], { env, encoding: 'utf8' });
    assert.match(out, /Wiederhergestellt/);
    const db = new DatabaseSync(env.DATABASE_PATH);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media').get().n, 1);
    db.close();
    const uploads = fs.readdirSync(env.UPLOADS_DIR, { recursive: true }).filter((f) => f.endsWith('.png'));
    assert.equal(uploads.length, 1);
  });

  test('nur für Administratoren', async () => {
    await t.post('/api/users', { email: 'red@example.com', password: 'redakteur123', role: 'editor' });
    const login = await t.post('/api/auth/login', { email: 'red@example.com', password: 'redakteur123' }, { auth: false });
    assert.equal((await t.get('/api/system/backup', { headers: { Authorization: `Bearer ${login.data.token}` } })).status, 403);
  });
});
