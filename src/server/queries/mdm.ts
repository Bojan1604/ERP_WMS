import 'server-only';
import { cache } from 'react';
import { Prisma } from '@prisma/client';
import { db } from '../db';
import { deviceWhere, orgWhere, sharedWhere, type MdmScope } from '../mdm/scope';
import { ONLINE_GRACE_SEC, type AlertKind } from '@/domain/mdm';

/**
 * Čitanja za MDM stranice. Sve ide kroz opseg korisnika (deviceWhere/orgWhere);
 * filtri i straničenje su u bazi, online/offline prema pragu zadnjeg javljanja.
 */

type Params = Record<string, string | string[] | undefined>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface DeviceFilters {
  q: string | null;
  orgId: string | null;
  siteId: string | null;
  platform: 'ANDROID' | 'WINDOWS' | null;
  status: 'PENDING' | 'ENROLLED' | 'RETIRED' | null;
  online: 'online' | 'offline' | null;
  alert: AlertKind | 'any' | null;
  profileId: string | null;
}

const ALERTS = ['OFFLINE', 'BATTERY', 'STORAGE', 'CONFIG', 'any'] as const;

export function parseDeviceFilters(sp: Params): DeviceFilters {
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (allowed.includes(v as T) ? (v as T) : null);
  return {
    q: str(sp.q),
    orgId: str(sp.org),
    siteId: str(sp.site),
    platform: pick(sp.platform, ['ANDROID', 'WINDOWS'] as const),
    status: pick(sp.status, ['PENDING', 'ENROLLED', 'RETIRED'] as const),
    online: pick(sp.online, ['online', 'offline'] as const),
    alert: pick(sp.alert, ALERTS),
    profileId: str(sp.profile),
  };
}

export const onlineSince = (now = new Date()) => new Date(now.getTime() - ONLINE_GRACE_SEC * 1000);
const alertCutoff = (now = new Date()) => new Date(now.getTime() - 30 * 60_000);

