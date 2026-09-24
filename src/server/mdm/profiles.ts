import 'server-only';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { audit } from '../audit';
import { AuthError, DomainError, assert } from '../errors';
import type { SessionUser } from '../auth';
import { bumpConfig, deviceProfile } from './config';
import { assertOrgInScope, canEditShared, deviceWhere, orgWhere, sharedWhere, type MdmScope } from './scope';
import { mergeConfig, type DeviceOverrides, type ProfileApp, type ProfileSettings, type WifiNetwork } from '@/domain/mdm';

/**
 * Konfiguracije (profili) i izmjene na uređaju: provjera ulaza, lozinke Wi-Fi
 * mreža (nikad se ne vraćaju u preglednik), dodjela lokacijama i podizanje
 * verzije konfiguracije pogođenih uređaja.
 */

export type Actor = Pick<SessionUser, 'id' | 'name' | 'companyId'>;

// ---------------------------------------------------------------- sheme

export const RESTRICTION_KEYS = ['noInstallApps', 'noSettings', 'noPlayStore', 'noUsbFileTransfer', 'noFactoryReset', 'noCamera', 'noStatusBar'] as const;

const zNullInt = (min: number, max: number) => z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(min).max(max).nullable());
const zNullStr = (max: number) => z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : v ?? null), z.string().max(max).nullable());

/** Wi-Fi iz obrasca: prazna lozinka = zadrži postojeću (prepoznaje se po `origSsid`). */
export const zWifi = z.object({
  ssid: z.string().trim().min(1, 'SSID je obavezan').max(32, 'SSID ima najviše 32 znaka'),
  security: z.enum(['NONE', 'WPA2', 'WPA3']),
  password: z.string().max(63, 'Lozinka ima najviše 63 znaka').optional().default(''),
  hidden: z.boolean().optional().default(false),
  origSsid: z.string().nullable().optional(),
});
export type WifiInput = z.infer<typeof zWifi>;

export const zSettings = z.object({
  kiosk: z.boolean().optional().default(false),
  adb: z.boolean().optional().default(false),
  restrictions: z.object(Object.fromEntries(RESTRICTION_KEYS.map((k) => [k, z.boolean().optional()])) as Record<(typeof RESTRICTION_KEYS)[number], z.ZodOptional<z.ZodBoolean>>).optional().default({}),
  wifi: z.array(zWifi).max(20, 'Najviše 20 mreža').optional().default([]),
  maintenancePin: z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : v ?? null), z.string().regex(/^\d{4,8}$/, 'PIN ima 4–8 znamenki').nullable()),
  screenTimeoutSec: zNullInt(0, 86_400),
  volumePct: zNullInt(0, 100),
  timezone: zNullStr(64),
  systemUpdates: z.preprocess((v) => (v === '' ? null : v ?? null), z.enum(['AUTOMATIC', 'WINDOWED', 'POSTPONE']).nullable()),
});
export type SettingsInput = z.infer<typeof zSettings>;

export const zProfileApp = z.object({
  appId: z.string().min(1),
  versionId: z.preprocess((v) => (v === '' ? null : v ?? null), z.string().nullable()),
  config: z.record(z.string().trim().min(1).max(100), z.string().max(2000)).optional().default({}),
  hidden: z.boolean().optional().default(false),
  autoStart: z.boolean().optional().default(false),
  remove: z.boolean().optional().default(false),
});

export const zConfig = z.object({ settings: zSettings, apps: z.array(zProfileApp).max(100, 'Najviše 100 aplikacija') });
export type ConfigInput = z.infer<typeof zConfig>;

export const zProfile = zConfig.extend({
  id: z.string().nullable().optional(),
  name: z.string().trim().min(1, 'Naziv je obavezan').max(120),
  platform: z.enum(['ANDROID', 'WINDOWS']),
  orgId: z.preprocess((v) => (v === '' ? null : v ?? null), z.string().nullable()),
  note: zNullStr(2000),
});
export type ProfileInput = z.infer<typeof zProfile>;

// ---------------------------------------------------------------- pomoćne (čiste)

