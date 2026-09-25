import 'server-only';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { db } from '../db';
import { DomainError } from '../errors';
import { exportCompanyStream } from '../import/backup';
import { fromISO, today } from '@/domain/dates';

/**
 * Sigurnosne kopije na poslužitelju (F10): JSON izvoz firme (isti oblik kao
 * „Preuzmi kopiju", server/import/backup.ts), sažet gzipom, u
 * `storage/backups/<firma>/` (ili BACKUP_DIR). Automatske se čuvaju prema
 * Company.backupKeep (starije se brišu); ručne do 50 najnovijih.
 *
 * Dnevna automatska kopija se „prijavljuje" atomskim upisom Company.lastBackupAt
 * (UPDATE … WHERE lastBackupAt < danas) — više procesa istog dana ne radi je dvaput.
 */
export const MANUAL_KEEP = 50;
const NAME_RE = /^kopija-(\d{4}-\d{2}-\d{2})-(\d{6})-(auto|rucna)\.json\.gz$/;

export const backupRoot = () => process.env.BACKUP_DIR || path.join(process.cwd(), 'storage', 'backups');

function dirOf(companyId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(companyId)) throw new DomainError('Neispravna firma.');
  return path.join(backupRoot(), companyId);
}

function fileOf(companyId: string, name: string) {
  if (!NAME_RE.test(name)) throw new DomainError('Neispravan naziv kopije.');
  return path.join(dirOf(companyId), name);
}

export interface BackupFile {
  name: string;
  /** ISO vrijeme nastanka (iz naziva). */
  at: string;
  kind: 'auto' | 'rucna';
  size: number;
}

/** Popis kopija firme, najnovije prve. */
export async function listBackups(companyId: string): Promise<BackupFile[]> {
  const dir = dirOf(companyId);
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: BackupFile[] = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const st = await stat(path.join(dir, name)).catch(() => null);
    if (!st) continue;
    const t = m[2];
    // naziv nosi lokalno vrijeme (Europe/Zagreb) — pretvara se u pravi trenutak (ISO s zonom)
    out.push({ name, at: zagrebToIso(m[1], t), kind: m[3] as BackupFile['kind'], size: st.size });
  }
  return out.sort((a, b) => b.name.slice(7, 24).localeCompare(a.name.slice(7, 24)));
}

/** Pomak zone Europe/Zagreb (ms) u zadanom trenutku. */
function zagrebOffset(ms: number) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - ms;
}

/** Lokalno vrijeme iz naziva kopije (YYYY-MM-DD + HHmmss, Europe/Zagreb) → ISO trenutak (UTC). */
function zagrebToIso(day: string, hms: string) {
  const [y, mo, d] = day.split('-').map(Number);
  const local = Date.UTC(y, mo - 1, d, Number(hms.slice(0, 2)), Number(hms.slice(2, 4)), Number(hms.slice(4, 6)));
  let utc = local - zagrebOffset(local);
  utc = local - zagrebOffset(utc); // ispravak oko prijelaza ljetnog računanja vremena
  return new Date(utc).toISOString();
}

/** Vrijeme u zoni firme za naziv datoteke (YYYY-MM-DD-HHmmss). */
function stamp(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now).replace(/:/g, '');
  return `${today(now)}-${p}`;
}

/** Nova kopija na disku (tok: baza → JSON → gzip → datoteka; ne drži cijelu firmu u memoriji). */
export async function createBackup(companyId: string, kind: 'auto' | 'rucna'): Promise<BackupFile> {
  const dir = dirOf(companyId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let name = `kopija-${stamp()}-${kind}.json.gz`;
  // dvije kopije u istoj sekundi — sljedeća sekunda
  for (let i = 0; i < 5 && (await stat(path.join(dir, name)).catch(() => null)); i++) name = `kopija-${stamp(new Date(Date.now() + (i + 1) * 1000))}-${kind}.json.gz`;
  const final = path.join(dir, name);
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    const web = await exportCompanyStream(companyId);
    await pipeline(Readable.fromWeb(web as import('node:stream/web').ReadableStream<Uint8Array>), createGzip({ level: 6 }), createWriteStream(tmp, { mode: 0o600, flags: 'wx' }));
    await rename(tmp, final);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  const size = (await stat(final)).size;
  await db.company.update({ where: { id: companyId }, data: { lastBackupAt: new Date() } });
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { backupKeep: true } });
  await pruneBackups(companyId, company.backupKeep);
  return { name, at: new Date().toISOString(), kind, size };
}

