import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { plain } from '../plain';
import { buildEffectiveConfig, deviceProfile } from '../mdm/config';
import { canEditShared, deviceWhere, orgWhere, sharedWhere, type MdmScope } from '../mdm/scope';
import { appReferences } from '../mdm/apps';
import { maskWifi, pinFor, redactSettings } from '../mdm/profiles';
import { mergeConfig, type DeviceOverrides, type Platform, type ProfileApp, type ProfileSettings } from '@/domain/mdm';
import { toEditor, type LibraryApp } from '@/components/mdm/config-model';
import { escapeLike } from '@/lib/like';

/**
 * Čitanja za knjižnicu MDM-a: konfiguracije (profili), aplikacije, datoteke,
 * dokumenti te konfiguracija i aplikacije pojedinog uređaja. Sve kroz opseg.
 */

type Params = Record<string, string | string[] | undefined>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const platformParam = (v: unknown): Platform | null => (v === 'ANDROID' || v === 'WINDOWS' ? v : null);

/** Organizacije koje smiju koristiti resurs: null (zajednički), ona sama i njen distributer. */
async function usableOrgIds(orgId: string | null): Promise<(string | null)[]> {
  if (!orgId) return [null];
  const o = await db.mdmOrg.findUnique({ where: { id: orgId }, select: { parentId: true } });
  return [null, orgId, ...(o?.parentId ? [o.parentId] : [])];
}

const activeDevice: Prisma.MdmDeviceWhereInput = { status: { not: 'RETIRED' } };

/**
 * Broj uređaja po profilu: vlastiti profil + uređaji na lokacijama s tim profilom (bez vlastitog).
 * Broje se samo uređaji iste platforme kao profil (lokacija ima jedan profil, a može imati
 * uređaje obiju platformi).
 */
async function profileDeviceCounts(scope: MdmScope, profiles: { id: string; platform: Platform }[]) {
  const out = new Map<string, number>(profiles.map((p) => [p.id, 0]));
  if (!profiles.length) return out;
  const ids = profiles.map((p) => p.id);
  const platformOf = new Map(profiles.map((p) => [p.id, p.platform]));
  const [direct, sites] = await Promise.all([
    db.mdmDevice.groupBy({ by: ['profileId'], where: { AND: [deviceWhere(scope), activeDevice, { profileId: { in: ids } }] }, _count: { _all: true } }),
    db.mdmSite.findMany({ where: { profileId: { in: ids }, org: orgWhere(scope) }, select: { id: true, profileId: true } }),
  ]);
  for (const d of direct) out.set(d.profileId!, (out.get(d.profileId!) ?? 0) + d._count._all);
  if (sites.length) {
    const bySite = await db.mdmDevice.groupBy({ by: ['siteId', 'platform'], where: { AND: [deviceWhere(scope), activeDevice, { profileId: null, siteId: { in: sites.map((s) => s.id) } }] }, _count: { _all: true } });
    const siteProfile = new Map(sites.map((s) => [s.id, s.profileId!]));
    for (const d of bySite) {
      const p = siteProfile.get(d.siteId!)!;
      if (platformOf.get(p) === d.platform) out.set(p, (out.get(p) ?? 0) + d._count._all);
    }
  }
  return out;
}

// ---------------------------------------------------------------- konfiguracije

export async function listProfiles(scope: MdmScope, params: Params, page: { skip: number; take: number }) {
  const q = str(params.q);
  const platform = platformParam(params.platform);
  const where: Prisma.MdmProfileWhereInput = {
    AND: [sharedWhere(scope), ...(q ? [{ name: { contains: escapeLike(q), mode: 'insensitive' as const } }] : []), ...(platform ? [{ platform }] : [])],
  };
  const [rows, total] = await Promise.all([
    db.mdmProfile.findMany({
      where,
      select: { id: true, name: true, platform: true, orgId: true, version: true, updatedAt: true, note: true, org: { select: { name: true } } },
      orderBy: [{ orgId: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }],
      skip: page.skip,
      take: page.take,
    }),
    db.mdmProfile.count({ where }),
  ]);
  const ids = rows.map((r) => r.id);
  const [devices, sites] = await Promise.all([
    profileDeviceCounts(scope, rows),
    db.mdmSite.groupBy({ by: ['profileId'], where: { profileId: { in: ids }, org: orgWhere(scope) }, _count: { _all: true } }),
  ]);
  const siteCount = new Map(sites.map((s) => [s.profileId!, s._count._all]));
  return {
    total,
    rows: rows.map((r) => ({ ...plain(r), devices: devices.get(r.id) ?? 0, sites: siteCount.get(r.id) ?? 0, canEdit: canEditShared(scope, r.orgId) })),
  };
}

