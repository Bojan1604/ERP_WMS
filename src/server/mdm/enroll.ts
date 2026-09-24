import 'server-only';
import { randomBytes } from 'node:crypto';
import type { Tx } from '../db';
import { audit } from '../audit';
import { AuthError, DomainError, assert } from '../errors';
import { bumpConfig } from './config';
import { assertOrgInScope, sharedWhere, type MdmScope } from './scope';
import { actorOf, requireLevel } from './devices';
import { orgUsable } from './profiles';
import { retireDuplicates } from './retire';
import { isEnrollCode, PLATFORM_LABEL } from '@/domain/mdm';

/**
 * Upis uređaja: (a) kodom koji agent prikazuje na zaslonu (kao SCN „Auth Code"),
 * (b) ključem za automatski upis (QR za Android, instalacijska naredba za Windows).
 */

/** Paket i prijemnik agenta za Android Device Owner — fiksno (agent ga tako gradi). */
export const ANDROID_AGENT_PACKAGE = 'hr.erpwms.mdm.agent';
export const ANDROID_ADMIN_COMPONENT = `${ANDROID_AGENT_PACKAGE}/.AdminReceiver`;

export interface EnrollInput {
  code: string;
  orgId: string;
  siteId: string | null;
  name: string | null;
  profileId: string | null;
}

export async function enrollByCode(tx: Tx, scope: MdmScope, input: EnrollInput) {
  requireLevel(scope, 'edit');
  const code = input.code.replace(/\s+/g, '');
  assert(isEnrollCode(code), 'Kod mora imati 6 znamenki.');
  assertOrgInScope(scope, input.orgId);
  const org = await tx.mdmOrg.findFirst({ where: { id: input.orgId, companyId: scope.companyId }, select: { name: true, active: true } });
  assert(org, 'Organizacija ne postoji.');
  assert(org.active, 'Organizacija nije aktivna.');
  let siteName = '';
  if (input.siteId) {
    const site = await tx.mdmSite.findFirst({ where: { id: input.siteId, orgId: input.orgId }, select: { name: true } });
    assert(site, 'Lokacija ne pripada odabranoj organizaciji.');
    siteName = ` › ${site.name}`;
  }
  // uređaj na čekanju nema organizaciju (ili je već dodijeljen organizaciji u opsegu) — kod je dokaz da je korisnik uz uređaj
  const device = await tx.mdmDevice.findFirst({
    where: { companyId: scope.companyId, status: 'PENDING', enrollCode: code },
    select: { id: true, name: true, platform: true, orgId: true, profileId: true, hardwareId: true },
    orderBy: { updatedAt: 'desc' },
  });
  if (!device) throw new DomainError('Uređaj s tim kodom ne čeka upis. Provjerite kod na zaslonu uređaja.');
  if (device.orgId && scope.orgIds && !scope.orgIds.includes(device.orgId)) throw new DomainError('Uređaj s tim kodom ne čeka upis. Provjerite kod na zaslonu uređaja.');

  if (input.profileId) {
    const p = await tx.mdmProfile.findFirst({ where: { id: input.profileId, ...sharedWhere(scope) }, select: { platform: true, name: true, orgId: true } });
    if (!p) throw new AuthError('Profil nije dostupan.', 403);
    assert(p.platform === device.platform, `Profil „${p.name}" nije za ${PLATFORM_LABEL[device.platform]}.`);
    assert(await orgUsable(tx, p.orgId, input.orgId), `Profil „${p.name}" ne pripada organizaciji ${org.name}.`);
  }
  // uređaj na čekanju već dodijeljen drugoj organizaciji: njene izmjene i profil ne prelaze u novu
  const orgChanged = device.orgId !== input.orgId;
  let keepProfile = !orgChanged;
  if (orgChanged && device.profileId && !input.profileId) {
    const old = await tx.mdmProfile.findUnique({ where: { id: device.profileId }, select: { orgId: true } });
    keepProfile = !!old && (await orgUsable(tx, old.orgId, input.orgId));
  }
  const name = input.name?.trim() || device.name;
  assert(name.length <= 100, 'Naziv je predug.');

  // uvjet na statusu štiti od dvostrukog upisa istog koda u isto vrijeme
  const r = await tx.mdmDevice.updateMany({
    where: { id: device.id, status: 'PENDING', enrollCode: code },
    data: {
      status: 'ENROLLED',
      enrolledAt: new Date(),
      enrollCode: null,
      orgId: input.orgId,
      siteId: input.siteId,
      name,
      ...(input.profileId ? { profileId: input.profileId } : keepProfile ? {} : { profileId: null }),
      ...(orgChanged ? { overrides: {} } : {}),
    },
  });
  assert(r.count === 1, 'Uređaj je upravo upisan s drugog mjesta.');
  // stari upisani zapisi istog uređaja (agent je ponovno instaliran) se odjavljuju
  await retireDuplicates(
    tx,
    { companyId: scope.companyId, hardwareId: device.hardwareId, platform: device.platform, keepId: device.id, orgIds: scope.orgIds },
    ['ENROLLED', 'PENDING'],
    'Uređaj je ponovno upisan kao novi zapis.',
  );
  await bumpConfig(tx, { deviceIds: [device.id] });
  await tx.mdmEvent.create({ data: { deviceId: device.id, type: 'ENROLLED', message: `Upisan: ${org.name}${siteName} (${scope.userName})` } });
  await audit(tx, actorOf(scope), {
    entity: 'mdmDevice',
    entityId: device.id,
    action: 'enroll',
    summary: `Upisan uređaj ${name} → ${org.name}${siteName}`,
    diff: { orgId: input.orgId, siteId: input.siteId, profileId: input.profileId },
  });
  return { id: device.id, name };
}

