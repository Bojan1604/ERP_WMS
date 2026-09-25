import 'server-only';
import type { Prisma, Role } from '@prisma/client';
import type { Tx } from '../db';
import bcrypt from 'bcryptjs';
import { audit } from '../audit';
import { DomainError, assert } from '../errors';
import type { Actor } from './items';
import { LEVEL_LABEL, MODULES, ROLE_DEFAULTS, ROLE_LABEL, type Level, type Module } from '@/domain/permissions';

export interface UserInput {
  name: string;
  email: string;
  role: Role;
  active: boolean;
  /** OIB operatera (za fiskalizirane račune); null = nije upisan. */
  oib?: string | null;
  /** Prazno = lozinka se ne mijenja (kod novog korisnika obavezna). */
  password: string | null;
  /** Željena prava po modulu; spremaju se samo odstupanja od uloge. */
  permissions: Partial<Record<string, string>>;
  /** Smije u opasnu zonu (administrator uvijek). undefined = bez promjene. */
  canDanger?: boolean;
  /** Promjena statusa na odobrenje: null = prati firmu, true = uvijek, false = nikad. undefined = bez promjene. */
  requireApproval?: boolean | null;
}

/** Korisnik pripada firmi: matična (trenutno odabrana) ili ima pristup preko UserCompany. */
export const inCompany = (companyId: string): Prisma.UserWhereInput => ({ OR: [{ companyId }, { companies: { some: { companyId } } }] });

export const MIN_PASSWORD = 8;

// isto kao hashPassword u auth.ts (bez uvoza next/headers, pa je servis testabilan)
const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

/** Samo iznimke u odnosu na zadana prava uloge (administrator ih nema). */
export function permissionOverrides(role: Role, wanted: Partial<Record<string, string>>): Partial<Record<Module, Level>> {
  if (role === 'ADMIN') return {};
  const base = ROLE_DEFAULTS[role];
  const out: Partial<Record<Module, Level>> = {};
  for (const m of Object.keys(MODULES) as Module[]) {
    const v = wanted[m];
    if (v && v in LEVEL_LABEL && v !== base[m]) out[m] = v as Level;
  }
  return out;
}

