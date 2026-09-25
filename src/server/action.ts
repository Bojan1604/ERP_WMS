import 'server-only';
import { revalidatePath, revalidateTag } from 'next/cache';
import { Prisma } from '@prisma/client';
import { z, ZodError } from 'zod';
import { requireAccess, requireUser, type SessionUser } from './auth';
import { AuthError, DomainError } from './errors';
import { pendingRentTag } from './queries/pending-rent';
import type { Level, Module } from '@/domain/permissions';

import type { ActionResult } from '@/lib/action-result';

export type { ActionResult };

/** Što handler smije vratiti uz podatke. */
export interface ActionMeta {
  message?: string;
  redirect?: string;
  /** Putanje koje treba osvježiti nakon uspjeha (zadano: cijela aplikacija). */
  revalidate?: string[];
}

/**
 * Omotač za server akcije: provjera prava, validacija ulaza (zod), prijevod
 * grešaka u poruku za korisnika i osvježavanje prikaza. Ulaz može biti obični
 * objekt ili FormData.
 */
export function action<S extends z.ZodTypeAny, R>(
  access: { module: Module; level?: Exclude<Level, 'none'> },
  schema: S,
  handler: (input: z.infer<S>, user: SessionUser) => Promise<R | (ActionMeta & { data?: R })>,
) {
  return async (raw: unknown): Promise<ActionResult<R>> => {
    try {
      const user = await requireAccess(access.module, access.level ?? 'edit');
      const input = schema.parse(raw instanceof FormData ? formDataToObject(raw) : raw);
      const out = await handler(input, user);
      const meta = isMeta(out) ? out : { data: out as R };
      for (const p of meta.revalidate ?? ['/']) revalidatePath(p, 'layout');
      // keširani broj rata najma (nadzorna ploča, računi) — svaka promjena u firmi ga poništava
      // (akcije samo za čitanje vraćaju `revalidate: []`)
      if (meta.revalidate?.length !== 0) revalidateTag(pendingRentTag(user.companyId));
      return { ok: true, data: meta.data as R, message: meta.message, redirect: meta.redirect };
    } catch (e) {
      return toError(e);
    }
  };
}

/**
 * Akcija bez prava modula: svaki prijavljeni korisnik (npr. vlastiti račun) ili
 * uz vlastitu provjeru `guard` (npr. samo administrator / opasna zona). Inače kao `action`.
 */
export function userAction<S extends z.ZodTypeAny, R>(
  schema: S,
  handler: (input: z.infer<S>, user: SessionUser) => Promise<R | (ActionMeta & { data?: R })>,
  guard?: (user: SessionUser) => void | Promise<void>,
) {
  return async (raw: unknown): Promise<ActionResult<R>> => {
    try {
      const user = await requireUser();
      if (guard) await guard(user);
      const input = schema.parse(raw instanceof FormData ? formDataToObject(raw) : raw);
      const out = await handler(input, user);
      const meta = isMeta(out) ? out : { data: out as R };
      for (const p of meta.revalidate ?? ['/']) revalidatePath(p, 'layout');
      // keširani broj rata najma (nadzorna ploča, računi) — svaka promjena u firmi ga poništava
      // (akcije samo za čitanje vraćaju `revalidate: []`)
      if (meta.revalidate?.length !== 0) revalidateTag(pendingRentTag(user.companyId));
      return { ok: true, data: meta.data as R, message: meta.message, redirect: meta.redirect };
    } catch (e) {
      return toError(e);
    }
  };
}

function isMeta(v: unknown): v is ActionMeta & { data?: unknown } {
  return !!v && typeof v === 'object' && ('message' in v || 'redirect' in v || 'revalidate' in v) && !Array.isArray(v);
}

export function toError(e: unknown): { ok: false; error: string; fields?: Record<string, string> } {
  if (e instanceof DomainError || e instanceof AuthError) return { ok: false, error: e.message };
  if (e instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const i of e.issues) fields[i.path.join('.')] ??= i.message;
    const first = e.issues[0];
    // vlastite (hrvatske) poruke idu same; zodove zadane (engleske) samo uz naziv polja
    const generic = first && /^(Required|Expected|Invalid|String must|Number must|Array must|Too )/.test(first.message);
    const error = !first ? 'Podaci nisu ispravni.' : generic ? `Podaci nisu ispravni (${first.path.join('.') || 'obrazac'}).` : first.message;
    return { ok: false, error, fields };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002') return { ok: false, error: 'Zapis s istom vrijednošću već postoji.' };
    if (e.code === 'P2025') return { ok: false, error: 'Zapis nije pronađen.' };
    if (e.code === 'P2003') return { ok: false, error: 'Zapis je povezan s drugim dokumentima i ne može se obrisati.' };
  }
  console.error('[action]', e);
  return { ok: false, error: 'Došlo je do neočekivane greške. Pokušajte ponovno.' };
}

/** FormData → objekt; ponovljeni ključevi postaju niz, prazni nizovi nestaju. */
export function formDataToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith('$ACTION')) continue;
    const val = typeof v === 'string' ? v : v;
    if (k in out) out[k] = ([] as unknown[]).concat(out[k], val);
    else out[k] = val;
  }
  return out;
}
