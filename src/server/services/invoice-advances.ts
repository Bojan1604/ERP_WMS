import 'server-only';
import type { Tx } from '../db';
import { assert } from '../errors';
import type { Actor } from './items';
import { formatDate, toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { eur } from '@/lib/format';

/**
 * Uračunati predujmovi: konačni račun navodi račune za predujam (i iznos s PDV-om
 * koji uračunava). Iznos po predujmu ne smije premašiti neiskorišteni ostatak —
 * zbroj uračunatog na izdanim, nestorniranim konačnim računima — a ukupno uračunato
 * ne smije premašiti iznos računa (`assertAdvancesWithinTotal`). Zbroj uračunatog
 * na konačnom računu je `Invoice.advanceAmount` (PrepaidAmount i BillingReference u eRačunu).
 */

export interface AdvanceUseInput {
  advanceId: string;
  amount: number;
}

export interface AdvanceOption {
  id: string;
  number: string | null;
  date: string;
  total: number;
  /** Već uračunato na izdanim konačnim računima (bez ovog računa). */
  used: number;
  remaining: number;
}

/** Uračunato po predujmu na izdanim, nestorniranim konačnim računima (bez `exceptInvoiceId`). */
async function usedByAdvance(tx: Tx, advanceIds: string[], exceptInvoiceId?: string | null) {
  if (!advanceIds.length) return new Map<string, number>();
  const rows = await tx.advanceUse.groupBy({
    by: ['advanceId'],
    where: {
      advanceId: { in: advanceIds },
      invoice: { status: 'ISSUED', stornoed: false, ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}) },
    },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.advanceId, r2(num(r._sum.amount))]));
}

/** Izdani, nestornirani računi za predujam kupca s neiskorištenim ostatkom (za odabir na računu). */
export async function partnerAdvanceOptions(tx: Tx, companyId: string, partnerId: string, invoiceId?: string | null): Promise<AdvanceOption[]> {
  const advances = await tx.invoice.findMany({
    where: { companyId, partnerId, kind: 'ADVANCE', status: 'ISSUED', stornoed: false },
    orderBy: [{ date: 'desc' }, { seq: 'desc' }],
    take: 200,
    select: { id: true, number: true, date: true, grandTotal: true },
  });
  const used = await usedByAdvance(tx, advances.map((a) => a.id), invoiceId);
  // već odabrani na ovom računu ostaju na popisu i kad su u međuvremenu potrošeni
  const chosen = invoiceId ? new Set((await tx.advanceUse.findMany({ where: { invoiceId }, select: { advanceId: true } })).map((u) => u.advanceId)) : new Set<string>();
  return advances
    .map((a) => {
      const total = num(a.grandTotal);
      const u = used.get(a.id) ?? 0;
      return { id: a.id, number: a.number, date: toISO(a.date), total, used: u, remaining: r2(Math.max(0, total - u)) };
    })
    .filter((a) => a.remaining > 0.005 || chosen.has(a.id));
}

/**
 * Provjera uračunatih predujmova: isti kupac, izdani i nestornirani računi za
 * predujam, iznos veći od 0 i najviše neiskorišteni ostatak. Vraća očišćen popis.
 */
