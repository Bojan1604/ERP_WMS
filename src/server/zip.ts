import 'server-only';
import { deflateRawSync } from 'node:zlib';
import { DomainError } from './errors';

/**
 * Mali ZIP bez vanjskih ovisnosti (PKZIP 2.0, bez ZIP64): svaka datoteka se
 * sažima (deflate) ili sprema ako sažimanje ne pomaže. Nazivi su UTF-8
 * (zastavica 11), očišćeni od opasnih znakova i putanja („..", apsolutne),
 * a duplikati dobivaju sufiks „ (2)". Ukupna veličina je ograničena.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Jedan dio putanje: bez upravljačkih i zabranjenih znakova (Windows), bez vodećih/pratećih točaka i razmaka. */
function safeSegment(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 120)
  );
}

/** Siguran relativni naziv u arhivi: kose crte kao razdjelnik, bez „..", praznih i apsolutnih dijelova. */
export function safeZipPath(name: string): string {
  const parts = name
    .replace(/\\/g, '/')
    .split('/')
    .map(safeSegment)
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.join('/') || 'datoteka';
}

/** Naziv koji još nije zauzet u skupu (bez obzira na velika/mala slova): „a.pdf" → „a (2).pdf". */
export function uniqueName(taken: Set<string>, name: string): string {
  let out = name;
  const dot = name.lastIndexOf('.');
  const slash = name.lastIndexOf('/');
  const [base, ext] = dot > slash + 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${base} (${i})${ext}`;
  taken.add(out.toLowerCase());
  return out;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export class ZipTooLargeError extends DomainError {}

interface Entry {
  name: Buffer;
  crc: number;
  method: 0 | 8;
  size: number;
  data: Buffer; // već sažeto ili spremljeno
  offset: number;
  time: number;
  date: number;
}

export const ZIP_MAX_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 65_000;

export class ZipWriter {
  private entries: Entry[] = [];
  private names = new Set<string>();
  private offset = 0;

  constructor(private readonly maxBytes = ZIP_MAX_BYTES) {}

  /** Trenutna veličina arhive (bez središnjeg imenika). */
  get size() {
    return this.offset;
  }

  /** Dodaje datoteku; vraća stvarni naziv u arhivi (očišćen i jedinstven). */
  add(name: string, content: Uint8Array | string, when = new Date()): string {
    if (this.entries.length >= MAX_ENTRIES) throw new ZipTooLargeError('Previše datoteka za jednu arhivu — označite manje dokumenata.');
    const path = uniqueName(this.names, safeZipPath(name));
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    const deflated = raw.length > 64 ? deflateRawSync(raw, { level: 6 }) : null;
    const [method, data] = deflated && deflated.length < raw.length ? ([8, deflated] as const) : ([0, raw] as const);
    const nameBuf = Buffer.from(path, 'utf8');
    const growth = 30 + nameBuf.length + data.length + 46 + nameBuf.length;
    if (this.offset + growth > this.maxBytes) {
      throw new ZipTooLargeError(`Arhiva bi bila veća od ${Math.round(this.maxBytes / 1024 / 1024)} MB — označite manje dokumenata.`);
    }
    const { time, date } = dosDateTime(when);
    this.entries.push({ name: nameBuf, crc: crc32(raw), method, size: raw.length, data, offset: this.offset, time, date });
    this.offset += 30 + nameBuf.length + data.length;
    return path;
  }

  /** Cijela arhiva kao jedan međuspremnik. */
  toBuffer(): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    for (const e of this.entries) {
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0);
      h.writeUInt16LE(20, 4); // potrebna verzija 2.0
      h.writeUInt16LE(0x0800, 6); // UTF-8 nazivi
      h.writeUInt16LE(e.method, 8);
      h.writeUInt16LE(e.time, 10);
      h.writeUInt16LE(e.date, 12);
      h.writeUInt32LE(e.crc, 14);
      h.writeUInt32LE(e.data.length, 18);
      h.writeUInt32LE(e.size, 22);
      h.writeUInt16LE(e.name.length, 26);
      h.writeUInt16LE(0, 28);
      chunks.push(h, e.name, e.data);

      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.data.length, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      // dodatno polje, komentar, disk, interni i vanjski atributi = 0
      c.writeUInt32LE(e.offset, 42);
      central.push(c, e.name);
    }
    const cd = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...chunks, cd, end]);
  }
}
