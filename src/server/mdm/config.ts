import 'server-only';
import type { Tx } from '../db';
import { db } from '../db';
import { mergeConfig, type DeviceOverrides, type EffectiveConfig, type ProfileApp, type ProfileSettings, type ResolvedApp } from '@/domain/mdm';

type Client = Tx | typeof db;

/** Profil uređaja: vlastiti, inače profil lokacije. */
export async function deviceProfile(tx: Client, device: { profileId: string | null; siteId: string | null }) {
  if (device.profileId) return tx.mdmProfile.findUnique({ where: { id: device.profileId } });
  if (!device.siteId) return null;
  const site = await tx.mdmSite.findUnique({ where: { id: device.siteId }, select: { profile: true } });
  return site?.profile ?? null;
}

/**
 * Konfiguracija koju agent primjenjuje: profil + izmjene uređaja, s aplikacijama
 * razriješenima u paket, verziju i poveznicu za preuzimanje.
 */
export async function buildEffectiveConfig(
  tx: Client,
  device: { id: string; companyId: string; platform: 'ANDROID' | 'WINDOWS'; profileId: string | null; siteId: string | null; overrides: unknown; configVersion: number; maintenancePin: string | null },
): Promise<EffectiveConfig> {
  const profile = await deviceProfile(tx, device);
  const merged = mergeConfig(
    profile ? { settings: profile.settings as ProfileSettings, apps: profile.apps as unknown as ProfileApp[] } : null,
    device.overrides as DeviceOverrides,
  );
  if (device.maintenancePin && !merged.settings.maintenancePin) merged.settings.maintenancePin = device.maintenancePin;

  const appIds = [...new Set(merged.apps.map((a) => a.appId))];
  const apps = appIds.length
    ? await tx.mdmApp.findMany({
        where: { id: { in: appIds }, companyId: device.companyId, platform: device.platform },
        include: { versions: { include: { file: { select: { id: true, sha256: true } } }, orderBy: [{ versionCode: 'desc' }, { createdAt: 'desc' }] } },
      })
    : [];
  const byId = new Map(apps.map((a) => [a.id, a]));
  const resolved: ResolvedApp[] = [];
  for (const a of merged.apps) {
    const app = byId.get(a.appId);
    if (!app) continue; // aplikacija druge platforme ili obrisana
    const v = (a.versionId && app.versions.find((x) => x.id === a.versionId)) || app.versions[0] || null;
    resolved.push({
      ...a,
      packageName: app.packageName,
      name: app.name,
      version: v?.version ?? null,
      versionCode: v?.versionCode ?? null,
      downloadPath: v ? `/api/mdm/agent/files/${v.file.id}` : null,
      sha256: v?.file.sha256 ?? null,
      installArgs: app.installArgs,
    });
  }
  // aplikacija za pokretanje može biti zadana kao appId — agentu treba paket
  const start = merged.settings.startApp;
  if (start && byId.has(start)) merged.settings.startApp = byId.get(start)!.packageName;
  return { version: device.configVersion, settings: merged.settings, apps: resolved };
}

/**
 * Promjena profila ili izmjena uređaja podiže verziju konfiguracije svih
 * pogođenih uređaja; agent je preuzima pri sljedećem javljanju.
 */
export async function bumpConfig(tx: Tx, where: { deviceIds?: string[]; profileId?: string; siteIds?: string[] }) {
  const or = [
    ...(where.deviceIds?.length ? [{ id: { in: where.deviceIds } }] : []),
    ...(where.profileId ? [{ profileId: where.profileId }, { profileId: null, site: { profileId: where.profileId } }] : []),
    ...(where.siteIds?.length ? [{ profileId: null, siteId: { in: where.siteIds } }] : []),
  ];
  if (!or.length) return 0;
  const r = await tx.mdmDevice.updateMany({ where: { OR: or, status: { not: 'RETIRED' } }, data: { configVersion: { increment: 1 } } });
  return r.count;
}