/** Aplikacije iz knjižnice koje konfiguracija organizacije `orgId` smije koristiti. */
export async function libraryFor(scope: MdmScope, platform: Platform, orgId: string | null): Promise<LibraryApp[]> {
  const usable = await usableOrgIds(orgId);
  const apps = await db.mdmApp.findMany({
    where: { AND: [sharedWhere(scope), { platform }, { OR: usable.map((o) => ({ orgId: o })) }] },
    select: {
      id: true,
      name: true,
      packageName: true,
      platform: true,
      orgId: true,
      versions: { select: { id: true, version: true, versionCode: true, createdAt: true }, orderBy: [{ versionCode: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }] },
    },
    orderBy: { name: 'asc' },
  });
  return apps.map((a) => ({ id: a.id, name: a.name, packageName: a.packageName, platform: a.platform, shared: a.orgId === null, versions: a.versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })) }));
}

/** Lokacije u opsegu koje smiju koristiti profil (organizacija profila i njeni klijenti). */
async function sitesFor(scope: MdmScope, profile: { id: string; orgId: string | null; platform: Platform }) {
  const orgFilter: Prisma.MdmOrgWhereInput = profile.orgId ? { AND: [orgWhere(scope), { OR: [{ id: profile.orgId }, { parentId: profile.orgId }] }] } : orgWhere(scope);
  const sites = await db.mdmSite.findMany({
    where: { org: orgFilter },
    select: {
      id: true,
      name: true,
      profileId: true,
      org: { select: { name: true } },
      profile: { select: { name: true } },
      devices: { where: activeDevice, select: { platform: true } },
    },
    orderBy: [{ org: { name: 'asc' } }, { name: 'asc' }],
    take: 2000,
  });
  return sites.map((s) => ({
    id: s.id,
    name: s.name,
    org: s.org.name,
    devices: s.devices.filter((d) => d.platform === profile.platform).length,
    otherPlatform: s.devices.filter((d) => d.platform !== profile.platform).length,
    assigned: s.profileId === profile.id, otherProfile: s.profileId && s.profileId !== profile.id ? (s.profile?.name ?? null) : null }));
}

export async function profileEditor(scope: MdmScope, id: string) {
  const p = await db.mdmProfile.findFirst({ where: { AND: [{ id }, sharedWhere(scope)] }, include: { org: { select: { name: true } } } });
  if (!p) return null;
  const settings = p.settings as ProfileSettings;
  const apps = p.apps as unknown as ProfileApp[];
  const [library, sites, counts] = await Promise.all([libraryFor(scope, p.platform, p.orgId), sitesFor(scope, p), profileDeviceCounts(scope, [p])]);
  return {
    profile: { id: p.id, name: p.name, platform: p.platform, orgId: p.orgId, orgName: p.org?.name ?? null, note: p.note, version: p.version, updatedAt: p.updatedAt.toISOString() },
    editor: toEditor(pinFor(settings, scope.level === 'edit' && canEditShared(scope, p.orgId)), apps, maskWifi(settings.wifi)),
    library,
    sites,
    devices: counts.get(p.id) ?? 0,
    canEdit: canEditShared(scope, p.orgId),
  };
}

// ---------------------------------------------------------------- aplikacije

