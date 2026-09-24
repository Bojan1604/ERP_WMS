import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { crc32, safeZipPath, uniqueName, ZipWriter, ZipTooLargeError } from '../src/server/zip';

/** Čita arhivu preko središnjeg imenika (kao unzip) i vraća naziv → sadržaj. */
function readZip(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'nema kraja središnjeg imenika');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, { data: Buffer; flags: number; method: number }>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50);
    const lnlen = buf.readUInt16LE(off + 26);
    const start = off + 30 + lnlen + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(data.length, size);
    assert.equal(crc32(data), crc);
    out.set(name, { data, flags, method });
    p += 46 + nlen;
  }
  return out;
}

test('zip: CRC32 poznatih vrijednosti', () => {
  assert.equal(crc32(Buffer.from('')), 0);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zip: nazivi su očišćeni i jedinstveni', () => {
  assert.equal(safeZipPath('../../etc/passwd'), 'etc/passwd');
  assert.equal(safeZipPath('/abs\\win\\a:b*c?.pdf'), 'abs/win/a_b_c_.pdf');
  assert.equal(safeZipPath('  ..  '), 'datoteka');
  const taken = new Set<string>();
  assert.equal(uniqueName(taken, 'izlazni/1-PP1-1.xml'), 'izlazni/1-PP1-1.xml');
  assert.equal(uniqueName(taken, 'izlazni/1-pp1-1.xml'), 'izlazni/1-pp1-1 (2).xml');
  assert.equal(uniqueName(taken, 'izlazni/1-PP1-1.xml'), 'izlazni/1-PP1-1 (3).xml');
  assert.equal(uniqueName(taken, 'mapa.v2/bez'), 'mapa.v2/bez');
  assert.equal(uniqueName(taken, 'mapa.v2/bez'), 'mapa.v2/bez (2)');
});

test('zip: povratno čitanje (sažeto, spremljeno, UTF-8 nazivi, duplikati)', () => {
  const z = new ZipWriter();
  const big = 'Račun;Ćevapi;Žurba\n'.repeat(500);
  const rnd = Buffer.alloc(300);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 7919 + 13) & 0xff;
  assert.equal(z.add('popis.csv', big), 'popis.csv');
  assert.equal(z.add('ulazni/Račun ž/Ćup.pdf', rnd), 'ulazni/Račun ž/Ćup.pdf');
  assert.equal(z.add('ulazni/Račun ž/Ćup.pdf', 'x'), 'ulazni/Račun ž/Ćup (2).pdf');
  assert.equal(z.add('../prazno.txt', ''), 'prazno.txt');
  const buf = z.toBuffer();
  const files = readZip(buf);
  assert.deepEqual([...files.keys()], ['popis.csv', 'ulazni/Račun ž/Ćup.pdf', 'ulazni/Račun ž/Ćup (2).pdf', 'prazno.txt']);
  assert.equal(files.get('popis.csv')!.data.toString('utf8'), big);
  assert.equal(files.get('popis.csv')!.method, 8);
  assert.ok(files.get('popis.csv')!.flags & 0x0800);
  assert.deepEqual(files.get('ulazni/Račun ž/Ćup.pdf')!.data, rnd);
  assert.equal(files.get('prazno.txt')!.data.length, 0);

  // vanjska provjera, ako je unzip dostupan
  let hasUnzip = true;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    hasUnzip = false;
  }
  if (hasUnzip) {
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      const f = join(dir, 't.zip');
      writeFileSync(f, buf);
      const out = execFileSync('unzip', ['-t', f], { encoding: 'utf8' });
      assert.match(out, /No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('zip: gornja granica veličine', () => {
  const z = new ZipWriter(2000);
  const rnd = Buffer.alloc(1500);
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 2654435761) >>> 24;
  z.add('a.bin', rnd);
  assert.throws(() => z.add('b.bin', rnd), ZipTooLargeError);
});
