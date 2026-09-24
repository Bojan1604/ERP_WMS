import 'server-only';
import type { Tx } from '../db';
import { audit } from '../audit';
import { AuthError, DomainError, assert } from '../errors';
import { bumpConfig } from './config';
import { assertOrgInScope, sharedWhere, type MdmScope } from './scope';
import { actorOf, requireLevel } from './devices';

/**
 * Organizacije i lokacije MDM-a.
 *   • vlasnik: distributeri, klijenti (pod distributerom ili izravno), veza na ERP partnera
 *   • distributer: svoji klijenti (uvijek pod sobom) i lokacije
 *   • klijent (s pravom uređivanja): podaci i lokacije vlastite organizacije
 */

export interface OrgInput {
  type: 'DISTRIBUTOR' | 'CUSTOMER';
  parentId: string | null;
  name: string;
  oib: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  note: string | null;
  active: boolean;
  partnerId: string | null;
}

async function isDistributorScope(tx: Tx, scope: MdmScope) {
  if (!scope.homeOrgId) return false;
  const o = await tx.mdmOrg.findUnique({ where: { id: scope.homeOrgId }, select: { type: true } });
  return o?.type === 'DISTRIBUTOR';
}

function validate(input: OrgInput) {
  const name = input.name.trim();
  assert(name.length >= 2 && name.length <= 150, 'Naziv mora imati 2–150 znakova.');
  if (input.oib) assert(/^\d{11}$/.test(input.oib.trim()), 'OIB mora imati 11 znamenki.');
  if (input.email) assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()), 'Neispravna e-adresa.');
  return name;
}