/** Lozinke Wi-Fi mreža se ne šalju u preglednik — samo oznaka da postoji. */
export interface MaskedWifi {
  ssid: string;
  security: WifiNetwork['security'];
  hidden: boolean;
  hasPassword: boolean;
  origSsid: string;
  password: string;
}
export const maskWifi = (list: WifiNetwork[] | undefined): MaskedWifi[] =>
  (list ?? []).map((w) => ({ ssid: w.ssid, security: w.security, hidden: !!w.hidden, hasPassword: !!w.password, origSsid: w.ssid, password: '' }));

/** Postavke za prikaz (JSON pregled, preglednik): lozinke i PIN zamijenjeni s „••••". */
export function redactSettings(s: ProfileSettings): ProfileSettings {
  return {
    ...s,
    ...(s.wifi ? { wifi: s.wifi.map((w) => (w.password ? { ...w, password: '••••' } : w)) } : {}),
    ...(s.maintenancePin ? { maintenancePin: '••••' } : {}),
  };
}

/** PIN za održavanje vidi samo tko smije uređivati (kao na pregledu uređaja). */
export const pinFor = (s: ProfileSettings, canEdit: boolean): ProfileSettings => (canEdit ? s : { ...s, maintenancePin: undefined });

/** Nova lista mreža: prazna lozinka preuzima staru (po izvornom SSID-u). */
export function resolveWifi(next: WifiInput[], prev: WifiNetwork[] | undefined): WifiNetwork[] {
  const seen = new Set<string>();
  return next.map((w) => {
    assert(!seen.has(w.ssid), `Mreža „${w.ssid}" je navedena dvaput.`);
    seen.add(w.ssid);
    const out: WifiNetwork = { ssid: w.ssid, security: w.security, ...(w.hidden ? { hidden: true } : {}) };
    if (w.security === 'NONE') return out;
    const password = w.password || prev?.find((p) => p.ssid === (w.origSsid ?? w.ssid))?.password;
    assert(password, `Mreža „${w.ssid}": upišite lozinku.`);
    assert(password.length >= 8, `Mreža „${w.ssid}": lozinka ima najmanje 8 znakova.`);
    return { ...out, password };
  });
}

/** Postavke profila: bez praznih vrijednosti; restrikcije samo uključene. */
export function normalizeSettings(s: SettingsInput, wifi: WifiNetwork[], startApp: string | null): ProfileSettings {
  const out: ProfileSettings = {};
  if (s.kiosk) out.kiosk = true;
  if (s.adb) out.adb = true;
  const r = Object.fromEntries(Object.entries(s.restrictions).filter(([, v]) => v));
  if (Object.keys(r).length) out.restrictions = r;
  if (wifi.length) out.wifi = wifi;
  if (startApp) out.startApp = startApp;
  for (const k of ['maintenancePin', 'screenTimeoutSec', 'volumePct', 'timezone', 'systemUpdates'] as const) {
    if (s[k] !== null && s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k];
  }
  return out;
}

export function normalizeApps(apps: ConfigInput['apps']): ProfileApp[] {
  const seen = new Set<string>();
  assert(apps.filter((a) => a.autoStart && !a.remove).length <= 1, 'Samo jedna aplikacija se pokreće nakon paljenja.');
  return apps.map((a) => {
    assert(!seen.has(a.appId), 'Aplikacija je navedena dvaput.');
    seen.add(a.appId);
    const out: ProfileApp = { appId: a.appId };
    if (a.versionId) out.versionId = a.versionId;
    if (Object.keys(a.config).length) out.config = a.config;
    if (a.hidden) out.hidden = true;
    if (a.autoStart && !a.remove) out.autoStart = true;
    if (a.remove) out.remove = true;
    return out;
  });
}

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a: unknown, b: unknown) => stable(a ?? null) === stable(b ?? null);
const appKey = (a: ProfileApp) => ({ versionId: a.versionId ?? null, config: a.config ?? {}, hidden: !!a.hidden, autoStart: !!a.autoStart, remove: !!a.remove });

/**
 * Izmjene uređaja = samo ono što se razlikuje od profila. `edited` je cijela
 * konfiguracija kakvu korisnik vidi (profil + dosadašnje izmjene + promjene).
 */