export async function listApps(scope: MdmScope, params: Params, page: { skip: number; take: number }) {
  const q = str(params.q);
  const platform = platformParam(params.platform);
  const where: Prisma.MdmAppWhereInput = {
    AND: [
      sharedWhere(scope),
      ...(q ? [{ OR: [{ name: { contains: escapeLike(q), mode: 'insensitive' as const } }, { packageName: { contains: escapeLike(q), mode: 'insensitive' as const } }] }] : []),
      ...(platform ? [{ platform }] : []),
    ],
  };
  const [rows, total] = await Promise.all([
    db.mdmApp.findMany({
      where,
      select: {
        id: true,
        name: true,
        packageName: true,
        platform: true,
        orgId: true,
        org: { select: { name: true } },
        _count: { select: { versions: true } },
        versions: { select: { version: true, createdAt: true, file: { select: { size: true } } }, orderBy: [{ versionCode: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], take: 1 },
      },
      orderBy: { name: 'asc' },
      skip: page.skip,
      take: page.take,
    }),
    db.mdmApp.count({ where }),
  ]);
  return { total, rows: rows.map((r) => ({ ...plain(r), canEdit: canEditShared(scope, r.orgId) })) };
}

export async function appDetail(scope: MdmScope, id: string) {
  const app = await db.mdmApp.findFirst({
    where: { AND: [{ id }, sharedWhere(scope)] },
    include: {
      org: { select: { name: true } },
      versions: {
        include: { file: { select: { id: true, name: true, size: true, sha256: true, createdBy: true } } },
        orderBy: [{ versionCode: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      },
    },
  });
  if (!app) return null;
  const refs = await appReferences(db, scope.companyId, { appId: id });
  const profileIds = refs.profiles.map((p) => p.id);
  // konfiguracije izvan opsega (npr. drugog distributera) samo se broje, bez naziva
  const profiles = await db.mdmProfile.findMany({ where: { AND: [{ id: { in: profileIds } }, sharedWhere(scope)] }, select: { id: true, name: true, apps: true, platform: true } });
  // koja verzija je gdje zadana (ili „najnovija")
  const pinned = new Map<string, string[]>();
  for (const p of profiles) {
    const entry = (p.apps as unknown as ProfileApp[]).find((a) => a.appId === id);
    const key = entry?.versionId ?? 'latest';
    pinned.set(key, [...(pinned.get(key) ?? []), p.name]);
  }
  const counts = await profileDeviceCounts(scope, profiles);
  const visibleDevices = await db.mdmDevice.findMany({ where: { AND: [{ id: { in: refs.devices.map((d) => d.id) } }, deviceWhere(scope)] }, select: { id: true, name: true } });
  return {
    app: plain({ ...app, versions: app.versions.map((v) => ({ ...v, usedBy: pinned.get(v.id) ?? [] })) }),
    latestUsedBy: pinned.get('latest') ?? [],
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, devices: counts.get(p.id) ?? 0 })),
    devices: visibleDevices,
    hiddenRefs: refs.devices.length - visibleDevices.length + refs.profiles.length - profiles.length,
    canEdit: canEditShared(scope, app.orgId),
  };
}

// ---------------------------------------------------------------- datoteke i dokumenti

