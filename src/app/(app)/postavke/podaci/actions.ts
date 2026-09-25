'use server';

import { z } from 'zod';
import { emptyToNumber, inRange } from '@/lib/zod-checks';
import { action, userAction } from '@/server/action';
import { db, transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { AuthError, DomainError } from '@/server/errors';
import { verifyPassword, type SessionUser } from '@/server/auth';
import { zBool, zInt, zReq } from '@/server/zod';
import { canUseDanger } from '@/domain/permissions';
import { createBackup, deleteBackup, readBackup } from '@/server/jobs/backups';
import { planFromJson } from '@/server/import/analyze';
import { runImport } from '@/server/import/run';
import { withUserLock } from '@/server/import/upload';
import { assertDemo, confirmDanger, deleteEverything, deleteTransactions, resetDemo } from '@/server/services/danger';
import { cleanAuditLog, fixIntegrity, resetDefaultStatuses } from '@/server/services/maintenance';

const adminOnly = (u: SessionUser) => {
  if (u.role !== 'ADMIN') throw new AuthError('Ovu radnju smije samo administrator.', 403);
};
const dangerOnly = (u: SessionUser) => {
  if (!canUseDanger({ role: u.role, canDanger: u.canDanger })) throw new AuthError('Nemate pravo na opasnu zonu.', 403);
};
const zBackupName = z.string().regex(/^kopija-[\d-]+-(auto|rucna)\.json\.gz$/, 'Neispravan naziv kopije');
const zConfirm = { password: z.string().min(1, 'Upišite lozinku'), companyName: zReq('Naziv firme') };

// ---------------------------------------------------------------- sigurnosne kopije

export const backupNowAction = userAction(z.object({}), async (_i, user) => {
  const b = await createBackup(user.companyId, 'rucna');
  await transaction((tx) => audit(tx, user, { entity: 'company', entityId: user.companyId, action: 'backup', summary: `Napravljena sigurnosna kopija ${b.name}` }));
  return { message: `Kopija je spremljena (${Math.round(b.size / 1024)} KB).` };
}, adminOnly);

export const deleteBackupAction = userAction(z.object({ name: zBackupName }), async ({ name }, user) => {
  await deleteBackup(user.companyId, name);
  await transaction((tx) => audit(tx, user, { entity: 'company', entityId: user.companyId, action: 'backup-delete', summary: `Obrisana sigurnosna kopija ${name}` }));
  return { message: 'Kopija je obrisana.' };
}, adminOnly);

export const backupSettingsAction = action(
  { module: 'settings', level: 'edit' },
  z.object({
    autoBackup: zBool,
    backupKeep: zInt.refine(inRange(1, 365), 'Broj kopija mora biti 1–365'),
    backupReminderDays: zInt.refine(inRange(0, 365), 'Podsjetnik mora biti 0–365 dana'),
  }),
  async (input, user) => {
    await transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { autoBackup: true, backupKeep: true, backupReminderDays: true } });
      await tx.company.update({ where: { id: user.companyId }, data: input });
      await audit(tx, user, { entity: 'company', entityId: user.companyId, action: 'update', summary: 'Postavke sigurnosnih kopija izmijenjene', diff: { from: before, to: input } });
    });
    return { message: 'Postavke kopija spremljene.' };
  },
);

/**
 * Vraćanje kopije s poslužitelja — kao vraćanje preuzete kopije: u NOVU firmu
 * (trenutni podaci ostaju netaknuti), s novim administratorom; vi dobivate pristup.
 */
export const restoreBackupAction = userAction(z.object({ name: zBackupName, newName: z.string().trim().max(200).default(''), password: z.string().min(1, 'Upišite lozinku') }), async (input, user) => {
  const ok = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
  if (!(await verifyPassword(input.password, ok.passwordHash))) throw new DomainError('Lozinka nije ispravna.');
  return withUserLock(user.id, async () => {
    const { plan } = planFromJson(await readBackup(user.companyId, input.name));
    if (plan.source.format !== 'erp-wms-backup') throw new DomainError('Datoteka nije sigurnosna kopija ovog programa.');
    const r = await runImport(plan, {
      target: { kind: 'new', name: input.newName || `${plan.company.name ?? user.companyName} (kopija ${input.name.slice(7, 17)})` },
      actor: { id: user.id, name: user.name, email: user.email, companyId: user.companyId },
      summary: `Vraćanje iz sigurnosne kopije ${input.name}`,
    });
    return { message: `Kopija je vraćena u novu firmu „${r.companyName}".`, data: { companyName: r.companyName, admin: r.admin ?? null } };
  });
}, async (u) => {
  adminOnly(u);
  dangerOnly(u);
});

// ---------------------------------------------------------------- opasna zona

export const deleteTransactionsAction = userAction(z.object(zConfirm), async (input, user) => {
  const counts = await db.$transaction(
    async (tx) => {
      await confirmDanger(tx, user, input);
      return deleteTransactions(tx, user);
    },
    { maxWait: 20_000, timeout: 10 * 60_000 },
  );
  return { message: `Promet je obrisan (${counts.Item} uređaja, ${counts.Invoice} računa, ${counts.Contract} ugovora). Partneri, šifrarnici i korisnici su ostali.`, redirect: '/' };
}, dangerOnly);

export const deleteEverythingAction = userAction(z.object(zConfirm), async (input, user) => {
  await db.$transaction(
    async (tx) => {
      await confirmDanger(tx, user, input);
      return deleteEverything(tx, user);
    },
    { maxWait: 20_000, timeout: 10 * 60_000 },
  );
  return { message: 'Svi podaci firme su obrisani.', redirect: '/' };
}, dangerOnly);

export const resetDemoAction = userAction(z.object(zConfirm), async (input, user) => {
  await transaction(async (tx) => {
    await confirmDanger(tx, user, input);
    await assertDemo(tx, user.companyId);
  });
  await resetDemo();
  return { message: 'Demo podaci su vraćeni — prijavite se ponovno.', redirect: '/login' };
}, dangerOnly);

export const cleanLogAction = userAction(z.object({ days: z.preprocess(emptyToNumber, z.number().int().min(0).nullable()), password: z.string().min(1, 'Upišite lozinku') }), async (input, user) => {
  const n = await transaction(async (tx) => {
    const u = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
    if (!(await verifyPassword(input.password, u.passwordHash))) throw new DomainError('Lozinka nije ispravna.');
    return cleanAuditLog(tx, user, input.days);
  });
  return { message: `Obrisano ${n} zapisa iz dnevnika.` };
}, dangerOnly);

// ---------------------------------------------------------------- održavanje

export const fixIntegrityAction = userAction(z.object({}), async (_i, user) => {
  const fixed = await transaction((tx) => fixIntegrity(tx, user));
  const total = Object.values(fixed).reduce((a, b) => a + b, 0);
  return { message: total ? `Popravljeno ${total} zapisa.` : 'Nije bilo ničega za automatski popravak.' };
}, adminOnly);

export const resetStatusesAction = userAction(z.object({}), async (_i, user) => {
  const r = await transaction((tx) => resetDefaultStatuses(tx, user));
  return { message: `Zadani statusi vraćeni (${r.created} dodano, ${r.renamed} vraćeno na zadano).${r.skipped.length ? ` Naziv zauzet: ${r.skipped.join(', ')}.` : ''}` };
}, adminOnly);
