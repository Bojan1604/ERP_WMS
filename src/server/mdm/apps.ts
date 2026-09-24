import 'server-only';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { audit } from '../audit';
import { AuthError, assert } from '../errors';
import { queueCommands } from './commands';
import { bumpConfig } from './config';
import { canEditShared, deviceWhere, sharedWhere, type MdmScope } from './scope';
import type { Actor } from './profiles';

/**
 * Knjižnica aplikacija: aplikacija (paket) s verzijama; svaka verzija ima svoju
 * datoteku (MdmFile kind APP). Verzija koju koristi neka konfiguracija ne briše se.
 */

export async function findApp(tx: Tx, scope: MdmScope, id: string) {
  const a = await tx.mdmApp.findFirst({ where: { AND: [{ id }, sharedWhere(scope)] } });
  if (!a) throw new AuthError('Aplikacija nije dostupna.', 403);
  return a;
}

async function findAppForEdit(tx: Tx, scope: MdmScope, id: string) {
  const a = await findApp(tx, scope, id);
  if (!canEditShared(scope, a.orgId)) throw new AuthError('Zajedničku aplikaciju mijenja samo vlasnik sustava.', 403);
  return a;
}

export interface NewVersion {
  /** Postojeća aplikacija (nova verzija) ili null — pronađi/stvori po paketu. */
  appId: string | null;
  platform: 'ANDROID' | 'WINDOWS';
  orgId: string | null;
  packageName: string;
  name: string;
  version: string;
  versionCode: number | null;
  installArgs: string | null;
  notes: string | null;
  fileId: string;
}

/** Nova verzija aplikacije; aplikacija se stvara pri prvom prijenosu paketa. */
export async function addAppVersion(tx: Tx, scope: MdmScope, actor: Actor, v: NewVersion) {
  let app = v.appId ? await findAppForEdit(tx, scope, v.appId) : await tx.mdmApp.findFirst({ where: { companyId: scope.companyId, platform: v.platform, packageName: v.packageName, orgId: v.orgId } });
  if (app) {
    if (!canEditShared(scope, app.orgId)) throw new AuthError('Zajedničku aplikaciju mijenja samo vlasnik sustava.', 403);
    assert(app.platform === v.platform, 'Paket je za drugu platformu.');
    assert(app.packageName === v.packageName, `Paket „${v.packageName}" ne odgovara aplikaciji (${app.packageName}).`);
    if (v.installArgs !== null && v.installArgs !== app.installArgs) app = await tx.mdmApp.update({ where: { id: app.id }, data: { installArgs: v.installArgs } });
  } else {
    app = await tx.mdmApp.create({
      data: { companyId: scope.companyId, orgId: v.orgId, platform: v.platform, packageName: v.packageName, name: v.name, installArgs: v.installArgs },
    });
  }
  const dup = await tx.mdmAppVersion.findFirst({ where: { appId: app.id, version: v.version }, select: { id: true } });
  assert(!dup, `Verzija ${v.version} aplikacije „${app.name}" već postoji.`);
  const ver = await tx.mdmAppVersion.create({ data: { appId: app.id, version: v.version, versionCode: v.versionCode, fileId: v.fileId, notes: v.notes } });
  await bumpAppConfigs(tx, scope.companyId, app.id);
  await audit(tx, actor, { entity: 'mdmApp', entityId: app.id, action: 'version', summary: `Aplikacija ${app.name}: nova verzija ${v.version}` });
  return { appId: app.id, versionId: ver.id, name: app.name, version: v.version };
}

export async function updateApp(tx: Tx, scope: MdmScope, actor: Actor, input: { id: string; name: string; description: string | null; installArgs: string | null }) {
  const app = await findAppForEdit(tx, scope, input.id);
  await tx.mdmApp.update({ where: { id: app.id }, data: { name: input.name, description: input.description, installArgs: app.platform === 'WINDOWS' ? input.installArgs : null } });
  await bumpAppConfigs(tx, scope.companyId, app.id);
  await audit(tx, actor, { entity: 'mdmApp', entityId: app.id, action: 'update', summary: `Aplikacija ${input.name} izmijenjena` });
}

export async function updateVersionNotes(tx: Tx, scope: MdmScope, actor: Actor, versionId: string, notes: string | null) {
  const v = await tx.mdmAppVersion.findUnique({ where: { id: versionId }, select: { appId: true, version: true } });
  if (!v) throw new AuthError('Verzija ne postoji.', 403);
  await findAppForEdit(tx, scope, v.appId);
  await tx.mdmAppVersion.update({ where: { id: versionId }, data: { notes } });
}

/** Konfiguracije i uređaji (izmjene) koji navode aplikaciju ili konkretnu verziju — u cijeloj firmi. */
export async function appReferences(tx: Tx, companyId: string, ref: { appId: string } | { versionId: string }) {
  const [profiles, devices] = await Promise.all([
    tx.mdmProfile.findMany({ where: { companyId, apps: { array_contains: [ref] } }, select: { id: true, name: true, orgId: true } }),
    tx.mdmDevice.findMany({ where: { companyId, overrides: { path: ['apps'], array_contains: [ref] } }, select: { id: true, name: true } }),
  ]);
  return { profiles, devices };
}