/** Zadržava `keep` najnovijih automatskih i MANUAL_KEEP ručnih kopija. */
export async function pruneBackups(companyId: string, keep: number) {
  const list = await listBackups(companyId);
  const drop = [...list.filter((b) => b.kind === 'auto').slice(Math.max(1, keep)), ...list.filter((b) => b.kind === 'rucna').slice(MANUAL_KEEP)];
  for (const b of drop) await rm(fileOf(companyId, b.name), { force: true });
  return drop.length;
}

export async function deleteBackup(companyId: string, name: string) {
  const f = fileOf(companyId, name);
  const st = await stat(f).catch(() => null);
  if (!st) throw new DomainError('Kopija ne postoji.');
  await rm(f, { force: true });
}

/** Tok raspakiranog JSON-a kopije (za preuzimanje). */
export async function openBackup(companyId: string, name: string): Promise<ReadableStream<Uint8Array>> {
  const f = fileOf(companyId, name);
  if (!(await stat(f).catch(() => null))) throw new DomainError('Kopija ne postoji.');
  const nodeStream = createReadStream(f).pipe(createGunzip()).pipe(new Transform({ transform: (c, _e, cb) => cb(null, c) }));
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

/** Najveća raspakirana kopija koja se vraća u program (MB; BACKUP_RESTORE_MAX_MB, zadano 256). */
export const restoreMaxBytes = () => {
  const mb = Number(process.env.BACKUP_RESTORE_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 256) * 1024 * 1024;
};

/**
 * Kopija kao objekt (za vraćanje). Vraćanje treba cijeli objekt u memoriji, pa se
 * raspakiravanje prekida čim prijeđe granicu (inače bi velika firma srušila proces
 * zbog nedostatka memorije) — s jasnom porukom umjesto pada.
 */
export async function readBackup(companyId: string, name: string, maxBytes = restoreMaxBytes()): Promise<unknown> {
  const f = fileOf(companyId, name);
  if (!(await stat(f).catch(() => null))) throw new DomainError('Kopija ne postoji.');
  const chunks: Buffer[] = [];
  let size = 0;
  const src = createReadStream(f);
  const gunzip = createGunzip();
  try {
    for await (const c of src.pipe(gunzip)) {
      size += (c as Buffer).length;
      if (size > maxBytes) {
        throw new DomainError(
          `Kopija je prevelika za vraćanje u programu (više od ${Math.round(maxBytes / 1024 / 1024)} MB raspakirano). Za tako veliku firmu koristite kopiju cijele baze (deploy/backup.sh i restore.sh) ili povećajte BACKUP_RESTORE_MAX_MB.`,
        );
      }
      chunks.push(c as Buffer);
    }
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError('Kopija je oštećena (nije ispravan gzip).');
  } finally {
    src.destroy();
    gunzip.destroy();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new DomainError('Kopija je oštećena (nije ispravan JSON).');
  }
}

/**
 * Dnevna automatska kopija za firme s uključenom opcijom. Firma se „prijavljuje"
 * atomskim upisom lastBackupAt; ako kopija ne uspije, vraća se prethodna vrijednost.
 */
export async function runAutoBackups(now = new Date()): Promise<Array<{ companyId: string; ok: boolean; name?: string; error?: string }>> {
  const startOfDay = fromISO(today(now));
  const due = await db.company.findMany({ where: { autoBackup: true, OR: [{ lastBackupAt: null }, { lastBackupAt: { lt: startOfDay } }] }, select: { id: true, lastBackupAt: true } });
  const out: Array<{ companyId: string; ok: boolean; name?: string; error?: string }> = [];
  for (const c of due) {
    const claimed = await db.company.updateMany({
      where: { id: c.id, autoBackup: true, OR: [{ lastBackupAt: null }, { lastBackupAt: { lt: startOfDay } }] },
      data: { lastBackupAt: now },
    });
    if (!claimed.count) continue; // drugi proces je upravo preuzeo
    try {
      const b = await createBackup(c.id, 'auto');
      out.push({ companyId: c.id, ok: true, name: b.name });
    } catch (e) {
      await db.company.update({ where: { id: c.id }, data: { lastBackupAt: c.lastBackupAt } }).catch(() => undefined);
      console.error('[kopija]', c.id, e);
      out.push({ companyId: c.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