async function revokeSessions(tx: Tx, userId: string) {
  await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

export async function saveUser(tx: Tx, actor: Actor, id: string | null, input: UserInput) {
  const email = input.email.trim().toLowerCase();
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Neispravna e-adresa.');
  if (input.password !== null) assert(input.password.length >= MIN_PASSWORD, `Lozinka mora imati barem ${MIN_PASSWORD} znakova.`);
  const taken = await tx.user.findFirst({ where: { email, ...(id ? { id: { not: id } } : {}) }, select: { id: true } });
  assert(!taken, `Korisnik s e-adresom ${email} već postoji.`);
  const permissions = permissionOverrides(input.role, input.permissions);
  const oib = input.oib?.trim() || null;
  if (oib) assert(/^\d{11}$/.test(oib), 'OIB mora imati 11 znamenki.');

  // samo administrator dodjeljuje ulogu administratora i uređuje administratore
  const me = await tx.user.findFirst({ where: { id: actor.id }, select: { role: true } });
  const actorIsAdmin = me?.role === 'ADMIN';
  // opasnu zonu i odobrenja statusa dodjeljuje samo administrator
  if (!actorIsAdmin) {
    assert(!input.canDanger, 'Pravo na opasnu zonu dodjeljuje samo administrator.');
  }
  if (!actorIsAdmin) assert(input.role !== 'ADMIN', 'Samo administrator može dodijeliti ulogu administratora.');

  if (!id) {
    assert(input.password, 'Lozinka je obavezna za novog korisnika.');
    const u = await tx.user.create({
      data: {
        companyId: actor.companyId,
        name: input.name,
        email,
        role: input.role,
        active: input.active,
        oib,
        permissions,
        canDanger: input.role !== 'ADMIN' && !!input.canDanger,
        requireApproval: input.role === 'ADMIN' ? null : (input.requireApproval ?? null),
        passwordHash: await hashPassword(input.password),
        // pristup firmi u kojoj je otvoren (više firmi: popis firmi korisnika)
        companies: { create: { companyId: actor.companyId } },
      },
    });
    await audit(tx, actor, {
      entity: 'user',
      entityId: u.id,
      action: 'create',
      summary: `Novi korisnik ${u.name} (${ROLE_LABEL[u.role]})`,
      diff: { email, role: u.role, permissions },
    });
    return u.id;
  }

  const before = await tx.user.findFirst({ where: { id, ...inCompany(actor.companyId) } });
  assert(before, 'Korisnik ne postoji.');
  if (!actorIsAdmin) assert(before.role !== 'ADMIN', 'Samo administrator može mijenjati podatke administratora.');
  if (id === actor.id) {
    assert(input.active, 'Ne možete deaktivirati sami sebe.');
    assert(!(before.role === 'ADMIN' && input.role !== 'ADMIN'), 'Ne možete sami sebi oduzeti ulogu administratora.');
  }
  // firma mora zadržati barem jednog aktivnog administratora
  if (before.role === 'ADMIN' && before.active && (input.role !== 'ADMIN' || !input.active)) {
    const others = await tx.user.count({ where: { ...inCompany(actor.companyId), role: 'ADMIN', active: true, id: { not: id } } });
    assert(others > 0, 'Firma mora imati barem jednog aktivnog administratora.');
  }

  await tx.user.update({
    where: { id },
    data: {
      name: input.name,
      email,
      role: input.role,
      active: input.active,
      oib,
      permissions,
      ...(input.canDanger !== undefined && actorIsAdmin ? { canDanger: input.role !== 'ADMIN' && input.canDanger } : {}),
      ...(input.requireApproval !== undefined ? { requireApproval: input.role === 'ADMIN' ? null : input.requireApproval } : {}),
      ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
    },
  });

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (before.name !== input.name) changes.name = { from: before.name, to: input.name };
  if (before.email !== email) changes.email = { from: before.email, to: email };
  if (before.role !== input.role) changes.role = { from: before.role, to: input.role };
  if ((before.oib ?? null) !== oib) changes.oib = { from: before.oib, to: oib };
  if (before.active !== input.active) changes.active = { from: before.active, to: input.active };
  if (JSON.stringify(before.permissions ?? {}) !== JSON.stringify(permissions)) changes.permissions = { from: before.permissions, to: permissions };
  if (input.password) changes.password = { from: '•••', to: 'nova lozinka' };
  if (input.canDanger !== undefined && actorIsAdmin && before.canDanger !== (input.role !== 'ADMIN' && input.canDanger)) changes.canDanger = { from: before.canDanger, to: input.canDanger };
  if (input.requireApproval !== undefined && (before.requireApproval ?? null) !== (input.role === 'ADMIN' ? null : input.requireApproval)) {
    changes.requireApproval = { from: before.requireApproval, to: input.requireApproval };
  }

  const revoke = (!input.active && before.active) || !!input.password;
  if (revoke) await revokeSessions(tx, id);
  if (Object.keys(changes).length) {
    await audit(tx, actor, {
      entity: 'user',
      entityId: id,
      action: 'update',
      summary: `Korisnik ${input.name} izmijenjen${revoke ? ' — sve sesije odjavljene' : ''}`,
      diff: changes as object,
    });
  }
  return id;
}

/** Odjava korisnika sa svih uređaja. */
export async function revokeUserSessions(tx: Tx, actor: Actor, id: string) {
  const u = await tx.user.findFirst({ where: { id, ...inCompany(actor.companyId) }, select: { name: true, role: true } });
  if (!u) throw new DomainError('Korisnik ne postoji.');
  if (u.role === 'ADMIN' && id !== actor.id) {
    const me = await tx.user.findFirst({ where: { id: actor.id }, select: { role: true } });
    assert(me?.role === 'ADMIN', 'Samo administrator može odjaviti administratora.');
  }
  await revokeSessions(tx, id);
  await audit(tx, actor, { entity: 'user', entityId: id, action: 'logout', summary: `Korisnik ${u.name} odjavljen sa svih uređaja` });
}

// ---------------------------------------------------------------- moj račun (F7)

/** Korisnik mijenja svoje ime. */
export async function updateOwnProfile(tx: Tx, actor: Actor, input: { name: string }) {
  const name = input.name.trim();
  assert(name.length >= 2, 'Upišite ime i prezime.');
  const before = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { name: true } });
  if (before.name === name) return;
  await tx.user.update({ where: { id: actor.id }, data: { name } });
  await audit(tx, actor, { entity: 'user', entityId: actor.id, action: 'update', summary: `Promijenjeno ime: ${before.name} → ${name}`, diff: { name: { from: before.name, to: name } } });
}

/**
 * Korisnik mijenja svoju lozinku (uz trenutnu). Sve sesije se odjavljuju — akcija
 * odmah otvara novu za ovaj uređaj.
 */
export async function changeOwnPassword(tx: Tx, actor: Actor, input: { current: string; next: string }) {
  const u = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { passwordHash: true } });
  assert(await bcrypt.compare(input.current, u.passwordHash), 'Trenutna lozinka nije ispravna.');
  assert(input.next.length >= MIN_PASSWORD, `Nova lozinka mora imati barem ${MIN_PASSWORD} znakova.`);
  assert(input.next !== input.current, 'Nova lozinka mora biti drukčija od trenutne.');
  await tx.user.update({ where: { id: actor.id }, data: { passwordHash: await hashPassword(input.next) } });
  await revokeSessions(tx, actor.id);
  await audit(tx, actor, { entity: 'user', entityId: actor.id, action: 'password', summary: 'Korisnik je promijenio svoju lozinku — ostali uređaji odjavljeni' });
}