export function diffOverrides(profile: { settings: ProfileSettings; apps: ProfileApp[] }, edited: { settings: ProfileSettings; apps: ProfileApp[] }): DeviceOverrides {
  const ps = profile.settings;
  const es = edited.settings;
  const settings: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(ps), ...Object.keys(es)].filter((k) => k !== 'restrictions'));
  for (const k of keys) {
    const a = ps[k] ?? null;
    const b = es[k] ?? null;
    if (k === 'kiosk' || k === 'adb') {
      if (!!a !== !!b) settings[k] = !!b;
    } else if (!same(a, b)) settings[k] = k === 'wifi' ? (b ?? []) : b;
  }
  const restrictions: Record<string, boolean> = {};
  for (const k of RESTRICTION_KEYS) {
    const a = !!ps.restrictions?.[k];
    const b = !!es.restrictions?.[k];
    if (a !== b) restrictions[k] = b;
  }
  if (Object.keys(restrictions).length) settings.restrictions = restrictions;
  const byId = new Map(profile.apps.map((a) => [a.appId, a]));
  const apps = edited.apps.filter((a) => {
    const p = byId.get(a.appId);
    return !p || !same(appKey(p), appKey(a));
  }).map((a) => ({ appId: a.appId, versionId: a.versionId ?? null, config: a.config ?? {}, hidden: !!a.hidden, autoStart: !!a.autoStart, remove: !!a.remove }));
  const out: DeviceOverrides = {};
  if (Object.keys(settings).length) out.settings = settings as Partial<ProfileSettings>;
  if (apps.length) out.apps = apps;
  return out;
}

// ---------------------------------------------------------------- provjere nad bazom

/** Organizacije koje smiju koristiti resurs organizacije `orgId`: ona i njeni klijenti. */
async function orgUsable(tx: Tx, resourceOrgId: string | null, targetOrgId: string | null) {
  if (resourceOrgId === null) return true;
  if (!targetOrgId) return false;
  if (resourceOrgId === targetOrgId) return true;
  const t = await tx.mdmOrg.findUnique({ where: { id: targetOrgId }, select: { parentId: true } });
  return t?.parentId === resourceOrgId;
}

