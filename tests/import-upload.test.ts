/**
 * Slanje datoteke za uvoz u dijelovima: redoslijed dijelova, čišćenje i jedan posao po korisniku.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendPart, PART_BYTES, readUpload, removeUpload, withUserLock } from '../src/server/import/upload';

const id = () => randomBytes(16).toString('hex');
const DIR = path.join(tmpdir(), 'erp-wms-uvoz');

test('dijelovi moraju stizati redom; dupli ili preskočeni dio se odbija', async () => {
  const user = `test${Date.now()}`;
  const up = id();
  const enc = (t: string) => new TextEncoder().encode(t);
  assert.equal(await appendPart(user, up, 0, new Uint8Array(PART_BYTES).fill(0x20)), PART_BYTES); // razmaci — valjan početak JSON-a
  await assert.rejects(appendPart(user, up, 2, enc('{}')), /redom/); // preskočen dio 1
  assert.equal(await appendPart(user, up, 1, enc('{"a":1}')), PART_BYTES + 7);
  await assert.rejects(appendPart(user, up, 1, enc('{"a":1}')), /redom/); // dio 1 dvaput
  assert.deepEqual(await readUpload(user, up), { a: 1 });
  await assert.rejects(appendPart(user, up, 2, new Uint8Array(PART_BYTES + 1)), /prevelik/);
  await removeUpload(user, up);
});

test('dio 0 briše korisnikove ranije datoteke, tuđe ostaju; mapa je privatna', async () => {
  const user = `test${Date.now()}b`;
  const other = `test${Date.now()}c`;
  const a = id();
  const b = id();
  const o = id();
  await appendPart(user, a, 0, new TextEncoder().encode('{"x":1}'));
  await appendPart(other, o, 0, new TextEncoder().encode('{"y":2}'));
  await appendPart(user, b, 0, new TextEncoder().encode('{"z":3}'));
  const names = await readdir(DIR);
  assert.ok(!names.includes(`${user}-${a}.json`));
  assert.ok(names.includes(`${user}-${b}.json`));
  assert.ok(names.includes(`${other}-${o}.json`));
  assert.deepEqual(await readUpload(user, b), { z: 3 });
  assert.equal((await stat(DIR)).mode & 0o077, 0);
  assert.equal((await stat(path.join(DIR, `${user}-${b}.json`))).mode & 0o077, 0);
  await removeUpload(user, b);
  await removeUpload(other, o);
});

test('jedna analiza ili uvoz po korisniku', async () => {
  let release!: () => void;
  const first = withUserLock('u1', () => new Promise<string>((r) => (release = () => r('prvi'))));
  await assert.rejects(withUserLock('u1', async () => 'drugi'), /u tijeku/);
  assert.equal(await withUserLock('u2', async () => 'drugi korisnik'), 'drugi korisnik');
  release();
  assert.equal(await first, 'prvi');
  assert.equal(await withUserLock('u1', async () => 'nakon'), 'nakon');
});