export interface TokenInput {
  orgId: string;
  siteId: string | null;
  label: string | null;
  maxUses: number | null;
  expiresAt: string | null; // YYYY-MM-DD, vrijedi do kraja dana
}

export async function createEnrollToken(tx: Tx, scope: MdmScope, input: TokenInput) {
  requireLevel(scope, 'edit');
  assertOrgInScope(scope, input.orgId);
  const org = await tx.mdmOrg.findFirst({ where: { id: input.orgId, companyId: scope.companyId }, select: { name: true } });
  assert(org, 'Organizacija ne postoji.');
  if (input.siteId) assert(await tx.mdmSite.findFirst({ where: { id: input.siteId, orgId: input.orgId }, select: { id: true } }), 'Lokacija ne pripada odabranoj organizaciji.');
  assert(input.maxUses === null || (input.maxUses >= 1 && input.maxUses <= 100000), 'Broj upisa mora biti 1–100000.');
  const expiresAt = input.expiresAt ? new Date(`${input.expiresAt}T23:59:59`) : null;
  assert(!expiresAt || expiresAt > new Date(), 'Datum isteka je u prošlosti.');
  const t = await tx.mdmEnrollToken.create({
    data: {
      companyId: scope.companyId,
      orgId: input.orgId,
      siteId: input.siteId,
      token: randomBytes(16).toString('hex'), // samo [0-9a-f] — bez znakova koje ljuska ili QR tumače
      label: input.label?.trim() || null,
      maxUses: input.maxUses,
      expiresAt,
      createdBy: scope.userName,
    },
  });
  await audit(tx, actorOf(scope), { entity: 'mdmEnrollToken', entityId: t.id, action: 'create', summary: `Ključ za upis ${t.label ?? ''} → ${org.name}`.replace('  ', ' ') });
  return t;
}

export async function revokeEnrollToken(tx: Tx, scope: MdmScope, id: string) {
  requireLevel(scope, 'edit');
  const t = await tx.mdmEnrollToken.findFirst({ where: { id, companyId: scope.companyId }, select: { orgId: true, label: true } });
  if (!t) throw new AuthError('Ključ nije dostupan.', 403);
  assertOrgInScope(scope, t.orgId);
  await tx.mdmEnrollToken.delete({ where: { id } });
  await audit(tx, actorOf(scope), { entity: 'mdmEnrollToken', entityId: id, action: 'delete', summary: `Opozvan ključ za upis ${t.label ?? ''}`.trim() });
}

export function tokenState(t: { maxUses: number | null; uses: number; expiresAt: Date | string | null }, now = new Date()): 'active' | 'used' | 'expired' {
  if (t.expiresAt && new Date(t.expiresAt) < now) return 'expired';
  if (t.maxUses !== null && t.uses >= t.maxUses) return 'used';
  return 'active';
}

// ---------------------------------------------------------------- upute za agenta

/** JSON za Android QR provisioning (Device Owner) — sken na zaslonu dobrodošlice. */
export function androidProvisioning(appUrl: string, token: string, checksum: string | null) {
  return {
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME': ANDROID_ADMIN_COMPONENT,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION': `${appUrl}/api/mdm/agent/download/android`,
    'android.app.extra.PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM': checksum ?? '',
    'android.app.extra.PROVISIONING_SKIP_ENCRYPTION': false,
    'android.app.extra.PROVISIONING_ADMIN_EXTRAS_BUNDLE': { server: appUrl, enrollToken: token },
  };
}

/** Jednoredna PowerShell naredba za instalaciju Windows agenta s automatskim upisom. */
export function windowsInstallCommand(appUrl: string, token: string | null) {
  const tok = token ? ` -Token ${token}` : '';
  return `powershell -ExecutionPolicy Bypass -Command "iwr ${appUrl}/api/mdm/agent/download/windows-install -OutFile $env:TEMP\\wms-agent-install.ps1; & $env:TEMP\\wms-agent-install.ps1 -Server ${appUrl}${tok}"`;
}
