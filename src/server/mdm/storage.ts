import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Pohrana MDM datoteka (APK, MSI, snimke zaslona, zapisnici) na disku, izvan
 * baze. Mapa: MDM_STORAGE_DIR ili ./storage/mdm. Ključ je nasumičan i ne
 * sadrži ništa iz naziva datoteke (nema putanja s klijenta).
 */
const ROOT = path.resolve(process.env.MDM_STORAGE_DIR || path.join(process.cwd(), 'storage', 'mdm'));

function keyPath(key: string) {
  if (!/^[a-z0-9]{2}\/[a-z0-9]{32}$/.test(key)) throw new Error('Neispravan ključ datoteke');
  return path.join(ROOT, key);
}

export async function saveBuffer(buf: Buffer): Promise<{ key: string; size: number; sha256: string }> {
  const id = randomBytes(16).toString('hex');
  const key = `${id.slice(0, 2)}/${id}`;
  const file = keyPath(key);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, buf, { flag: 'wx', mode: 0o600 });
  return { key, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

export function openStream(key: string, range?: { start: number; end: number }) {
  return createReadStream(keyPath(key), range);
}

export async function fileSize(key: string) {
  return (await stat(keyPath(key))).size;
}

export async function removeFile(key: string) {
  await rm(keyPath(key), { force: true });
}