/** Uređaji s malo prostora (< 10 %) — usporedba dvaju stupaca, pa kroz SQL. */
async function storageAlertIds(companyId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM "MdmDevice"
    WHERE "companyId" = ${companyId} AND status = 'ENROLLED'
      AND "storageTotalMb" > 0 AND "storageFreeMb" IS NOT NULL AND "storageFreeMb" * 10 < "storageTotalMb"
    LIMIT 5000`);
  return rows.map((r) => r.id);
}

/** Uvjet za pojedino upozorenje (isti pragovi kao `deviceAlerts` u domeni). */
function alertWhere(kind: AlertKind, storageIds: string[], now: Date): Prisma.MdmDeviceWhereInput {
  const cut = alertCutoff(now);
  switch (kind) {
    case 'OFFLINE':
      return { status: 'ENROLLED', OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cut } }] };
    case 'BATTERY':
      return { status: 'ENROLLED', batteryLevel: { lt: 15 }, OR: [{ charging: false }, { charging: null }] };
    case 'STORAGE':
      return { status: 'ENROLLED', id: { in: storageIds } };
    case 'CONFIG':
      return { status: 'ENROLLED', lastSeenAt: { gte: cut }, configVersion: { gt: db.mdmDevice.fields.appliedConfigVersion } };
  }
}

export async function anyAlertWhere(companyId: string, now = new Date()): Promise<Prisma.MdmDeviceWhereInput> {
  const storage = await storageAlertIds(companyId);
  return { OR: (['OFFLINE', 'BATTERY', 'STORAGE', 'CONFIG'] as AlertKind[]).map((k) => alertWhere(k, storage, now)) };
}

export async function deviceListWhere(scope: MdmScope, f: DeviceFilters, opts: { ignoreStatus?: boolean; now?: Date } = {}): Promise<Prisma.MdmDeviceWhereInput> {
  const now = opts.now ?? new Date();
  const and: Prisma.MdmDeviceWhereInput[] = [deviceWhere(scope)];
  if (f.q) {
    const c = { contains: f.q, mode: 'insensitive' as const };
    and.push({ OR: [{ name: c }, { serial: c }, { model: c }, { ipAddress: c }, { imei: c }, { hardwareId: c }, { enrollCode: f.q }] });
  }
  // organizacija uključuje i njene klijente (distributer → svi njegovi uređaji)
  if (f.orgId) and.push({ OR: [{ orgId: f.orgId }, { org: { parentId: f.orgId } }] });
  if (f.siteId) and.push({ siteId: f.siteId });
  if (f.platform) and.push({ platform: f.platform });
  if (f.profileId) and.push({ OR: [{ profileId: f.profileId }, { profileId: null, site: { profileId: f.profileId } }] });
  if (f.status && !opts.ignoreStatus) and.push({ status: f.status });
  if (f.online === 'online') and.push({ status: 'ENROLLED', lastSeenAt: { gte: onlineSince(now) } });
  if (f.online === 'offline') and.push({ status: 'ENROLLED', OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: onlineSince(now) } }] });
  if (f.alert === 'any') and.push(await anyAlertWhere(scope.companyId, now));
  else if (f.alert) and.push(alertWhere(f.alert, f.alert === 'STORAGE' ? await storageAlertIds(scope.companyId) : [], now));
  return { AND: and };
}

export const deviceListSelect = {
  id: true,
  name: true,
  platform: true,
  status: true,
  serial: true,
  model: true,
  manufacturer: true,
  osVersion: true,
  agentVersion: true,
  ipAddress: true,
  batteryLevel: true,
  charging: true,
  storageFreeMb: true,
  storageTotalMb: true,
  lastSeenAt: true,
  configVersion: true,
  appliedConfigVersion: true,
  enrollCode: true,
  org: { select: { id: true, name: true, parent: { select: { name: true } } } },
  site: { select: { id: true, name: true } },
} satisfies Prisma.MdmDeviceSelect;

export async function listDevices(scope: MdmScope, f: DeviceFilters, page: { skip: number; take: number }) {
  const [where, whereAllStatus] = await Promise.all([deviceListWhere(scope, f), deviceListWhere(scope, f, { ignoreStatus: true })]);
  const [rows, total, byStatus] = await Promise.all([
    db.mdmDevice.findMany({ where, select: deviceListSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: page.skip, take: page.take }),
    db.mdmDevice.count({ where }),
    db.mdmDevice.groupBy({ by: ['status'], where: whereAllStatus, _count: { _all: true } }),
  ]);
  const counts = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Partial<Record<'PENDING' | 'ENROLLED' | 'RETIRED', number>>;
  return { rows, total, counts };
}

// ---------------------------------------------------------------- šifrarnici za odabir

/** Organizacije u opsegu (za filtre i odabir), s roditeljem radi prikaza „Distributer › Klijent". */
export async function orgOptions(scope: MdmScope, opts: { activeOnly?: boolean } = {}) {
  const orgs = await db.mdmOrg.findMany({
    where: { ...orgWhere(scope), ...(opts.activeOnly ? { active: true } : {}) },
    select: { id: true, name: true, type: true, parentId: true, active: true, parent: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });
  return orgs
    .map((o) => ({ ...o, label: o.parent && (!scope.orgIds || scope.orgIds.includes(o.parentId!)) ? `${o.parent.name} › ${o.name}` : o.name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'hr'));
}

export async function siteOptions(scope: MdmScope) {
  return db.mdmSite.findMany({
    where: { org: orgWhere(scope) },
    select: { id: true, name: true, orgId: true },
    orderBy: { name: 'asc' },
  });
}

export async function profileOptions(scope: MdmScope) {
  return db.mdmProfile.findMany({
    where: sharedWhere(scope),
    select: { id: true, name: true, platform: true, orgId: true },
    orderBy: { name: 'asc' },
  });
}

// ---------------------------------------------------------------- nadzorna ploča

export async function mdmDashboard(scope: MdmScope, now = new Date()) {
  const base = deviceWhere(scope);
  const enrolled = { ...base, status: 'ENROLLED' as const };
  const alertOr = await anyAlertWhere(scope.companyId, now);
  const [byStatus, byPlatform, online, alertCount, alerts, events, byOrg, onlineByOrg, orgs] = await Promise.all([
    db.mdmDevice.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    db.mdmDevice.groupBy({ by: ['platform'], where: enrolled, _count: { _all: true } }),
    db.mdmDevice.count({ where: { ...enrolled, lastSeenAt: { gte: onlineSince(now) } } }),
    db.mdmDevice.count({ where: { AND: [enrolled, alertOr] } }),
    db.mdmDevice.findMany({
      where: { AND: [enrolled, alertOr] },
      select: deviceListSelect,
      orderBy: [{ lastSeenAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: 25,
    }),
    db.mdmEvent.findMany({
      where: { device: base },
      orderBy: { at: 'desc' },
      take: 15,
      select: { id: true, at: true, level: true, type: true, message: true, device: { select: { id: true, name: true } } },
    }),
    db.mdmDevice.groupBy({ by: ['orgId'], where: enrolled, _count: { _all: true } }),
    db.mdmDevice.groupBy({ by: ['orgId'], where: { ...enrolled, lastSeenAt: { gte: onlineSince(now) } }, _count: { _all: true } }),
    db.mdmOrg.findMany({ where: orgWhere(scope), select: { id: true, name: true, type: true, parentId: true }, orderBy: { name: 'asc' } }),
  ]);
  const status = Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])) as Partial<Record<string, number>>;
  const platform = Object.fromEntries(byPlatform.map((s) => [s.platform, s._count._all])) as Partial<Record<string, number>>;
  const total = new Map(byOrg.map((r) => [r.orgId, r._count._all]));
  const on = new Map(onlineByOrg.map((r) => [r.orgId, r._count._all]));
  // sažetak po organizaciji: distributer zbraja i uređaje svojih klijenata
  const perOrg = orgs.map((o) => {
      const ids = [o.id, ...(o.type === 'DISTRIBUTOR' ? orgs.filter((c) => c.parentId === o.id).map((c) => c.id) : [])];
      const t = ids.reduce((a, id) => a + (total.get(id) ?? 0), 0);
      const n = ids.reduce((a, id) => a + (on.get(id) ?? 0), 0);
      return { id: o.id, name: o.name, type: o.type, parentId: o.parentId, total: t, online: n };
    });
  // redoslijed stabla: organizacija pa njeni klijenti
  const inList = new Set(perOrg.map((o) => o.id));
  const roots = perOrg.filter((o) => !o.parentId || !inList.has(o.parentId));
  const ordered = roots.flatMap((r) => [r, ...perOrg.filter((c) => c.parentId === r.id)]);
  return {
    enrolled: status.ENROLLED ?? 0,
    pending: status.PENDING ?? 0,
    retired: status.RETIRED ?? 0,
    online,
    offline: (status.ENROLLED ?? 0) - online,
    platform,
    alertCount,
    alerts,
    events,
    perOrg: ordered,
  };
}

// ---------------------------------------------------------------- uređaj

/** Uređaj u opsegu (pamti se za zahtjev — koriste ga i raspored i kartice). */
export const getDevice = cache(async (scope: MdmScope, id: string) => {
  return db.mdmDevice.findFirst({
    where: { id, ...deviceWhere(scope) },
    include: {
      org: { select: { id: true, name: true, type: true, parent: { select: { id: true, name: true } } } },
      site: { select: { id: true, name: true, timezone: true, profile: { select: { id: true, name: true } } } },
      profile: { select: { id: true, name: true } },
    },
  });
});

/** Uređaji u skladištu ERP-a s istim serijskim brojem (samo za korisnike vlasnika). */
export async function erpMatches(companyId: string, serial: string | null, linkedItemId: string | null) {
  const or: Prisma.ItemWhereInput[] = [];
  if (serial) or.push({ serial });
  if (linkedItemId) or.push({ id: linkedItemId });
  if (!or.length) return [];
  const [items, company] = await Promise.all([
    db.item.findMany({
      where: { companyId, OR: or },
      take: 10,
      select: {
        id: true,
        serial: true,
        dupNote: true,
        state: true,
        warrantyStart: true,
        warrantyMonths: true,
        status: { select: { name: true, color: true } },
        model: { select: { brand: true, name: true, warrantyMonths: true } },
        partner: { select: { id: true, name: true } },
        contractItem: { select: { contract: { select: { id: true, number: true, status: true } } } },
      },
    }),
    db.company.findUniqueOrThrow({ where: { id: companyId }, select: { defaultWarrantyMonths: true } }),
  ]);
  return items.map((i) => ({ ...i, warrantyMonthsEff: i.warrantyMonths ?? i.model.warrantyMonths ?? company.defaultWarrantyMonths ?? null }));
}

export async function deviceCommands(deviceId: string, page: { skip: number; take: number }) {
  const [rows, total] = await Promise.all([
    db.mdmCommand.findMany({ where: { deviceId }, orderBy: { createdAt: 'desc' }, skip: page.skip, take: page.take }),
    db.mdmCommand.count({ where: { deviceId } }),
  ]);
  return { rows, total };
}

export async function deviceEvents(deviceId: string, level: string | null, page: { skip: number; take: number }) {
  const where: Prisma.MdmEventWhereInput = { deviceId, ...(level ? { level } : {}) };
  const [rows, total] = await Promise.all([
    db.mdmEvent.findMany({ where, orderBy: { at: 'desc' }, skip: page.skip, take: page.take }),
    db.mdmEvent.count({ where }),
  ]);
  return { rows, total };
}

export async function deviceUploads(deviceId: string, kind: 'SCREENSHOT' | 'LOGS', take = 20) {
  return db.mdmUpload.findMany({
    where: { deviceId, kind },
    orderBy: { at: 'desc' },
    take,
    select: { id: true, at: true, file: { select: { name: true, size: true, mime: true } } },
  });
}

/** Naredba te vrste koja još čeka uređaj (za „čekam snimku…"). */
export async function pendingCommand(deviceId: string, type: string) {
  return db.mdmCommand.findFirst({
    where: { deviceId, type, status: { in: ['PENDING', 'SENT'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true },
  });
}

// ---------------------------------------------------------------- organizacije

export async function orgTree(scope: MdmScope) {
  const orgs = await db.mdmOrg.findMany({
    where: orgWhere(scope),
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      type: true,
      parentId: true,
      oib: true,
      city: true,
      active: true,
      partnerId: true,
      _count: { select: { devices: true, users: true, children: true } },
      sites: { select: { id: true, name: true, address: true, _count: { select: { devices: true } } }, orderBy: { name: 'asc' } },
    },
  });
  // korijeni: u opsegu, a roditelj nije u opsegu (ili ga nema)
  const ids = new Set(orgs.map((o) => o.id));
  const roots = orgs.filter((o) => !o.parentId || !ids.has(o.parentId));
  const children = (id: string) => orgs.filter((o) => o.parentId === id);
  return { orgs, roots, children: Object.fromEntries(orgs.map((o) => [o.id, children(o.id)])) };
}

export async function getOrg(scope: MdmScope, id: string) {
  return db.mdmOrg.findFirst({
    where: { AND: [{ id }, orgWhere(scope)] },
    include: {
      parent: { select: { id: true, name: true } },
      partner: { select: { id: true, name: true } },
      children: { where: orgWhere(scope), select: { id: true, name: true, active: true, _count: { select: { devices: true } } }, orderBy: { name: 'asc' } },
      sites: {
        orderBy: { name: 'asc' },
        include: { profile: { select: { id: true, name: true } }, _count: { select: { devices: true } } },
      },
      users: {
        where: { role: { in: ['DISTRIBUTOR', 'CLIENT'] } },
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true, permissions: true },
      },
      _count: { select: { devices: true } },
    },
  });
}

// ---------------------------------------------------------------- upis

export async function enrollTokens(scope: MdmScope) {
  return db.mdmEnrollToken.findMany({
    where: { companyId: scope.companyId, ...(scope.orgIds ? { orgId: { in: scope.orgIds } } : {}) },
    orderBy: { createdAt: 'desc' },
    include: { org: { select: { id: true, name: true } }, site: { select: { id: true, name: true } } },
    take: 200,
  });
}

/** Uređaji koji čekaju upis (vidi ih samo vlasnik — nemaju organizaciju; ostali upisuju kodom). */
export async function pendingDevices(scope: MdmScope) {
  return db.mdmDevice.findMany({
    where: { ...deviceWhere(scope), status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, name: true, platform: true, model: true, manufacturer: true, serial: true, enrollCode: true, lastSeenAt: true, createdAt: true, ipAddress: true },
  });
}
