import 'server-only';
import type { Tx } from '../db';
import { audit } from '../audit';
import { AuthError, DomainError, assert } from '../errors';
import { queueCommands } from './commands';
import { assertOrgInScope, canEditShared, deviceWhere, orgWhere, sharedWhere, type MdmScope } from './scope';
import type { Actor } from './profiles';

/**
 * Datoteke knjižnice MDM-a: instalacijski paketi (APP), datoteke za slanje na
 * uređaje (FILE) i dokumenti za partnere (DOC). Sadržaj je na disku (storage.ts),
 * u bazi samo zapis; vidljivost kao profili — vlastite organizacije + zajedničke.
 */

export type LibraryKind = 'APP' | 'FILE' | 'DOC';
export const LIBRARY_KINDS: LibraryKind[] = ['APP', 'FILE', 'DOC'];

export const MAX_BYTES: Record<LibraryKind, number> = {
  APP: 200 * 1024 * 1024,
  FILE: 200 * 1024 * 1024,
  DOC: 50 * 1024 * 1024,
};

/** Zadane odredišne mape za „Pošalji na uređaje". */
export const DEFAULT_TARGET: Record<'ANDROID' | 'WINDOWS', string> = {
  ANDROID: 'Download/',
  WINDOWS: 'C:\\ProgramData\\ERPWMS\\files\\',
};

/** Čiji je novi zapis: vlasnik bira (prazno = zajedničko), vanjski korisnik samo organizaciju u opsegu. */
export async function uploadOrg(tx: Tx, scope: MdmScope, requested: string | null): Promise<string | null> {
  if (!requested) {
    if (scope.owner) return null;
    return scope.homeOrgId;
  }
  assertOrgInScope(scope, requested);
  const org = await tx.mdmOrg.findFirst({ where: { AND: [{ id: requested }, orgWhere(scope)] }, select: { id: true } });
  if (!org) throw new AuthError('Organizacija nije dostupna.', 403);
  return org.id;
}

/** Sigurni naziv za prikaz/preuzimanje (bez putanje i kontrolnih znakova). */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const s = base.replace(/[\u0000-\u001f\u007f"<>|:*?]/g, '_').trim().slice(0, 200);
  return s || 'datoteka';
}

export async function findLibraryFile(tx: Tx, scope: MdmScope, id: string, kinds: LibraryKind[] = LIBRARY_KINDS) {
  const f = await tx.mdmFile.findFirst({ where: { AND: [{ id, kind: { in: kinds } }, sharedWhere(scope)] } });
  if (!f) throw new AuthError('Datoteka nije dostupna.', 403);
  return f;
}

export async function createFileRecord(
  tx: Tx,
  scope: MdmScope,
  actor: Actor,
  f: { kind: LibraryKind; orgId: string | null; name: string; mime: string; size: number; sha256: string; storageKey: string },
) {
  const row = await tx.mdmFile.create({ data: { companyId: scope.companyId, createdBy: actor.name, ...f } });
  if (f.kind !== 'APP') {
    await audit(tx, actor, { entity: 'mdmFile', entityId: row.id, action: 'create', summary: `${f.kind === 'DOC' ? 'Dokument' : 'Datoteka'} ${f.name} (MDM)` });
  }
  return row;
}

/** Brisanje datoteke/dokumenta; vraća ključ za brisanje s diska nakon transakcije. */
export async function deleteLibraryFile(tx: Tx, scope: MdmScope, actor: Actor, id: string) {
  const f = await findLibraryFile(tx, scope, id, ['FILE', 'DOC']);
  if (!canEditShared(scope, f.orgId)) throw new AuthError('Zajedničke datoteke briše samo vlasnik sustava.', 403);
  await tx.mdmFile.delete({ where: { id } });
  await audit(tx, actor, { entity: 'mdmFile', entityId: id, action: 'delete', summary: `Obrisana MDM datoteka ${f.name}` });
  return f.storageKey;
}

/**
 * Naredba PUSH_FILE odabranim uređajima ili svim upisanim uređajima lokacije.
 * Odredište bez unosa: zadana mapa po platformi.
 */
export async function pushFile(
  tx: Tx,
  scope: MdmScope,
  actor: Actor,
  input: { fileId: string; deviceIds: string[]; siteId: string | null; targetPath: string | null },
) {
  const f = await findLibraryFile(tx, scope, input.fileId, ['FILE', 'DOC', 'APP']);
  let ids = [...new Set(input.deviceIds)];
  if (input.siteId) {
    const site = await tx.mdmSite.findFirst({ where: { id: input.siteId, org: orgWhere(scope) }, select: { id: true } });
    if (!site) throw new AuthError('Lokacija nije dostupna.', 403);
    const rows = await tx.mdmDevice.findMany({ where: { AND: [{ siteId: site.id, status: 'ENROLLED' }, deviceWhere(scope)] }, select: { id: true } });
    ids = [...new Set([...ids, ...rows.map((r) => r.id)])];
  }
  assert(ids.length, 'Niste odabrali nijedan uređaj.');
  const target = input.targetPath?.trim() || null;
  if (target) assert(!/(^|[\\/])\.\.([\\/]|$)/.test(target) && target.length <= 260, 'Neispravna odredišna mapa.');
  const devices = await tx.mdmDevice.findMany({ where: { AND: [{ id: { in: ids } }, deviceWhere(scope)] }, select: { id: true, platform: true } });
  if (devices.length !== ids.length) throw new AuthError('Neki uređaji nisu dostupni.', 403);
  let queued = 0;
  let skipped = 0;
  for (const platform of ['ANDROID', 'WINDOWS'] as const) {
    const group = devices.filter((d) => d.platform === platform).map((d) => d.id);
    if (!group.length) continue;
    const payload = { fileId: f.id, downloadPath: `/api/mdm/agent/files/${f.id}`, name: f.name, size: f.size, sha256: f.sha256, targetPath: target ?? DEFAULT_TARGET[platform] };
    try {
      const r = await queueCommands(tx, scope, group, 'PUSH_FILE', payload);
      queued += r.queued;
      skipped += r.skipped;
    } catch (e) {
      // lokacija s mješovitim uređajima: jedna skupina bez upisanih ne ruši cijelo slanje
      if (!(e instanceof DomainError) || devices.length === group.length) throw e;
      skipped += group.length;
    }
  }
  await audit(tx, actor, { entity: 'mdmFile', entityId: f.id, action: 'push', summary: `Slanje datoteke ${f.name} na ${queued} uređaja` });
  return { queued, skipped };
}
