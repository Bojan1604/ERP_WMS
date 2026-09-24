import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { ApkError, defaultInstallArgs, parseApk, parseAxml, zipEntries } from '../src/domain/apk';

// ---------------------------------------------------------------- graditelj testnog APK-a

type Attr = { name: string; str?: string; int?: number; ref?: number };

/** Binarni AndroidManifest (AXML) s nizovima u UTF-16 ili UTF-8. */
function axml(elements: { name: string; attrs: Attr[] }[], opts: { utf8?: boolean; hideNames?: boolean } = {}) {
  const strings: string[] = [];
  const idx = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  // atributi s android: imenima idu prvi — njihov redni broj odgovara mapi resursa
  const RES: Record<string, number> = { versionCode: 0x0101021b, versionName: 0x0101021c, label: 0x01010001, minSdkVersion: 0x0101020c };
  const resNames = Object.keys(RES);
  for (const n of resNames) idx(opts.hideNames ? `\u0000${n}` : n);
  const encAttr = (a: Attr) => {
    const nameIdx = resNames.includes(a.name) ? resNames.indexOf(a.name) : idx(a.name);
    const raw = a.str !== undefined ? idx(a.str) : 0xffffffff;
    const type = a.str !== undefined ? 0x03 : a.ref !== undefined ? 0x01 : 0x10;
    const data = a.str !== undefined ? idx(a.str) : (a.ref ?? a.int ?? 0);
    return { nameIdx, raw, type, data };
  };
  const els = elements.map((e) => ({ nameIdx: idx(e.name), attrs: e.attrs.map(encAttr) }));
  if (opts.hideNames) for (const n of resNames) strings[resNames.indexOf(n)] = '';

  // string pool
  const enc = strings.map((s) => {
    if (opts.utf8) {
      const b = Buffer.from(s, 'utf8');
      return Buffer.concat([Buffer.from([s.length, b.length]), b, Buffer.from([0])]);
    }
    const b = Buffer.alloc(2 + s.length * 2 + 2);
    b.writeUInt16LE(s.length, 0);
    for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), 2 + i * 2);
    return b;
  });
  let off = 0;
  const offsets = enc.map((b) => {
    const o = off;
    off += b.length;
    return o;
  });
  let data = Buffer.concat(enc);
  if (data.length % 4) data = Buffer.concat([data, Buffer.alloc(4 - (data.length % 4))]);
  const spHeader = Buffer.alloc(28);
  const spSize = 28 + strings.length * 4 + data.length;
  spHeader.writeUInt16LE(0x0001, 0);
  spHeader.writeUInt16LE(28, 2);
  spHeader.writeUInt32LE(spSize, 4);
  spHeader.writeUInt32LE(strings.length, 8);
  spHeader.writeUInt32LE(0, 12);
  spHeader.writeUInt32LE(opts.utf8 ? 0x100 : 0, 16);
  spHeader.writeUInt32LE(28 + strings.length * 4, 20);
  const offBuf = Buffer.alloc(strings.length * 4);
  offsets.forEach((o, i) => offBuf.writeUInt32LE(o, i * 4));
  const pool = Buffer.concat([spHeader, offBuf, data]);

  // mapa resursa
  const rm = Buffer.alloc(8 + resNames.length * 4);
  rm.writeUInt16LE(0x0180, 0);
  rm.writeUInt16LE(8, 2);
  rm.writeUInt32LE(rm.length, 4);
  resNames.forEach((n, i) => rm.writeUInt32LE(RES[n], 8 + i * 4));

  const chunks = els.map((e) => {
    const b = Buffer.alloc(16 + 20 + e.attrs.length * 20);
    b.writeUInt16LE(0x0102, 0);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(b.length, 4);
    b.writeUInt32LE(1, 8);
    b.writeUInt32LE(0xffffffff, 12);
    b.writeUInt32LE(0xffffffff, 16); // ns
    b.writeUInt32LE(e.nameIdx, 20);
    b.writeUInt16LE(20, 24);
    b.writeUInt16LE(20, 26);
    b.writeUInt16LE(e.attrs.length, 28);
    e.attrs.forEach((a, i) => {
      const p = 36 + i * 20;
      b.writeUInt32LE(0xffffffff, p);
      b.writeUInt32LE(a.nameIdx, p + 4);
      b.writeUInt32LE(a.raw, p + 8);
      b.writeUInt16LE(8, p + 12);
      b.writeUInt8(0, p + 14);
      b.writeUInt8(a.type, p + 15);
      b.writeUInt32LE(a.data >>> 0, p + 16);
    });
    return b;
  });
  const body = Buffer.concat([pool, rm, ...chunks]);
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

