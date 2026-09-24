import 'server-only';
import type { Tx } from '../db';
import bcrypt from 'bcryptjs';
import { audit } from '../audit';
import { AuthError, assert } from '../errors';
import { assertOrgInScope, type MdmScope } from './scope';
import { actorOf, requireLevel } from './devices';
import { ROLE_DEFAULTS, ROLE_LABEL, type Level } from '@/domain/permissions';

/**
 * Vanjski korisnici MDM-a (DISTRIBUTOR, CLIENT). Uloga slijedi vrstu
 * organizacije: distributerska → DISTRIBUTOR, klijentska → CLIENT. Nikad ERP
 * uloge. Vlasnik uređuje sve; distributer svoje i svojih klijenata; klijent nikoga.
 */

export const MIN_PASSWORD = 8;
const RANK: Record<Level, number> = { none: 0, view: 1, ops: 2, edit: 3 };
// isto kao hashPassword u auth.ts (bez uvoza next/headers, pa je servis testabilan)
const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

export interface MdmUserInput {
  orgId: string;
  name: string;
  email: string;
  password: string | null;
  active: boolean;
  /** Razina na modulu MDM; null = zadano za ulogu. */
  level: Exclude<Level, 'none'> | null;
}

async function canManageUsers(tx: Tx, scope: MdmScope) {
  requireLevel(scope, 'edit');
  if (scope.owner) return;
  const home = scope.homeOrgId ? await tx.mdmOrg.findUnique({ where: { id: scope.homeOrgId }, select: { type: true } }) : null;
  if (home?.type !== 'DISTRIBUTOR') throw new AuthError('Korisnike otvara distributer ili vlasnik sustava.', 403);
}

async function revokeSessions(tx: Tx, userId: string) {
  await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Vanjski korisnik u opsegu (ERP korisnici se ovdje nikad ne dohvaćaju). */
async function loadUser(tx: Tx, scope: MdmScope, id: string) {
  const u = await tx.user.findFirst({
    where: { id, companyId: scope.companyId, role: { in: ['DISTRIBUTOR', 'CLIENT'] }, mdmOrgId: { not: null } },
    select: { id: true, name: true, email: true, role: true, active: true, mdmOrgId: true, permissions: true },
  });
  if (!u || (scope.orgIds && !scope.orgIds.includes(u.mdmOrgId!))) throw new AuthError('Korisnik nije dostupan.', 403);
  return u;
}

export async function saveMdmUser(tx: Tx, scope: MdmScope, id: string | null, input: MdmUserInput) {
  await canManageUsers(tx, scope);
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  assert(name.length >= 2 && name.length <= 100, 'Ime mora imati 2–100 znakova.');
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Neispravna e-adresa.');
  if (input.password !== null) assert(input.password.length >= MIN_PASSWORD, `Lozinka mora imati barem ${MIN_PASSWORD} znakova.`);
  const taken = await tx.user.findFirst({ where: { email, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
  assert(!taken, `Korisnik s e-adresom ${email} već postoji.`);

  const orgId = id ? (await loadUser(tx, scope, id)).mdmOrgId! : input.orgId;
  assertOrgInScope(scope, orgId);
  const org = await tx.mdmOrg.findFirst({ where: { id: orgId, companyId: scope.companyId }, select: { type: true, name: true } });
  assert(org, 'Organizacija ne postoji.');
  const role = org.type === 'DISTRIBUTOR' ? 'DISTRIBUTOR' : 'CLIENT';

  // razina ne smije biti viša od razine onoga tko je dodjeljuje
  const level = input.level && input.level !== ROLE_DEFAULTS[role].mdm ? input.level : null;
  if (level) assert(RANK[level] <= RANK[scope.level], 'Ne možete dodijeliti veća prava od vlastitih.');
  const permissions = level ? { mdm: level } : {};

  if (!id) {
    assert(input.password, 'Lozinka je obavezna za novog korisnika.');
    const u = await tx.user.create({
      data: { companyId: scope.companyId, mdmOrgId: orgId, role, name, email, active: input.active, permissions, passwordHash: await hashPassword(input.password) },
    });
    await audit(tx, actorOf(scope), { entity: 'user', entityId: u.id, action: 'create', summary: `Novi korisnik ${name} (${ROLE_LABEL[role]}, ${org.name})`, diff: { email, role, orgId, permissions } });
    return u.id;
  }

  const before = await loadUser(tx, scope, id);
  const self = id === scope.userId;
  if (self) {
    assert(input.active, 'Ne možete deaktivirati sami sebe.');
    assert(JSON.stringify(before.permissions ?? {}) === JSON.stringify(permissions), 'Ne možete sami sebi mijenjati prava.');
  }
  await tx.user.update({
    where: { id },
    data: { name, email, role, active: input.active, permissions, ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}) },
  });
  const revoke = (before.active && !input.active) || !!input.password;
  if (revoke) await revokeSessions(tx, id);
  await audit(tx, actorOf(scope), {
    entity: 'user',
    entityId: id,
    action: 'update',
    summary: `Korisnik ${name} izmijenjen${revoke ? ' — sve sesije odjavljene' : ''}`,
    diff: { email, active: input.active, permissions, ...(input.password ? { password: 'nova lozinka' } : {}) },
  });
  return id;
}

export async function setMdmUserActive(tx: Tx, scope: MdmScope, id: string, active: boolean) {
  await canManageUsers(tx, scope);
  const u = await loadUser(tx, scope, id);
  assert(!(id === scope.userId && !active), 'Ne možete deaktivirati sami sebe.');
  await tx.user.update({ where: { id }, data: { active } });
  if (!active) await revokeSessions(tx, id);
  await audit(tx, actorOf(scope), { entity: 'user', entityId: id, action: 'update', summary: `Korisnik ${u.name} ${active ? 'aktiviran' : 'deaktiviran — sve sesije odjavljene'}` });
}

export async function resetMdmPassword(tx: Tx, scope: MdmScope, id: string, password: string) {
  await canManageUsers(tx, scope);
  const u = await loadUser(tx, scope, id);
  assert(password.length >= MIN_PASSWORD, `Lozinka mora imati barem ${MIN_PASSWORD} znakova.`);
  await tx.user.update({ where: { id }, data: { passwordHash: await hashPassword(password) } });
  await revokeSessions(tx, id);
  await audit(tx, actorOf(scope), { entity: 'user', entityId: id, action: 'update', summary: `Nova lozinka za korisnika ${u.name} — sve sesije odjavljene` });
}
