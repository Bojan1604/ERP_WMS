import 'server-only';
import { createReadStream } from 'node:fs';
import { appendFile, chmod, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DomainError } from '../errors';

/**
 * Privremena datoteka uvoza. Preglednik šalje datoteku u dijelovima (≤ 8 MB —
 * middleware ne propušta veća tijela zahtjeva), poslužitelj ih slaže u
 * privremenu datoteku, a analiza i uvoz je čitaju po oznaci. Datoteka je
 * vezana uz korisnika, briše se nakon uvoza, a zaostale nakon 24 h.
 */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
export const PART_BYTES = 8 * 1024 * 1024;
const DIR = path.join(tmpdir(), 'erp-wms-uvoz');
const KEEP_MS = 24 * 3_600_000;

function fileOf(userId: string, uploadId: string) {
  if (!/^[a-f0-9]{32}$/.test(uploadId)) throw new DomainError('Neispravna oznaka datoteke.');
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new DomainError('Neispravan korisnik.');
  return path.join(DIR, `${userId}-${uploadId}.json`);
}

/**
 * Dio datoteke; dio 0 započinje novu datoteku (i briše korisnikove ranije
 * nedovršene), ostali se dodaju samo redom: trenutna veličina mora biti točno
 * `dio × PART_BYTES` (dupli ili preskočeni dio se odbija). Vraća veličinu.
 */
export async function appendPart(userId: string, uploadId: string, part: number, bytes: Uint8Array): Promise<number> {
  if (bytes.byteLength > PART_BYTES) throw new DomainError('Dio datoteke je prevelik.');
  const f = fileOf(userId, uploadId);
  await ensureDir();
  if (part === 0) {
    await cleanupOld(userId);
    // 'wx': nikad ne piše preko postojeće datoteke (ni poveznice koju je netko podmetnuo)
    await rm(f, { force: true });
    await writeFile(f, bytes, { flag: 'wx', mode: 0o600 });
  } else {
    const size = await stat(f).then((s) => s.size).catch(() => -1);
    if (size < 0) throw new DomainError('Slanje datoteke je prekinuto — pokušajte ponovno.');
    if (size !== part * PART_BYTES) {
      throw new DomainError(`Dio ${part + 1} ne nastavlja se na poslano (dijelovi moraju stizati redom) — odaberite datoteku ponovno.`);
    }
    if (size + bytes.byteLength > MAX_UPLOAD_BYTES) {
      await rm(f, { force: true });
      throw new DomainError(`Datoteka je veća od ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }
    await appendFile(f, bytes);
  }
  return (await stat(f)).size;
}

/** Sadržaj učitane datoteke kao JSON. */
export async function readUpload(userId: string, uploadId: string): Promise<unknown> {
  const f = fileOf(userId, uploadId);
  const chunks: Buffer[] = [];
  try {
    for await (const c of createReadStream(f)) chunks.push(c as Buffer);
  } catch {
    throw new DomainError('Datoteka više nije dostupna — odaberite je ponovno.');
  }
  const text = Buffer.concat(chunks).toString('utf8');
  chunks.length = 0;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new DomainError('Datoteka nije ispravan JSON.');
  }
}

export async function removeUpload(userId: string, uploadId: string) {
  await rm(fileOf(userId, uploadId), { force: true });
}

/** Mapa samo za korisnika poslužitelja; u zajedničkom /tmp ne smije biti tuđa mapa ni poveznica. */
async function ensureDir() {
  await mkdir(DIR, { recursive: true, mode: 0o700 });
  const st = await lstat(DIR);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) throw new DomainError('Privremena mapa za uvoz nije ispravna — javite administratoru poslužitelja.');
  if ((st.mode & 0o077) !== 0) await chmod(DIR, 0o700);
}

/** Briše datoteke starije od 24 h i ranije datoteke istog korisnika (nova zamjenjuje staru). */
async function cleanupOld(userId: string) {
  const now = Date.now();
  for (const name of await readdir(DIR).catch(() => [] as string[])) {
    const f = path.join(DIR, name);
    if (name.startsWith(`${userId}-`)) {
      await rm(f, { force: true });
      continue;
    }
    const s = await stat(f).catch(() => null);
    if (s && now - s.mtimeMs > KEEP_MS) await rm(f, { force: true });
  }
}

// ---------------------------------------------------------------- jedan posao po korisniku

const busy = new Set<string>();

/**
 * Analiza ili uvoz — najviše jedan istodobno po korisniku (u ovom procesu):
 * dvostruki klik ili druga kartica ne mogu stvoriti dvije firme niti dvaput
 * učitati 256 MB u memoriju.
 */
export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(userId)) throw new DomainError('Već je u tijeku analiza ili uvoz — pričekajte da završi.');
  busy.add(userId);
  try {
    return await fn();
  } finally {
    busy.delete(userId);
  }
}
