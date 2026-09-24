import 'server-only';
import type { Tx } from '../db';
import { audit } from '../audit';
import { AuthError, DomainError, assert } from '../errors';
import { bumpConfig } from './config';
import { assertOrgInScope, deviceWhere, sharedWhere, type MdmScope } from './scope';
import { PLATFORM_LABEL } from '@/domain/mdm';
import type { Level } from '@/domain/permissions';

/**
 * Izmjene uređaja iz portala (naziv, bilješke, PIN, premještaj, profil, veza na
 * ERP). Naredbe uređaju idu kroz `queueCommands`, ne ovdje.
 */

const RANK: Record<Level, number> = { none: 0, view: 1, ops: 2, edit: 3 };

export function requireLevel(scope: MdmScope, level: Exclude<Level, 'none'>) {
  if (RANK[scope.level] < RANK[level]) throw new AuthError('Nemate pravo na ovu radnju.', 403);
}

export const actorOf = (s: MdmScope) => ({ id: s.userId, name: s.userName, companyId: s.companyId });

async function devicesInScope(tx: Tx, scope: MdmScope, ids: string[]) {
  const unique = [...new Set(ids)];
  assert(unique.length, 'Niste odabrali nijedan uređaj.');
  assert(unique.length <= 1000, 'Najviše 1000 uređaja odjednom.');
  const rows = await tx.mdmDevice.findMany({
    where: { id: { in: unique }, ...deviceWhere(scope) },
    select: { id: true, name: true, platform: true, status: true, orgId: true, siteId: true, profileId: true },
  });
  if (rows.length !== unique.length) throw new AuthError('Neki uređaji nisu dostupni.', 403);
  return rows;
}

export interface DevicePatch {
  name?: string;
  notes?: string | null;
  maintenancePin?: string | null;
}

/** Naziv i bilješke (ops), servisni PIN (edit — ide u konfiguraciju). */
export async function updateDevice(tx: Tx, scope: MdmScope, id: string, patch: DevicePatch) {
  requireLevel(scope, 'ops');
  const [d] = await devicesInScope(tx, scope, [id]);
  const data: DevicePatch = {};
  if (patch.name !== undefined) {
    requireLevel(scope, 'edit');
    const name = patch.name.trim();
    assert(name.length >= 1 && name.length <= 100, 'Naziv mora imati 1–100 znakova.');
    data.name = name;
  }
  if (patch.notes !== undefined) {
    assert((patch.notes ?? '').length <= 5000, 'Bilješka je preduga.');
    data.notes = patch.notes?.trim() || null;
  }
  if (patch.maintenancePin !== undefined) {
    requireLevel(scope, 'edit');
    const pin = patch.maintenancePin?.trim() || null;
    assert(pin === null || /^\d{4,8}$/.test(pin), 'PIN mora imati 4–8 znamenki.');
    data.maintenancePin = pin;
  }
  await tx.mdmDevice.update({ where: { id }, data });
  if (data.maintenancePin !== undefined) await bumpConfig(tx, { deviceIds: [id] });
  if (data.name !== undefined && data.name !== d.name) {
    await tx.mdmEvent.create({ data: { deviceId: id, type: 'RENAME', message: `Naziv: ${d.name} → ${data.name} (${scope.userName})` } });
  }
  await audit(tx, actorOf(scope), {
    entity: 'mdmDevice',
    entityId: id,
    action: 'update',
    summary: `Uređaj ${data.name ?? d.name} izmijenjen`,
    diff: { ...data, ...(data.maintenancePin !== undefined ? { maintenancePin: data.maintenancePin ? '••••' : null } : {}) },
  });
}

/** Premještaj na organizaciju i lokaciju; profil lokacije može promijeniti konfiguraciju. */
export async function moveDevices(tx: Tx, scope: MdmScope, ids: string[], orgId: string, siteId: string | null) {
  requireLevel(scope, 'edit');
  assertOrgInScope(scope, orgId);
  const org = await tx.mdmOrg.findFirst({ where: { id: orgId, companyId: scope.companyId }, select: { name: true, active: true } });
  assert(org, 'Organizacija ne postoji.');
  let siteName = '';
  if (siteId) {
    const site = await tx.mdmSite.findFirst({ where: { id: siteId, orgId }, select: { name: true } });
    assert(site, 'Lokacija ne pripada odabranoj organizaciji.');
    siteName = ` › ${site.name}`;
  }
  const devices = await devicesInScope(tx, scope, ids);
  await tx.mdmDevice.updateMany({ where: { id: { in: devices.map((d) => d.id) } }, data: { orgId, siteId } });
  await bumpConfig(tx, { deviceIds: devices.map((d) => d.id) });
  await tx.mdmEvent.createMany({ data: devices.map((d) => ({ deviceId: d.id, type: 'MOVE', message: `Premješten: ${org.name}${siteName} (${scope.userName})` })) });
  await audit(tx, actorOf(scope), {
    entity: 'mdmDevice',
    entityId: devices.length === 1 ? devices[0].id : null,
    action: 'move',
    summary: `Premješteno ${devices.length} uređaja → ${org.name}${siteName}`,
    diff: { ids: devices.map((d) => d.id), orgId, siteId },
  });
  return devices.length;
}