async function checkUses(tx: Tx, actor: Actor, inv: { id: string; partnerId: string; kind: string }, uses: AdvanceUseInput[]) {
  const merged = new Map<string, number>();
  for (const u of uses) merged.set(u.advanceId, r2((merged.get(u.advanceId) ?? 0) + u.amount));
  if (!merged.size) return [];
  assert(inv.kind === 'INVOICE', 'Predujam se uračunava samo na konačni račun.');
  const ids = [...merged.keys()];
  const advances = await tx.invoice.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: { id: true, number: true, date: true, kind: true, status: true, stornoed: true, partnerId: true, grandTotal: true },
  });
  assert(advances.length === ids.length, 'Neki računi za predujam ne postoje.');
  const used = await usedByAdvance(tx, ids, inv.id);
  return advances.map((a) => {
    const label = `Predujam ${a.number ?? ''}`.trim();
    assert(a.kind === 'ADVANCE' && a.status === 'ISSUED', `${label} nije izdani račun za predujam.`);
    assert(!a.stornoed, `${label} je storniran i ne može se uračunati.`);
    assert(a.partnerId === inv.partnerId, `${label} je izdan drugom kupcu.`);
    const amount = merged.get(a.id)!;
    assert(amount > 0, `${label}: uračunati iznos mora biti veći od 0.`);
    const remaining = r2(num(a.grandTotal) - (used.get(a.id) ?? 0));
    assert(
      amount <= remaining + 0.005,
      `${label} od ${formatDate(a.date)}: preostalo za uračunati je ${eur(remaining)} — ne može se uračunati ${eur(amount)}.`,
    );
    return { advanceId: a.id, amount };
  });
}

/** Upis uračunatih predujmova na nacrt (zamjenjuje dosadašnje); `Invoice.advanceAmount` = zbroj. */
export async function setAdvanceUses(tx: Tx, actor: Actor, inv: { id: string; partnerId: string; kind: string }, uses: AdvanceUseInput[]) {
  const checked = await checkUses(tx, actor, inv, uses);
  await tx.advanceUse.deleteMany({ where: { invoiceId: inv.id } });
  if (checked.length) await tx.advanceUse.createMany({ data: checked.map((u) => ({ invoiceId: inv.id, ...u })) });
  const total = r2(checked.reduce((a, u) => a + u.amount, 0));
  await tx.invoice.update({ where: { id: inv.id }, data: { advanceAmount: total } });
  return total;
}

/**
 * Pri izdavanju konačnog računa: zaključavanje računa za predujam i ponovna
 * provjera ostatka — dva istodobna računa ne uračunavaju isti predujam iznad iznosa.
 */
export async function checkAdvancesAtIssue(tx: Tx, actor: Actor, inv: { id: string; partnerId: string; kind: string }) {
  const uses = await tx.advanceUse.findMany({ where: { invoiceId: inv.id }, orderBy: { advanceId: 'asc' }, select: { advanceId: true, amount: true } });
  if (!uses.length) return;
  for (const u of uses) await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${u.advanceId} FOR UPDATE`;
  await checkUses(tx, actor, inv, uses.map((u) => ({ advanceId: u.advanceId, amount: num(u.amount) })));
}

/**
 * Zbroj uračunatih predujmova ne smije prijeći ukupni iznos računa (s PDV-om) —
 * inače bi „za platiti" bio negativan, a eRačun kršio BR-CO-16. Poziva se nakon
 * `recalcInvoice` (spremanje nacrta) i pri izdavanju.
 */
export async function assertAdvancesWithinTotal(tx: Tx, invoiceId: string) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { kind: true, grandTotal: true, advanceAmount: true } });
  const advance = num(inv.advanceAmount);
  if (inv.kind !== 'INVOICE' || advance <= 0) return;
  const total = num(inv.grandTotal);
  assert(
    advance <= total + 0.005,
    `Uračunati predujam (${eur(advance)}) veći je od iznosa računa (${eur(total)}) — smanjite uračunati iznos na najviše ${eur(Math.max(0, total))}.`,
  );
}

/** Storno računa za predujam: ne smije biti uračunat u važeći konačni račun. */
export async function assertAdvanceNotUsed(tx: Tx, advanceId: string) {
  // izdani konačni račun ima prednost u poruci pred nacrtom
  const use = await tx.advanceUse.findFirst({
    where: { advanceId, invoice: { stornoed: false, kind: 'INVOICE' } },
    orderBy: { invoice: { status: 'desc' } },
    select: { invoice: { select: { number: true, status: true } } },
  });
  assert(
    !use,
    use?.invoice.status === 'ISSUED'
      ? `Predujam je uračunat u račun ${use.invoice.number} — prvo stornirajte taj račun.`
      : 'Predujam je uračunat u nacrt računa — prvo ga uklonite s nacrta.',
  );
}