export async function saveOrg(tx: Tx, scope: MdmScope, id: string | null, input: OrgInput) {
  requireLevel(scope, 'edit');
  const name = validate(input);
  const contact = {
    name,
    oib: input.oib?.trim() || null,
    email: input.email?.trim().toLowerCase() || null,
    phone: input.phone?.trim() || null,
    address: input.address?.trim() || null,
    city: input.city?.trim() || null,
    note: input.note?.trim() || null,
  };
  let partnerId: string | null | undefined = undefined;
  if (scope.owner) {
    partnerId = input.partnerId || null;
    if (partnerId) assert(await tx.partner.findFirst({ where: { id: partnerId, companyId: scope.companyId }, select: { id: true } }), 'Partner ne postoji.');
  }

  if (!id) {
    let type = input.type;
    let parentId = input.parentId;
    if (scope.owner) {
      if (type === 'DISTRIBUTOR') parentId = null;
      if (parentId) {
        const p = await tx.mdmOrg.findFirst({ where: { id: parentId, companyId: scope.companyId }, select: { type: true } });
        assert(p?.type === 'DISTRIBUTOR', 'Klijent može biti samo pod distributerom.');
      }
    } else {
      // distributer otvara samo svoje klijente; klijent ne otvara organizacije
      if (!(await isDistributorScope(tx, scope))) throw new AuthError('Nove organizacije otvara distributer ili vlasnik sustava.', 403);
      type = 'CUSTOMER';
      parentId = scope.homeOrgId;
    }
    const org = await tx.mdmOrg.create({
      data: { companyId: scope.companyId, type, parentId, active: input.active, ...contact, ...(partnerId !== undefined ? { partnerId } : {}) },
    });
    await audit(tx, actorOf(scope), { entity: 'mdmOrg', entityId: org.id, action: 'create', summary: `Nova MDM organizacija ${org.name}`, diff: { type, parentId } });
    return org.id;
  }

  assertOrgInScope(scope, id);
  const before = await tx.mdmOrg.findFirst({ where: { id, companyId: scope.companyId } });
  assert(before, 'Organizacija ne postoji.');
  // vlastitu organizaciju vanjski korisnik ne može deaktivirati (zaključao bi se)
  const active = id === scope.homeOrgId ? before.active : input.active;
  await tx.mdmOrg.update({ where: { id }, data: { ...contact, active, ...(partnerId !== undefined ? { partnerId } : {}) } });
  if (before.active && !active) {
    // deaktivacija: korisnici organizacije (i njenih klijenata) gube pristup odmah
    await tx.session.updateMany({ where: { user: { mdmOrg: { OR: [{ id }, { parentId: id }] } }, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  await audit(tx, actorOf(scope), { entity: 'mdmOrg', entityId: id, action: 'update', summary: `MDM organizacija ${name} izmijenjena`, diff: { active, partnerId: partnerId ?? before.partnerId } });
  return id;
}

export async function deleteOrg(tx: Tx, scope: MdmScope, id: string) {
  requireLevel(scope, 'edit');
  assertOrgInScope(scope, id);
  if (id === scope.homeOrgId) throw new AuthError('Vlastitu organizaciju ne možete obrisati.', 403);
  const o = await tx.mdmOrg.findFirst({
    where: { id, companyId: scope.companyId },
    select: { name: true, _count: { select: { devices: true, children: true, users: true, profiles: true, apps: true, files: true } } },
  });
  assert(o, 'Organizacija ne postoji.');
  const c = o._count;
  if (c.devices) throw new DomainError(`Organizacija ima ${c.devices} uređaja — premjestite ih ili odjavite prije brisanja.`);
  if (c.children) throw new DomainError(`Organizacija ima ${c.children} klijenata — obrišite ih ili premjestite prije brisanja.`);
  if (c.users) throw new DomainError(`Organizacija ima ${c.users} korisnika — deaktivirajte organizaciju umjesto brisanja.`);
  if (c.profiles || c.apps || c.files) throw new DomainError('Organizacija ima vlastite profile, aplikacije ili datoteke — uklonite ih prije brisanja.');
  await tx.mdmOrg.delete({ where: { id } });
  await audit(tx, actorOf(scope), { entity: 'mdmOrg', entityId: id, action: 'delete', summary: `Obrisana MDM organizacija ${o.name}` });
}

export interface SiteInput {
  orgId: string;
  name: string;
  address: string | null;
  timezone: string;
  profileId: string | null;
  note: string | null;
}

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function saveSite(tx: Tx, scope: MdmScope, id: string | null, input: SiteInput) {
  requireLevel(scope, 'edit');
  const name = input.name.trim();
  assert(name.length >= 1 && name.length <= 150, 'Naziv lokacije mora imati 1–150 znakova.');
  const timezone = input.timezone.trim() || 'Europe/Zagreb';
  assert(validTimezone(timezone), 'Neispravna vremenska zona.');
  if (input.profileId) {
    const p = await tx.mdmProfile.findFirst({ where: { id: input.profileId, ...sharedWhere(scope) }, select: { id: true } });
    if (!p) throw new AuthError('Profil nije dostupan.', 403);
  }
  const data = { name, address: input.address?.trim() || null, timezone, profileId: input.profileId, note: input.note?.trim() || null };
  if (!id) {
    assertOrgInScope(scope, input.orgId);
    assert(await tx.mdmOrg.findFirst({ where: { id: input.orgId, companyId: scope.companyId }, select: { id: true } }), 'Organizacija ne postoji.');
    const s = await tx.mdmSite.create({ data: { ...data, orgId: input.orgId } });
    await audit(tx, actorOf(scope), { entity: 'mdmSite', entityId: s.id, action: 'create', summary: `Nova lokacija ${name}` });
    return s.id;
  }
  const before = await tx.mdmSite.findFirst({ where: { id, org: { companyId: scope.companyId } }, select: { orgId: true, profileId: true, timezone: true } });
  assert(before, 'Lokacija ne postoji.');
  assertOrgInScope(scope, before.orgId);
  await tx.mdmSite.update({ where: { id }, data });
  if (before.profileId !== data.profileId || before.timezone !== data.timezone) await bumpConfig(tx, { siteIds: [id] });
  await audit(tx, actorOf(scope), { entity: 'mdmSite', entityId: id, action: 'update', summary: `Lokacija ${name} izmijenjena`, diff: { profileId: data.profileId, timezone } });
  return id;
}

export async function deleteSite(tx: Tx, scope: MdmScope, id: string) {
  requireLevel(scope, 'edit');
  const s = await tx.mdmSite.findFirst({ where: { id, org: { companyId: scope.companyId } }, select: { orgId: true, name: true, _count: { select: { devices: true } } } });
  assert(s, 'Lokacija ne postoji.');
  assertOrgInScope(scope, s.orgId);
  if (s._count.devices) throw new DomainError(`Na lokaciji je ${s._count.devices} uređaja — premjestite ih prije brisanja.`);
  await tx.mdmSite.delete({ where: { id } });
  await audit(tx, actorOf(scope), { entity: 'mdmSite', entityId: id, action: 'delete', summary: `Obrisana lokacija ${s.name}` });
}