/**
 * Konfiguracije bez odabrane verzije koriste najnoviju, a naziv i parametri instalacije idu
 * u konfiguraciju — nakon promjene aplikacije podiže se verzija svih uređaja koji je koriste.
 */
async function bumpAppConfigs(tx: Tx, companyId: string, appId: string) {
  const refs = await appReferences(tx, companyId, { appId });
  for (const p of refs.profiles) await bumpConfig(tx, { profileId: p.id });
  if (refs.devices.length) await bumpConfig(tx, { deviceIds: refs.devices.map((d) => d.id) });
}

/** Brisanje verzije; vraća ključ datoteke za brisanje s diska nakon transakcije. */
export async function deleteVersion(tx: Tx, scope: MdmScope, actor: Actor, versionId: string) {
  const v = await tx.mdmAppVersion.findUnique({ where: { id: versionId }, include: { file: true } });
  if (!v) throw new AuthError('Verzija ne postoji.', 403);
  const app = await findAppForEdit(tx, scope, v.appId);
  const refs = await appReferences(tx, scope.companyId, { versionId });
  assert(
    !refs.profiles.length && !refs.devices.length,
    `Verziju ${v.version} koriste: ${[...refs.profiles.map((p) => `konfiguracija „${p.name}"`), ...refs.devices.map((d) => `uređaj „${d.name}"`)].slice(0, 5).join(', ')} — najprije je tamo promijenite.`,
  );
  await tx.mdmAppVersion.delete({ where: { id: versionId } });
  await tx.mdmFile.delete({ where: { id: v.fileId } });
  await bumpAppConfigs(tx, scope.companyId, app.id);
  await audit(tx, actor, { entity: 'mdmApp', entityId: app.id, action: 'delete-version', summary: `Aplikacija ${app.name}: obrisana verzija ${v.version}` });
  return v.file.storageKey;
}

/** Brisanje cijele aplikacije (sve verzije), ako je nijedna konfiguracija ne koristi. */
export async function deleteApp(tx: Tx, scope: MdmScope, actor: Actor, id: string) {
  const app = await findAppForEdit(tx, scope, id);
  const refs = await appReferences(tx, scope.companyId, { appId: id });
  assert(!refs.profiles.length && !refs.devices.length, `Aplikaciju koriste konfiguracije/uređaji (${refs.profiles.length + refs.devices.length}) — najprije je tamo uklonite.`);
  const versions = await tx.mdmAppVersion.findMany({ where: { appId: id }, include: { file: { select: { id: true, storageKey: true } } } });
  await tx.mdmAppVersion.deleteMany({ where: { appId: id } });
  await tx.mdmFile.deleteMany({ where: { id: { in: versions.map((v) => v.file.id) } } });
  await tx.mdmApp.delete({ where: { id } });
  await audit(tx, actor, { entity: 'mdmApp', entityId: id, action: 'delete', summary: `Obrisana aplikacija ${app.name} (${versions.length} verzija)` });
  return versions.map((v) => v.file.storageKey);
}

/** Naredba INSTALL_APP za jedan uređaj (odabrana ili najnovija verzija). */
export async function installOnDevice(tx: Tx, scope: MdmScope, deviceId: string, appId: string, versionId: string | null) {
  const app = await findApp(tx, scope, appId);
  const device = await tx.mdmDevice.findFirst({ where: { AND: [{ id: deviceId }, deviceWhere(scope)] }, select: { id: true, platform: true } });
  if (!device) throw new AuthError('Uređaj nije dostupan.', 403);
  assert(app.platform === device.platform, 'Aplikacija je za drugu platformu.');
  const v = await tx.mdmAppVersion.findFirst({
    where: { appId, ...(versionId ? { id: versionId } : {}) },
    include: { file: { select: { id: true, sha256: true } } },
    orderBy: [{ versionCode: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  });
  assert(v, 'Aplikacija nema nijednu verziju.');
  const payload: Prisma.InputJsonValue = {
    appId: app.id,
    versionId: v.id,
    packageName: app.packageName,
    name: app.name,
    version: v.version,
    versionCode: v.versionCode,
    downloadPath: `/api/mdm/agent/files/${v.file.id}`,
    sha256: v.file.sha256,
    installArgs: app.installArgs,
  };
  return queueCommands(tx, scope, [device.id], 'INSTALL_APP', payload);
}

export async function uninstallOnDevice(tx: Tx, scope: MdmScope, deviceId: string, packageName: string, name: string | null) {
  assert(/^[^\u0000-\u001f\"]{1,200}$/.test(packageName), 'Neispravan naziv paketa.');
  return queueCommands(tx, scope, [deviceId], 'UNINSTALL_APP', { packageName, name: name ?? packageName });
}
