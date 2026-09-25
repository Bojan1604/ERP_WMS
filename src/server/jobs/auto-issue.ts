import 'server-only';
import { db } from '../db';
import { audit } from '../audit';
import { DomainError } from '../errors';
import { afterIssue } from '../fiscal';
import { issuePending, pendingForCompany, tryLockInstallment } from '../services/rentals';
import type { Actor } from '../services/items';
import { fromISO, periodLabel, toISO, today } from '@/domain/dates';

/**
 * Automatsko izdavanje rata najma na dan dospijeća (Company.autoIssueRent).
 *
 * Sigurnost i idempotentnost:
 *  - dnevni posao se „prijavljuje" zapisom u dnevniku (entity `job`, entityId
 *    `auto-issue:YYYY-MM-DD`) unutar transakcije s advisory lockom po firmi —
 *    dva procesa (više instanci aplikacije) istog dana ne pokreću ga oba;
 *  - svaka rata se izdaje u vlastitoj transakciji pod advisory lockom
 *    (firma, ugovor, razdoblje) i `issuePending` ponovno provjerava je li rata
 *    još neizdana — dvostruko izdavanje nije moguće ni uz „Pokreni sada";
 *  - greška jedne rate (npr. ugovor bez uređaja) ne zaustavlja ostale.
 */
export const JOB_ENTITY = 'job';
export const jobKey = (day: string) => `auto-issue:${day}`;
export const AUTO_ACTOR_NAME = 'Automatsko izdavanje';

export interface AutoIssueResult {
  companyId: string;
  companyName: string;
  issued: string[];
  skipped: number;
  errors: string[];
  /** Posao je danas već odrađen (ili ga upravo radi drugi proces). */
  alreadyRan?: boolean;
}

/** Korisnik u čije ime se izdaje (prvi aktivni administrator; ime u dnevniku je „Automatsko izdavanje"). */
async function jobActor(companyId: string): Promise<Actor | null> {
  const u = await db.user.findFirst({
    where: { OR: [{ companyId }, { companies: { some: { companyId } } }], active: true, role: { in: ['ADMIN', 'MANAGER'] } },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
  return u ? { id: u.id, name: AUTO_ACTOR_NAME, companyId } : null;
}

/** Prijava dnevnog pokretanja: true = ovaj proces radi posao, false = već odrađeno / radi drugi. */
async function claimDay(companyId: string, actor: Actor, day: string, force: boolean): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${`auto-issue:${companyId}`})) AS ok`;
    if (!lock?.ok) return false;
    if (!force) {
      const done = await tx.auditLog.findFirst({ where: { companyId, entity: JOB_ENTITY, entityId: jobKey(day) }, select: { id: true } });
      if (done) return false;
    }
    await audit(tx, actor, { entity: JOB_ENTITY, entityId: jobKey(day), action: 'auto-issue', summary: `Automatsko izdavanje rata najma pokrenuto${force ? ' ručno („Pokreni sada")' : ''}` });
    return true;
  });
}

/**
 * Jedna firma: rate dospjele do `day` (uključivo), ali ne prije dana uključivanja
 * automatskog izdavanja (`Company.autoIssueSince`) — zaostale rate iz prošlosti
 * izdaje korisnik ručno (Najam → Za izdati), posao ih ne izdaje sam.
 */
export async function autoIssueCompany(companyId: string, opts: { day?: string; force?: boolean; fiscalize?: boolean } = {}): Promise<AutoIssueResult> {
  const day = opts.day ?? today();
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, autoIssueRent: true, autoIssueSince: true } });
  // „Pokreni sada" bez uključene opcije ne izdaje ništa i ne upisuje datum uključivanja
  if (!company.autoIssueRent) throw new DomainError('Automatsko izdavanje rata najma nije uključeno — uključite ga i spremite postavke.');
  // bez datuma uključivanja (stariji zapis) posao kreće od danas i to upisuje
  let since = company.autoIssueSince ? toISO(company.autoIssueSince) : null;
  if (!since) {
    since = day;
    await db.company.updateMany({ where: { id: companyId, autoIssueSince: null }, data: { autoIssueSince: fromISO(day) } });
  }
  const out: AutoIssueResult = { companyId, companyName: company.name, issued: [], skipped: 0, errors: [] };
  const actor = await jobActor(companyId);
  if (!actor) {
    out.errors.push('Firma nema aktivnog administratora u čije ime bi se izdavali računi.');
    return out;
  }
  if (!(await claimDay(companyId, actor, day, !!opts.force))) return { ...out, alreadyRan: true };

  const due = (await pendingForCompany(db, companyId, { now: day })).filter((p) => p.dueDate <= day && p.dueDate >= since);
  const ids: string[] = [];
  for (const p of due) {
    try {
      const r = await db.$transaction(
        async (tx) => {
          if (!(await tryLockInstallment(tx, companyId, p.contractId, p.period))) return null;
          // datum računa = dan posla (ne kasniji od danas)
          return issuePending(tx, actor, [{ contractId: p.contractId, period: p.period }], { date: day < today() ? day : today() });
        },
        { maxWait: 10_000, timeout: 60_000 },
      );
      if (!r) out.skipped++;
      else {
        out.issued.push(...r.numbers);
        ids.push(...r.ids);
      }
    } catch (e) {
      // rata je u međuvremenu izdana (ručno ili drugi proces) — nije greška
      const msg = e instanceof Error ? e.message : String(e);
      if (/nema rate za izdati/i.test(msg)) out.skipped++;
      else out.errors.push(`${p.contractNumber} (${periodLabel(p.period)}): ${msg}`);
    }
  }
  // fiskalizacija / eRačun nakon izdavanja (mrežni pozivi izvan transakcije)
  if (opts.fiscalize !== false && ids.length) {
    const pending = await db.invoice.findMany({ where: { companyId, id: { in: ids }, fiscalStatus: 'PENDING' }, select: { id: true } });
    for (const inv of pending) {
      const r = await afterIssue(inv.id, actor);
      if (r && !r.ok) out.errors.push(`Fiskalizacija računa nije uspjela: ${r.message}`);
    }
  }
  await db.$transaction((tx) =>
    audit(tx, actor, {
      entity: JOB_ENTITY,
      entityId: `${jobKey(day)}:done`,
      action: 'auto-issue',
      summary: `Automatski izdano ${out.issued.length} računa za rate najma${out.issued.length ? ` (${out.issued.slice(0, 10).join(', ')}${out.issued.length > 10 ? '…' : ''})` : ''}${out.errors.length ? ` · ${out.errors.length} grešaka` : ''}`,
      diff: out.errors.length ? { errors: out.errors.slice(0, 50) } : undefined,
    }),
  );
  return out;
}

/** Sve firme s uključenim automatskim izdavanjem (dnevni posao). */
export async function runAutoIssue(opts: { day?: string } = {}): Promise<AutoIssueResult[]> {
  const companies = await db.company.findMany({ where: { autoIssueRent: true }, select: { id: true } });
  const out: AutoIssueResult[] = [];
  for (const c of companies) {
    try {
      out.push(await autoIssueCompany(c.id, { day: opts.day }));
    } catch (e) {
      console.error('[auto-issue]', c.id, e);
    }
  }
  return out;
}