export async function listLibraryFiles(scope: MdmScope, kind: 'FILE' | 'DOC', params: Params, page: { skip: number; take: number }) {
  const q = str(params.q);
  const where: Prisma.MdmFileWhereInput = { AND: [sharedWhere(scope), { kind }, ...(q ? [{ name: { contains: escapeLike(q), mode: 'insensitive' as const } }] : [])] };
  const [rows, total] = await Promise.all([
    db.mdmFile.findMany({
      where,
      select: { id: true, name: true, mime: true, size: true, sha256: true, orgId: true, createdBy: true, createdAt: true, org: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
      skip: page.skip,
      take: page.take,
    }),
    db.mdmFile.count({ where }),
  ]);
  return { total, rows: rows.map((r) => ({ ...plain(r), canEdit: canEditShared(scope, r.orgId) })) };
}

/** Uređaji i lokacije za „Pošalji na uređaje" (samo upisani). */
export async function pushTargets(scope: MdmScope) {
  const [devices, sites] = await Promise.all([
    db.mdmDevice.findMany({
      where: { AND: [deviceWhere(scope), { status: 'ENROLLED' }] },
      select: { id: true, name: true, platform: true, site: { select: { name: true } }, org: { select: { name: true } } },
      orderBy: { name: 'asc' },
      take: 1000,
    }),
    db.mdmSite.findMany({ where: { org: orgWhere(scope) }, select: { id: true, name: true, org: { select: { name: true } }, _count: { select: { devices: { where: { status: 'ENROLLED' } } } } }, orderBy: { name: 'asc' }, take: 1000 }),
  ]);
  return {
    devices: devices.map((d) => ({ id: d.id, name: d.name, platform: d.platform, where: [d.org?.name, d.site?.name].filter(Boolean).join(' › ') })),
    sites: sites.map((s) => ({ id: s.id, name: s.name, org: s.org.name, devices: s._count.devices })),
  };
}

// ---------------------------------------------------------------- uređaj

async function loadDevice(scope: MdmScope, id: string) {
  return db.mdmDevice.findFirst({ where: { AND: [{ id }, deviceWhere(scope)] }, include: { site: { select: { id: true, name: true, profile: { select: { id: true, name: true } } } } } });
}

export async function deviceConfig(scope: MdmScope, id: string) {
  const d = await loadDevice(scope, id);
  if (!d) return null;
  const profile = await deviceProfile(db, d);
  const base = { settings: (profile?.settings ?? {}) as ProfileSettings, apps: (profile?.apps ?? []) as unknown as ProfileApp[] };
  const overrides = d.overrides as DeviceOverrides;
  const merged = mergeConfig(base, overrides);
  const effective = await buildEffectiveConfig(db, d);
  const usable = await usableOrgIds(d.orgId);
  const profiles = await db.mdmProfile.findMany({
    where: { AND: [sharedWhere(scope), { platform: d.platform }, { OR: usable.map((o) => ({ orgId: o })) }] },
    select: { id: true, name: true, orgId: true },
    orderBy: { name: 'asc' },
  });
  const pendingApply = await db.mdmCommand.count({ where: { deviceId: d.id, type: 'APPLY_CONFIG', status: { in: ['PENDING', 'SENT'] } } });
  return {
    device: { id: d.id, name: d.name, platform: d.platform, status: d.status, configVersion: d.configVersion, appliedConfigVersion: d.appliedConfigVersion, profileId: d.profileId, lastSeenAt: d.lastSeenAt?.toISOString() ?? null },
    site: d.site ? { id: d.site.id, name: d.site.name, profile: d.site.profile } : null,
    profile: profile ? { id: profile.id, name: profile.name, version: profile.version, own: !!d.profileId, editable: canEditShared(scope, profile.orgId) } : null,
    profiles,
    editor: toEditor(pinFor(merged.settings, scope.level === 'edit'), merged.apps, maskWifi(merged.settings.wifi)),
    inherited: base.apps.map((a) => a.appId),
    hasOverrides: !!(overrides.settings && Object.keys(overrides.settings).length) || !!overrides.apps?.length,
    overridesJson: JSON.stringify({ ...overrides, ...(overrides.settings ? { settings: redactSettings(overrides.settings as ProfileSettings) } : {}) }, null, 2),
    effectiveJson: JSON.stringify({ ...effective, settings: redactSettings(effective.settings) }, null, 2),
    library: await libraryFor(scope, d.platform, d.orgId),
    pendingApply,
  };
}

export type AppState = 'INSTALLED' | 'OUTDATED' | 'MISSING' | 'REMOVE' | 'EXTRA';

/** Instalirane aplikacije (telemetrija) uspoređene s konfiguracijom. */
export async function deviceApps(scope: MdmScope, id: string) {
  const d = await loadDevice(scope, id);
  if (!d) return null;
  const effective = await buildEffectiveConfig(db, d);
  const reported = ((d.telemetry as { apps?: Array<{ packageName: string; name?: string; version?: string; versionCode?: number }> }).apps ?? []).filter((a) => a && typeof a.packageName === 'string');
  const byPkg = new Map(reported.map((a) => [a.packageName, a]));
  const library = await libraryFor(scope, d.platform, d.orgId);
  const libByPkg = new Map(library.map((a) => [a.packageName, a]));
  const rows: Array<{
    packageName: string;
    name: string;
    installed: string | null;
    installedCode: number | null;
    expected: string | null;
    state: AppState;
    appId: string | null;
    versionId: string | null;
    managed: boolean;
  }> = [];
  const seen = new Set<string>();
  for (const a of effective.apps) {
    seen.add(a.packageName);
    const r = byPkg.get(a.packageName);
    const lib = library.find((l) => l.id === a.appId);
    const versionId = a.versionId ?? lib?.versions[0]?.id ?? null;
    let state: AppState;
    if (a.remove) state = r ? 'REMOVE' : 'INSTALLED';
    else if (!r) state = 'MISSING';
    else if (a.versionCode !== null && r.versionCode !== undefined ? r.versionCode < a.versionCode : a.version !== null && r.version !== a.version) state = 'OUTDATED';
    else state = 'INSTALLED';
    if (a.remove && !r) continue; // uklonjena i nema je — ništa za prikaz
    rows.push({ packageName: a.packageName, name: a.name, installed: r?.version ?? null, installedCode: r?.versionCode ?? null, expected: a.remove ? null : a.version, state, appId: a.appId, versionId, managed: true });
  }
  for (const r of reported) {
    if (seen.has(r.packageName)) continue;
    const lib = libByPkg.get(r.packageName);
    rows.push({ packageName: r.packageName, name: r.name ?? lib?.name ?? r.packageName, installed: r.version ?? null, installedCode: r.versionCode ?? null, expected: null, state: 'EXTRA', appId: lib?.id ?? null, versionId: null, managed: false });
  }
  const order: Record<AppState, number> = { MISSING: 0, OUTDATED: 1, REMOVE: 2, INSTALLED: 3, EXTRA: 4 };
  rows.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name, 'hr'));
  const pending = await db.mdmCommand.findMany({
    where: { deviceId: d.id, type: { in: ['INSTALL_APP', 'UNINSTALL_APP'] }, status: { in: ['PENDING', 'SENT'] } },
    select: { type: true, payload: true, status: true },
  });
  return {
    device: { id: d.id, name: d.name, platform: d.platform, status: d.status, lastSeenAt: d.lastSeenAt?.toISOString() ?? null, hasTelemetry: reported.length > 0 },
    rows,
    library,
    pending: pending.map((p) => ({ type: p.type, status: p.status, packageName: String((p.payload as Record<string, unknown>).packageName ?? '') })),
  };
}
