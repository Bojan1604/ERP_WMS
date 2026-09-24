/**
 * Čitanje osnovnih podataka iz Android APK-a bez vanjskih biblioteka:
 * ZIP (središnji direktorij) → AndroidManifest.xml (deflate) → binarni XML (AXML)
 * → paket, versionCode, versionName, naziv (ako je doslovan tekst), minSdk.
 */
import { inflateRawSync } from 'node:zlib';

export interface ApkInfo {
  packageName: string;
  versionCode: number | null;
  versionName: string | null;
  /** Naziv aplikacije ako je u manifestu doslovan tekst (inače null — naziv je u resources.arsc). */
  label: string | null;
  minSdk: number | null;
  targetSdk: number | null;
}

export class ApkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApkError';
  }
}

/** Najveća dopuštena veličina raspakiranog manifesta (zaštita od „zip bombe"). */
const MANIFEST_MAX = 4 * 1024 * 1024;

// ---------------------------------------------------------------- ZIP

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Popis datoteka iz središnjeg direktorija ZIP-a. */
export function zipEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ApkError('Datoteka nije ZIP/APK arhiva.');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset === 0xffffffff || count === 0xffff) throw new ApkError('ZIP64 arhive nisu podržane.');
  if (cdOffset + cdSize > buf.length) throw new ApkError('Oštećena arhiva (središnji direktorij).');
  const out: ZipEntry[] = [];
  let p = cdOffset;
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) throw new ApkError('Oštećena arhiva (zapis direktorija).');
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    out.push({
      method: dv.getUint16(p + 10, true),
      compressedSize: dv.getUint32(p + 20, true),
      size: dv.getUint32(p + 24, true),
      localOffset: dv.getUint32(p + 42, true),
      name: dec.decode(buf.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Sadržaj jedne datoteke iz arhive (stored ili deflate). */
export function zipRead(buf: Uint8Array, e: ZipEntry, maxSize = MANIFEST_MAX): Uint8Array {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const p = e.localOffset;
  if (p + 30 > buf.length || dv.getUint32(p, true) !== 0x04034b50) throw new ApkError('Oštećena arhiva (lokalno zaglavlje).');
  const start = p + 30 + dv.getUint16(p + 26, true) + dv.getUint16(p + 28, true);
  const data = buf.subarray(start, start + e.compressedSize);
  if (data.length !== e.compressedSize) throw new ApkError('Oštećena arhiva (skraćena datoteka).');
  if (e.size > maxSize) throw new ApkError(`${e.name} je prevelik.`);
  if (e.method === 0) return data;
  if (e.method === 8) {
    try {
      return new Uint8Array(inflateRawSync(data, { maxOutputLength: maxSize }));
    } catch {
      throw new ApkError(`${e.name} se ne može raspakirati.`);
    }
  }
  throw new ApkError(`Nepodržana kompresija (${e.method}).`);
}

// ---------------------------------------------------------------- binarni XML (AXML)

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_RESOURCE_MAP = 0x0180;
const NO_INDEX = 0xffffffff;

/** Atributi po id-u resursa — kad su nazivi atributa u APK-u uklonjeni (obfuskacija). */
const ATTR_BY_RES: Record<number, string> = {
  0x01010001: 'label',
  0x0101020c: 'minSdkVersion',
  0x01010270: 'targetSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
};

export interface AxmlElement {
  name: string;
  attrs: Record<string, string | number | boolean>;
}

function readStringPool(buf: Uint8Array, dv: DataView, at: number): string[] {
  const headerSize = dv.getUint16(at + 2, true);
  const count = dv.getUint32(at + 8, true);
  const flags = dv.getUint32(at + 16, true);
  const stringsStart = dv.getUint32(at + 20, true);
  const utf8 = (flags & 0x100) !== 0;
  const strings: string[] = [];
  const u8 = new TextDecoder('utf-8');
  for (let i = 0; i < count; i++) {
    let p = at + stringsStart + dv.getUint32(at + headerSize + i * 4, true);
    if (utf8) {
      // duljina u znakovima pa u bajtovima; svaka 1 ili 2 bajta
      p += buf[p] & 0x80 ? 2 : 1;
      let len = buf[p];
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[p + 1];
        p += 2;
      } else p += 1;
      strings.push(u8.decode(buf.subarray(p, p + len)));
    } else {
      let len = dv.getUint16(p, true);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | dv.getUint16(p + 2, true);
        p += 4;
      } else p += 2;
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint16(p + k * 2, true));
      strings.push(s);
    }
  }
  return strings;
}