/** Aplikacije iz konfiguracije: u opsegu, iste platforme, dostupne organizaciji konfiguracije. */
export async function validateApps(tx: Tx, scope: MdmScope, platform: 'ANDROID' | 'WINDOWS', ownerOrgId: string | null, apps: ProfileApp[]) {
  if (!apps.length) return;
  const rows = await tx.mdmApp.findMany({
    where: { AND: [{ id: { in: apps.map((a) => a.appId) } }, sharedWhere(scope)] },
    select: { id: true, name: true, orgId: true, platform: true, versions: { select: { id: true } } },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const a of apps) {
    const app = byId.get(a.appId);
    if (!app) throw new AuthError('Aplikacija nije dostupna.', 403);
    assert(app.platform === platform, `Aplikacija „${app.name}" nije za ovu platformu.`);
    assert(await orgUsable(tx, app.orgId, ownerOrgId), `Aplikacija „${app.name}" pripada drugoj organizaciji.`);
    if (a.versionId) assert(app.versions.some((v) => v.id === a.versionId), `Odabrana verzija aplikacije „${app.name}" ne postoji.`);
  }
}

/** Profil za čitanje (u opsegu). */
export async function findProfile(tx: Tx, scope: MdmScope, id: string) {
  const p = await tx.mdmProfile.findFirst({ where: { AND: [{ id }, sharedWhere(scope)] } });
  if (!p) throw new AuthError('Konfiguracija nije dostupna.', 403);
  return p;
}

/** Profil za izmjenu: zajedničke (orgId null) mijenja samo vlasnik sustava. */
export async function findProfileForEdit(tx: Tx, scope: MdmScope, id: string) {
  const p = await findProfile(tx, scope, id);
  if (!canEditShared(scope, p.orgId)) throw new AuthError('Zajedničku konfiguraciju mijenja samo vlasnik sustava.', 403);
  return p;
}

// ---------------------------------------------------------------- radnje

export async function saveProfile(tx: Tx, scope: MdmScope, actor: Actor, input: ProfileInput) {
  const existing = input.id ? await findProfileForEdit(tx, scope, input.id) : null;
  const platform = existing?.platform ?? input.platform;
  const orgId = existing ? existing.orgId : input.orgId;
  if (!existing) {
    if (orgId === null) {
      if (!scope.owner) throw new AuthError('Zajedničku konfiguraciju stvara samo vlasnik sustava.', 403);
    } else {
      assertOrgInScope(scope, orgId);
      const org = await tx.mdmOrg.findFirst({ where: { AND: [{ id: orgId }, orgWhere(scope)] }, select: { id: true } });
      if (!org) throw new AuthError('Organizacija nije dostupna.', 403);
    }
  }
  const apps = normalizeApps(input.apps);
  await validateApps(tx, scope, platform, orgId, apps);
  const wifi = resolveWifi(input.settings.wifi, (existing?.settings as ProfileSettings | undefined)?.wifi);
  const startApp = apps.find((a) => a.autoStart)?.appId ?? null;
  const settings = normalizeSettings(input.settings, wifi, startApp);
  const data = {
    name: input.name,
    note: input.note,
    settings: settings as Prisma.InputJsonValue,
    apps: apps as unknown as Prisma.InputJsonValue,
  };
  const saved = existing
    ? await tx.mdmProfile.update({ where: { id: existing.id }, data: { ...data, version: { increment: 1 } } })
    : await tx.mdmProfile.create({ data: { ...data, companyId: scope.companyId, orgId, platform } });
  const affected = existing ? await bumpConfig(tx, { profileId: saved.id }) : 0;
  await audit(tx, actor, {
    entity: 'mdmProfile',
    entityId: saved.id,
    action: existing ? 'update' : 'create',
    summary: `${existing ? 'Izmijenjena' : 'Nova'} MDM konfiguracija ${saved.name} (v${saved.version}, uređaja: ${affected})`,
  });
  return { id: saved.id, version: saved.version, affected };
}

/** Lokacije na kojima vrijedi profil: odabrane dobivaju profil, ostale u opsegu ga gube. */
export async function assignSites(tx: Tx, scope: MdmScope, actor: Actor, profileId: string, siteIds: string[]) {
  const p = await findProfile(tx, scope, profileId);
  const inScope = { org: orgWhere(scope) };
  const wanted = siteIds.length ? await tx.mdmSite.findMany({ where: { id: { in: siteIds }, ...inScope }, select: { id: true, orgId: true, name: true, profileId: true } }) : [];
  if (wanted.length !== new Set(siteIds).size) throw new AuthError('Neke lokacije nisu dostupne.', 403);
  for (const s of wanted) assert(await orgUsable(tx, p.orgId, s.orgId), `Konfiguracija ne pripada organizaciji lokacije „${s.name}".`);
  const current = await tx.mdmSite.findMany({ where: { profileId, ...inScope }, select: { id: true } });
  const add = wanted.filter((s) => s.profileId !== profileId).map((s) => s.id);
  const drop = current.map((s) => s.id).filter((id) => !siteIds.includes(id));
  if (add.length) await tx.mdmSite.updateMany({ where: { id: { in: add } }, data: { profileId } });
  if (drop.length) await tx.mdmSite.updateMany({ where: { id: { in: drop } }, data: { profileId: null } });
  const affected = await bumpConfig(tx, { siteIds: [...add, ...drop], platform: p.platform });
  await audit(tx, actor, { entity: 'mdmProfile', entityId: profileId, action: 'assign', summary: `Konfiguracija ${p.name}: lokacija +${add.length} / −${drop.length}` });
  return { added: add.length, removed: drop.length, affected };
}

export async function duplicateProfile(tx: Tx, scope: MdmScope, actor: Actor, id: string) {
  const p = await findProfile(tx, scope, id);
  // vanjski korisnik kopiju zajedničkog profila dobiva u svoju organizaciju
  const orgId = canEditShared(scope, p.orgId) ? p.orgId : scope.homeOrgId;
  if (!scope.owner) assertOrgInScope(scope, orgId);
  const copy = await tx.mdmProfile.create({
    data: {
      companyId: scope.companyId,
      orgId,
      platform: p.platform,
      name: `${p.name} (kopija)`.slice(0, 120),
      note: p.note,
      settings: p.settings as Prisma.InputJsonValue,
      apps: p.apps as Prisma.InputJsonValue,
    },
  });
  await audit(tx, actor, { entity: 'mdmProfile', entityId: copy.id, action: 'create', summary: `Kopija MDM konfiguracije ${p.name}` });
  return { id: copy.id };
}

export async function deleteProfile(tx: Tx, scope: MdmScope, actor: Actor, id: string) {
  const p = await findProfileForEdit(tx, scope, id);
  const [sites, devices] = await Promise.all([tx.mdmSite.count({ where: { profileId: id } }), tx.mdmDevice.count({ where: { profileId: id } })]);
  assert(!sites && !devices, `Konfiguracija je dodijeljena (lokacija: ${sites}, uređaja: ${devices}) — najprije je uklonite.`);
  await tx.mdmProfile.delete({ where: { id } });
  await audit(tx, actor, { entity: 'mdmProfile', entityId: id, action: 'delete', summary: `Obrisana MDM konfiguracija ${p.name}` });
}

// ---------------------------------------------------------------- uređaj

async function deviceForEdit(tx: Tx, scope: MdmScope, deviceId: string) {
  const d = await tx.mdmDevice.findFirst({ where: { AND: [{ id: deviceId }, deviceWhere(scope)] } });
  if (!d) throw new AuthError('Uređaj nije dostupan.', 403);
  return d;
}

/** Vlastiti profil uređaja (null = profil lokacije). */
export async function setDeviceProfile(tx: Tx, scope: MdmScope, actor: Actor, deviceId: string, profileId: string | null) {
  const d = await deviceForEdit(tx, scope, deviceId);
  if (profileId) {
    const p = await findProfile(tx, scope, profileId);
    assert(p.platform === d.platform, 'Konfiguracija je za drugu platformu.');
    assert(await orgUsable(tx, p.orgId, d.orgId), 'Konfiguracija ne pripada organizaciji uređaja.');
  }
  await tx.mdmDevice.update({ where: { id: d.id }, data: { profileId } });
  await bumpConfig(tx, { deviceIds: [d.id] });
  await audit(tx, actor, { entity: 'mdmDevice', entityId: d.id, action: 'profile', summary: `Uređaj ${d.name}: ${profileId ? 'vlastita konfiguracija' : 'konfiguracija lokacije'}` });
}

/** Izmjene uređaja: iz cijele uređene konfiguracije sprema se samo razlika od profila. */
export async function saveDeviceOverrides(tx: Tx, scope: MdmScope, actor: Actor, deviceId: string, input: ConfigInput) {
  const d = await deviceForEdit(tx, scope, deviceId);
  const profile = await deviceProfile(tx, d);
  const base = { settings: (profile?.settings ?? {}) as ProfileSettings, apps: (profile?.apps ?? []) as unknown as ProfileApp[] };
  const current = mergeConfig(base, d.overrides as DeviceOverrides);
  const apps = normalizeApps(input.apps);
  await validateApps(tx, scope, d.platform, d.orgId, apps.filter((a) => !base.apps.some((b) => b.appId === a.appId)));
  // aplikacije iz profila ne mogu se ukloniti s popisa — samo označiti za uklanjanje
  for (const b of base.apps) assert(apps.some((a) => a.appId === b.appId), 'Aplikacija iz konfiguracije se ne briše s popisa — označite „Ukloni".');
  const wifi = resolveWifi(input.settings.wifi, current.settings.wifi);
  const settings = normalizeSettings(input.settings, wifi, apps.find((a) => a.autoStart)?.appId ?? null);
  const overrides = diffOverrides(base, { settings, apps });
  await tx.mdmDevice.update({ where: { id: d.id }, data: { overrides: overrides as Prisma.InputJsonValue } });
  await bumpConfig(tx, { deviceIds: [d.id] });
  await audit(tx, actor, { entity: 'mdmDevice', entityId: d.id, action: 'overrides', summary: `Izmjene konfiguracije uređaja ${d.name}`, diff: { overrides: redactOverrides(overrides) } as unknown as Prisma.InputJsonValue });
  return overrides;
}

export async function clearDeviceOverrides(tx: Tx, scope: MdmScope, actor: Actor, deviceId: string) {
  const d = await deviceForEdit(tx, scope, deviceId);
  await tx.mdmDevice.update({ where: { id: d.id }, data: { overrides: {} } });
  await bumpConfig(tx, { deviceIds: [d.id] });
  await audit(tx, actor, { entity: 'mdmDevice', entityId: d.id, action: 'overrides', summary: `Uklonjene izmjene konfiguracije uređaja ${d.name}` });
}

export const redactOverrides = (o: DeviceOverrides): DeviceOverrides => (o.settings ? { ...o, settings: redactSettings(o.settings as ProfileSettings) } : o);