/** Profil uređaja; null = profil lokacije. Profil mora biti vidljiv korisniku i iste platforme. */
export async function assignProfile(tx: Tx, scope: MdmScope, ids: string[], profileId: string | null) {
  requireLevel(scope, 'edit');
  const devices = await devicesInScope(tx, scope, ids);
  let label = 'profil lokacije';
  if (profileId) {
    const p = await tx.mdmProfile.findFirst({ where: { id: profileId, ...sharedWhere(scope) }, select: { name: true, platform: true } });
    if (!p) throw new AuthError('Profil nije dostupan.', 403);
    const wrong = devices.filter((d) => d.platform !== p.platform);
    if (wrong.length) throw new DomainError(`Profil „${p.name}" je za ${PLATFORM_LABEL[p.platform]}, a ${wrong.length} odabranih uređaja nije.`);
    label = p.name;
  }
  await tx.mdmDevice.updateMany({ where: { id: { in: devices.map((d) => d.id) } }, data: { profileId } });
  await bumpConfig(tx, { deviceIds: devices.map((d) => d.id) });
  await tx.mdmEvent.createMany({ data: devices.map((d) => ({ deviceId: d.id, type: 'PROFILE', message: `Konfiguracija: ${label} (${scope.userName})` })) });
  await audit(tx, actorOf(scope), {
    entity: 'mdmDevice',
    entityId: devices.length === 1 ? devices[0].id : null,
    action: 'profile',
    summary: `Profil „${label}" za ${devices.length} uređaja`,
    diff: { ids: devices.map((d) => d.id), profileId },
  });
  return devices.length;
}

/** Veza na uređaj u ERP skladištu — samo korisnici vlasnika. */
export async function linkItem(tx: Tx, scope: MdmScope, deviceId: string, itemId: string | null) {
  requireLevel(scope, 'edit');
  if (!scope.owner) throw new AuthError('Vezu sa skladištem postavlja samo vlasnik sustava.', 403);
  const [d] = await devicesInScope(tx, scope, [deviceId]);
  let label = 'uklonjena';
  if (itemId) {
    const item = await tx.item.findFirst({ where: { id: itemId, companyId: scope.companyId }, select: { serial: true } });
    assert(item, 'Uređaj u skladištu ne postoji.');
    label = item.serial;
  }
  await tx.mdmDevice.update({ where: { id: deviceId }, data: { itemId } });
  await audit(tx, actorOf(scope), { entity: 'mdmDevice', entityId: deviceId, action: 'link', summary: `Veza uređaja ${d.name} sa skladištem: ${label}`, diff: { itemId } });
}

/** Otkazivanje naredbe koju uređaj još nije preuzeo. */
export async function cancelCommand(tx: Tx, scope: MdmScope, commandId: string) {
  requireLevel(scope, 'ops');
  const c = await tx.mdmCommand.findFirst({ where: { id: commandId, device: deviceWhere(scope) }, select: { id: true, status: true, deviceId: true, type: true } });
  if (!c) throw new AuthError('Naredba nije dostupna.', 403);
  assert(c.status === 'PENDING', 'Otkazati se može samo naredba koja još čeka uređaj.');
  await tx.mdmCommand.update({ where: { id: c.id }, data: { status: 'CANCELLED', doneAt: new Date(), error: `Otkazao ${scope.userName}` } });
  await tx.mdmEvent.create({ data: { deviceId: c.deviceId, type: 'COMMAND', message: `Naredba ${c.type} otkazana (${scope.userName})` } });
}

/** Brisanje uređaja koji nije upisan ili je odjavljen (upisani se prvo odjavljuju naredbom FORGET). */
export async function removeDevice(tx: Tx, scope: MdmScope, id: string) {
  requireLevel(scope, 'edit');
  const [d] = await devicesInScope(tx, scope, [id]);
  assert(d.status !== 'ENROLLED', 'Upisani uređaj prvo odjavite (Forget).');
  // snimke i zapisnici uređaja brišu se s njim; datoteke s diska briše pozivatelj nakon potvrde transakcije
  const files = await tx.mdmFile.findMany({ where: { uploads: { some: { deviceId: id } } }, select: { id: true, storageKey: true } });
  await tx.mdmDevice.delete({ where: { id } });
  if (files.length) await tx.mdmFile.deleteMany({ where: { id: { in: files.map((f) => f.id) }, companyId: scope.companyId } });
  await audit(tx, actorOf(scope), { entity: 'mdmDevice', entityId: id, action: 'delete', summary: `Uređaj ${d.name} uklonjen iz popisa` });
  return { storageKeys: files.map((f) => f.storageKey) };
}