/** Minimalni ZIP (deflate ili stored) s više datoteka. */
function zip(files: { name: string; data: Buffer; store?: boolean }[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const comp = f.store ? f.data : deflateRawSync(f.data);
    const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(f.store ? 0 : 8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(f.store ? 0 : 8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const manifest = (opts: { utf8?: boolean; hideNames?: boolean; label?: Attr } = {}) =>
  axml(
    [
      { name: 'manifest', attrs: [{ name: 'versionCode', int: 3030479 }, { name: 'versionName', str: '3.3.0.479' }, { name: 'package', str: 'hr.demo.blagajna' }] },
      { name: 'uses-sdk', attrs: [{ name: 'minSdkVersion', int: 26 }] },
      { name: 'application', attrs: [opts.label ?? { name: 'label', str: 'Blagajna Č' }] },
      { name: 'activity', attrs: [{ name: 'label', str: 'ne-ovo' }] },
    ],
    opts,
  );

// ---------------------------------------------------------------- testovi

test('APK: paket, verzija, naziv i minSdk (UTF-16 nizovi)', () => {
  const apk = zip([{ name: 'classes.dex', data: Buffer.alloc(100, 1) }, { name: 'AndroidManifest.xml', data: manifest() }]);
  assert.deepEqual(parseApk(apk), { packageName: 'hr.demo.blagajna', versionCode: 3030479, versionName: '3.3.0.479', label: 'Blagajna Č', minSdk: 26, targetSdk: null });
});

test('APK: UTF-8 nizovi, spremljen bez kompresije', () => {
  const apk = zip([{ name: 'AndroidManifest.xml', data: manifest({ utf8: true }), store: true }]);
  const info = parseApk(apk);
  assert.equal(info.packageName, 'hr.demo.blagajna');
  assert.equal(info.label, 'Blagajna Č');
  assert.equal(info.versionCode, 3030479);
});

test('APK: nazivi atributa samo kroz mapu resursa; naziv kao referenca → null', () => {
  const apk = zip([{ name: 'AndroidManifest.xml', data: manifest({ hideNames: true, label: { name: 'label', ref: 0x7f0e001b } }) }]);
  const info = parseApk(apk);
  assert.equal(info.versionName, '3.3.0.479');
  assert.equal(info.versionCode, 3030479);
  assert.equal(info.label, null);
});

test('APK: neispravne datoteke', () => {
  assert.throws(() => parseApk(Buffer.from('nije zip')), ApkError);
  assert.throws(() => parseApk(zip([{ name: 'a.txt', data: Buffer.from('x') }])), /AndroidManifest/);
  assert.throws(() => parseApk(zip([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') }])), /binarnom/);
  assert.equal(zipEntries(zip([{ name: 'a', data: Buffer.from('1') }, { name: 'b', data: Buffer.from('2') }])).length, 2);
  assert.equal(parseAxml(manifest(), 'manifest').length, 1);
});

test('Windows: zadani argumenti tihe instalacije', () => {
  assert.equal(defaultInstallArgs('Setup.MSI'), '/qn');
  assert.equal(defaultInstallArgs('setup.exe'), '/S');
});
