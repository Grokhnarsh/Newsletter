import fs from 'node:fs';
import zlib from 'node:zlib';

// Schlanker ZIP-Schreiber/-Leser (Deflate, UTF-8-Namen) für Backups – ohne Zusatzpakete.

function dosDateTime(date) {
  const d = new Date(date);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: day };
}

/** Schreibt Einträge nacheinander in einen beschreibbaren Stream. */
export class ZipWriter {
  constructor(stream) {
    this.stream = stream;
    this.offset = 0;
    this.entries = [];
  }

  write(buf) {
    this.offset += buf.length;
    return new Promise((resolve, reject) => {
      if (this.stream.write(buf)) return resolve();
      const onDrain = () => {
        this.stream.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        this.stream.off('drain', onDrain);
        reject(err);
      };
      this.stream.once('drain', onDrain);
      this.stream.once('error', onError);
    });
  }

  async addBuffer(name, data, mtime = new Date()) {
    if (this.entries.length >= 65535) throw new Error('Zu viele Dateien für ein ZIP-Archiv');
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data);
    const store = deflated.length >= data.length;
    const body = store ? data : deflated;
    if (body.length >= 0xffffffff || data.length >= 0xffffffff) throw new Error(`Datei zu groß für das Backup: ${name}`);
    const { time, date } = dosDateTime(mtime);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(store ? 0 : 8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    this.entries.push({ nameBuf, crc, csize: body.length, usize: data.length, method: store ? 0 : 8, time, date, offset: this.offset });
    await this.write(header);
    await this.write(nameBuf);
    await this.write(body);
  }

  async addFile(name, file) {
    const stat = fs.statSync(file);
    await this.addBuffer(name, fs.readFileSync(file), stat.mtime);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(e.method, 10);
      cd.writeUInt16LE(e.time, 12);
      cd.writeUInt16LE(e.date, 14);
      cd.writeUInt32LE(e.crc, 16);
      cd.writeUInt32LE(e.csize, 20);
      cd.writeUInt32LE(e.usize, 24);
      cd.writeUInt16LE(e.nameBuf.length, 28);
      cd.writeUInt32LE(e.offset, 42);
      await this.write(cd);
      await this.write(e.nameBuf);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
  }
}

/** Liest alle Einträge eines ZIP-Archivs (Buffer) – für die Wiederherstellung. */
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Keine gültige ZIP-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Beschädigtes ZIP-Verzeichnis');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if ((zlib.crc32(data) >>> 0) !== crc) throw new Error(`Prüfsumme falsch: ${name}`);
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