/** Elementi binarnog XML-a redom (samo početni elementi s atributima). */
export function parseAxml(buf: Uint8Array, stopAt?: string): AxmlElement[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length < 8 || dv.getUint16(0, true) !== RES_XML) throw new ApkError('AndroidManifest.xml nije u binarnom obliku.');
  let strings: string[] = [];
  let resMap: number[] = [];
  const out: AxmlElement[] = [];
  let p = dv.getUint16(2, true);
  const str = (i: number) => (i === NO_INDEX ? '' : (strings[i] ?? ''));
  while (p + 8 <= buf.length) {
    const type = dv.getUint16(p, true);
    const headerSize = dv.getUint16(p + 2, true);
    const size = dv.getUint32(p + 4, true);
    if (size < 8 || p + size > buf.length) throw new ApkError('Oštećen AndroidManifest.xml.');
    if (type === RES_STRING_POOL) strings = readStringPool(buf, dv, p);
    else if (type === RES_XML_RESOURCE_MAP) {
      resMap = [];
      for (let q = p + headerSize; q + 4 <= p + size; q += 4) resMap.push(dv.getUint32(q, true));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = p + headerSize;
      const name = str(dv.getUint32(ext + 4, true));
      const attrStart = dv.getUint16(ext + 8, true);
      const attrSize = dv.getUint16(ext + 10, true) || 20;
      const attrCount = dv.getUint16(ext + 12, true);
      const attrs: AxmlElement['attrs'] = {};
      for (let k = 0; k < attrCount; k++) {
        const a = ext + attrStart + k * attrSize;
        const nameIdx = dv.getUint32(a + 4, true);
        const attrName = str(nameIdx) || ATTR_BY_RES[resMap[nameIdx]] || `attr${nameIdx}`;
        const raw = dv.getUint32(a + 8, true);
        const dataType = buf[a + 15];
        const data = dv.getUint32(a + 16, true);
        let value: string | number | boolean;
        if (raw !== NO_INDEX) value = str(raw);
        else if (dataType === 0x03) value = str(data);
        else if (dataType === 0x10) value = dv.getInt32(a + 16, true);
        else if (dataType === 0x11) value = data;
        else if (dataType === 0x12) value = data !== 0;
        else if (dataType === 0x01) value = `@0x${data.toString(16).padStart(8, '0')}`;
        else value = data;
        attrs[attrName] = value;
      }
      out.push({ name, attrs });
      if (stopAt && name === stopAt) break;
    }
    p += size;
  }
  return out;
}

// ---------------------------------------------------------------- APK

const toInt = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

export function parseApk(buf: Uint8Array): ApkInfo {
  const entry = zipEntries(buf).find((e) => e.name === 'AndroidManifest.xml');
  if (!entry) throw new ApkError('U arhivi nema AndroidManifest.xml — nije APK.');
  const els = parseAxml(zipRead(buf, entry), 'application');
  const manifest = els.find((e) => e.name === 'manifest');
  const pkg = manifest?.attrs.package;
  if (typeof pkg !== 'string' || !/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(pkg)) throw new ApkError('Manifest nema ispravan naziv paketa.');
  const sdk = els.find((e) => e.name === 'uses-sdk');
  const label = els.find((e) => e.name === 'application')?.attrs.label;
  const versionName = manifest!.attrs.versionName;
  return {
    packageName: pkg,
    versionCode: toInt(manifest!.attrs.versionCode),
    versionName: typeof versionName === 'string' && !versionName.startsWith('@') ? versionName : versionName != null && typeof versionName !== 'string' ? String(versionName) : null,
    label: typeof label === 'string' && label && !label.startsWith('@') ? label : null,
    minSdk: toInt(sdk?.attrs.minSdkVersion),
    targetSdk: toInt(sdk?.attrs.targetSdkVersion),
  };
}

/** Zadani argumenti tihe instalacije za Windows instalacijske pakete. */
export function defaultInstallArgs(fileName: string): string {
  return /\.msi$/i.test(fileName) ? '/qn' : '/S';
}
