'use server';

import { z } from 'zod';
import { nonNegative, optKpd } from '@/lib/zod-checks';
import { action } from '@/server/action';
import { assert } from '@/server/errors';
import { zBool, zDate, zId, zIds, zMoney, zOptDate, zOptId, zOptInt, zOptMoney, zOptText } from '@/server/zod';
import {
  addPayment,
  createDraft,
  creditNote,
  deleteDraft,
  dropEmptyInvoiceContract,
  deletePayment,
  issueInvoice,
  markPaid,
  markUnpaid,
  stornoInvoice,
  updateDraft,
  type InvoiceInput,
} from '@/server/services/invoices';
import { hideDeviceCost, searchDevices } from '@/server/queries/sales';
import { db, transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { canSeeCost } from '@/domain/permissions';
import { hasRentLines, kpdValid } from '@/domain/sales-lines';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { amsCheckInvoice, refreshEInvoiceStatus, reportWithoutSending, resetEInvoiceTrace, validateEInvoice } from '@/server/fiscal/einvoice-ops';
import { afterIssue, fiscalizeInvoice, reportLatestPayment, sendEInvoice, withOutcome } from '@/server/fiscal';
import { checkInvoiceContract, openInvoiceContract } from '@/server/services/invoice-rent';

const zLine = z.object({
  kind: z.enum(['DEVICE', 'MODEL', 'SERVICE', 'MANUAL']),
  itemId: zOptId,
  modelId: zOptId,
  serviceId: zOptId,
  description: z.string().trim().min(1, 'Opis stavke je obavezan'),
  unit: zOptText,
  kpd: zOptText,
  qty: zMoney,
  unitPrice: zMoney,
  discountPct: zMoney.refine((v) => v >= 0 && v <= 100, 'Popust stavke mora biti između 0 i 100 %'),
  monthly: zOptMoney,
  months: zOptInt,
  warrantyMonths: zOptInt,
  agreedPrice: zBool,
  lineType: z.enum(['SALE', 'RENT']).nullable().optional(),
});

const zRentTerms = z.object({
  startDate: zDate,
  billing: z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ONCE']),
  months: zOptInt,
  seasonFrom: zOptInt,
  seasonTo: zOptInt,
});

const zCharge = z.object({
  kind: z.enum(['N', 'POVNAK', 'PP', 'PPMV']),
  label: zOptText,
  amount: zOptMoney,
  pct: zOptMoney,
});

const zInvoice = z.object({
  id: zOptId,
  issue: zBool,
  type: z.enum(['SALE', 'SERVICE', 'RENT']),
  kind: z.enum(['INVOICE', 'ADVANCE']),
  partnerId: zId,
  date: zDate,
  dueDate: zOptDate,
  deliveryDate: zOptDate,
  vatRate: zMoney.refine((v) => v >= 0 && v <= 100, 'Stopa PDV-a nije ispravna'),
  taxCategory: z.enum(['S', 'AE', 'K', 'G', 'E', 'O', 'Z']),
  taxExemptReason: zOptText,
  discountPct: zMoney.refine((v) => v >= 0 && v <= 100, 'Popust mora biti između 0 i 100 %'),
  discountAmount: zMoney.refine((v) => v >= 0, 'Popust ne može biti negativan'),
  advanceAmount: zMoney.refine((v) => v >= 0, 'Predujam ne može biti negativan'),
  charges: z.array(zCharge).default([]),
  paymentMethod: z.enum(['TRANSFER', 'CASH', 'CARD', 'OTHER']).default('TRANSFER'),
  description: zOptText,
  note: zOptText,
  lines: z.array(zLine).min(1, 'Račun nema stavki'),
  /** Najam: id postojećeg ugovora, 'new' = novi ugovor s uvjetima `rent`, prazno = bez ugovora. */
  contractId: zOptId,
  period: z.preprocess((v) => (v === '' || v == null ? null : v), z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Razdoblje najma nije ispravno').nullable()).optional(),
  rent: zRentTerms.nullable().optional(),
  /** „Zatim naplata prelazi u": od datuma `from` novi uređaji prelaze na naplatu `billing`. */
  rentNext: z.object({ billing: z.enum(['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Upišite datum od kojeg naplata prelazi na drugu učestalost') }).nullable().optional(),
});

/**
 * Spremanje nacrta; uz `issue` se u istoj transakciji i izdaje. Fiskalizacija
 * (CIS / eRačun) ide nakon potvrde transakcije i ne ruši izdavanje.
 */
export const saveInvoice = action({ module: 'sales', level: 'edit' }, zInvoice, async (input, user) => {
  const res = await transaction(async (tx) => {
    const rentUsed = hasRentLines(input.type, input.lines);
    let contractId: string | null = null;
    let period: string | null = rentUsed ? (input.period ?? null) : null;
    let type = input.type;
    let before: string | null = null;
    if (input.id) {
      const cur = await tx.invoice.findFirst({ where: { id: input.id, companyId: user.companyId }, select: { type: true, contractId: true, period: true, status: true } });
      assert(cur, 'Račun ne postoji.');
      before = cur.contractId;
      // rata iz modula Najam (ugovor i razdoblje već zadani): ugovor i razdoblje se ne mijenjaju ovdje
      if (cur.type === 'RENT' && cur.contractId && cur.period && cur.status === 'DRAFT' && input.contractId === cur.contractId) {
        type = 'RENT';
        contractId = cur.contractId;
        period = input.period ?? cur.period;
      }
    }
    if (rentUsed && !contractId) {
      if (input.contractId === 'new') {
        assert(input.rent, 'Za novi ugovor zadajte uvjete najma.');
        contractId = (await openInvoiceContract(tx, user, input.partnerId, { ...input.rent, months: input.rent.months ?? null, seasonFrom: input.rent.seasonFrom ?? null, seasonTo: input.rent.seasonTo ?? null })).id;
      } else if (input.contractId) {
        contractId = (await checkInvoiceContract(tx, user, input.contractId, input.partnerId)).id;
      }
    }
    // naplata novih uređaja kreće od datuma računa (ne ranije od početka novog ugovora)
    const rentStart = input.contractId === 'new' && input.rent && input.rent.startDate > input.date ? input.rent.startDate : input.date;
    const rentNext = rentUsed && contractId && input.rentNext ? input.rentNext : null;
    if (rentNext) assert(rentNext.from > rentStart, 'Datum prijelaza na drugu naplatu mora biti nakon početka naplate.');
    const data: InvoiceInput = {
      type,
      kind: input.kind,
      partnerId: input.partnerId,
      date: input.date,
      dueDate: input.dueDate,
      deliveryDate: input.deliveryDate,
      // stopa PDV-a vrijedi samo za kategoriju S; ostale su 0 % (i u zbrojevima i u eRačunu)
      vatRate: input.taxCategory === 'S' ? input.vatRate : 0,
      taxCategory: input.taxCategory,
      taxExemptReason: input.taxCategory === 'S' ? null : input.taxExemptReason,
      discountPct: input.discountPct,
      discountAmount: input.discountAmount,
      advanceAmount: input.advanceAmount,
      charges: input.charges.map((c) => ({ kind: c.kind, label: c.label ?? undefined, amount: c.amount ?? undefined, pct: c.pct ?? undefined })),
      contractId,
      period,
      description: input.description,
      note: input.note,
      paymentMethod: input.paymentMethod,
      rentNext,
      // količina 0 se ne pretvara u 1 — servis je odbija s porukom
      lines: input.lines,
    };
    let id = input.id;
    if (id) await updateDraft(tx, user, id, data);
    else id = (await createDraft(tx, user, data)).id;
    // ugovor otvoren iz ovog nacrta, a više se ne koristi (promijenjen ugovor, nema stavki najma)
    if (before && before !== contractId) await dropEmptyInvoiceContract(tx, user, before);
    if (input.issue) {
      const { number } = await issueInvoice(tx, user, id);
      return { message: `Račun ${number} je izdan.`, redirect: `/prodaja/racuni/${id}`, data: { id }, issued: true };
    }
    return { message: 'Nacrt je spremljen.', redirect: `/prodaja/racuni/${id}`, data: { id }, issued: false };
  });
  const { issued, ...out } = res;
  if (!issued) return out;
  return { ...out, message: withOutcome(out.message, await afterIssue(out.data.id, user)) };
});

export const deleteInvoiceDraft = action({ module: 'sales', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await deleteDraft(tx, user, id);
    return { message: 'Nacrt je obrisan.', redirect: '/prodaja/racuni' };
  }),
);

// ---------------------------------------------------------------- uplate

export const addInvoicePayment = action(
  { module: 'sales', level: 'edit' },
  z.object({ invoiceId: zId, date: zDate, amount: zMoney, method: zOptText, note: zOptText }),
  async (p, user) => {
    await transaction((tx) => addPayment(tx, user, p.invoiceId, p));
    const r = await reportLatestPayment(p.invoiceId, user);
    return { message: r && !r.ok ? `Uplata je upisana. ${r.message}` : 'Uplata je upisana.' };
  },
);

export const deleteInvoicePayment = action({ module: 'sales', level: 'edit' }, z.object({ paymentId: zId }), async ({ paymentId }, user) =>
  transaction(async (tx) => {
    await deletePayment(tx, user, paymentId);
    return { message: 'Uplata je obrisana.' };
  }),
);

export const markInvoicePaid = action({ module: 'sales', level: 'edit' }, z.object({ invoiceId: zId, date: zOptDate }), async ({ invoiceId, date }, user) => {
  await transaction((tx) => markPaid(tx, user, invoiceId, date ?? undefined));
  const r = await reportLatestPayment(invoiceId, user);
  return { message: r && !r.ok ? `Račun je označen plaćenim. ${r.message}` : 'Račun je označen plaćenim.' };
});

export const markInvoiceUnpaid = action({ module: 'sales', level: 'edit' }, z.object({ invoiceId: zId }), async ({ invoiceId }, user) =>
  transaction(async (tx) => {
    await markUnpaid(tx, user, invoiceId);
    return { message: 'Račun je vraćen u neplaćeno.' };
  }),
);

// ---------------------------------------------------------------- storno i odobrenje

export const stornoInvoiceAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ invoiceId: zId, reason: zOptText, date: zOptDate }),
  async ({ invoiceId, reason, date }, user) => {
    const s = await transaction((tx) => stornoInvoice(tx, user, invoiceId, { reason: reason ?? undefined, date: date ?? undefined }));
    return { message: withOutcome('Storno je izdan.', await afterIssue(s.id, user)), redirect: `/prodaja/racuni/${s.id}` };
  },
);

export const creditNoteAction = action(
  { module: 'sales', level: 'edit' },
  z.object({ invoiceId: zId, description: z.string().trim().min(1, 'Opis je obavezan'), netAmount: zMoney, date: zOptDate }),
  async ({ invoiceId, description, netAmount, date }, user) => {
    const n = await transaction((tx) => creditNote(tx, user, invoiceId, { description, netAmount, date: date ?? undefined }));
    return { message: withOutcome('Odobrenje je izdano.', await afterIssue(n.id, user)), redirect: `/prodaja/racuni/${n.id}` };
  },
);

// ---------------------------------------------------------------- fiskalizacija i eRačun

/** Ponovno slanje u CIS (naknadna dostava) — poruka greške ide korisniku, račun ostaje izdan. */
export const refiscalizeInvoice = action({ module: 'sales', level: 'edit' }, z.object({ invoiceId: zId }), async ({ invoiceId }, user) => {
  const r = await fiscalizeInvoice(invoiceId, user);
  assert(r.ok, r.message);
  return { message: r.message };
});

export const sendEInvoiceAction = action({ module: 'sales', level: 'edit' }, z.object({ invoiceId: zId }), async ({ invoiceId }, user) => {
  const r = await sendEInvoice(invoiceId, user);
  assert(r.ok, r.message);
  return { message: r.message };
});

// ---------------------------------------------------------------- birač uređaja

export const findDevices = action(
  { module: 'sales', level: 'view' },
  z.object({
    q: zOptText,
    modelId: zOptId,
    categoryId: zOptId,
    warehouseId: zOptId,
    supplierId: zOptId,
    statusId: zOptId,
    partnerId: zOptId,
    itemIds: zIds.optional(),
    mode: z.enum(['stock', 'rented']).optional(),
    onlyPartner: zBool.optional(),
  }),
  async (s, user) => ({
    // bez prava „costs" nabavna cijena i marža ne idu u preglednik
    data: hideDeviceCost(await searchDevices(user.companyId, { ...s, q: s.q ?? undefined, itemIds: s.itemIds?.length ? s.itemIds : undefined }), canSeeCost(user.perms)),
    revalidate: [],
  }),
);

// ---------------------------------------------------------------- račun za najam: ugovori kupca

/** Ugovori kupca na koje se mogu dodati uređaji (aktivni i pauzirani). */
export const partnerContracts = action({ module: 'sales', level: 'view' }, z.object({ partnerId: zId }), async ({ partnerId }, user) => ({
  data: (
    await db.contract.findMany({
      where: { companyId: user.companyId, partnerId, status: { in: ['ACTIVE', 'PAUSED'] } },
      orderBy: [{ startDate: 'desc' }],
      take: 100,
      select: { id: true, number: true, billing: true, startDate: true, seasonFrom: true, seasonTo: true, status: true, _count: { select: { items: true } } },
    })
  ).map((c) => ({ id: c.id, number: c.number, billing: c.billing, startDate: toISO(c.startDate), seasonFrom: c.seasonFrom, seasonTo: c.seasonTo, status: c.status, devices: c._count.items })),
  revalidate: [],
}));

// ---------------------------------------------------------------- cjenik kupca

/**
 * „Primijeni cjenik kupca": dogovorene cijene kupca po modelu (prodaja ili
 * mjesečni najam) za stavke s uređajem ili modelom. Vraća cijenu po ključu stavke.
 */
export const customerPrices = action(
  { module: 'sales', level: 'view' },
  z.object({ partnerId: zId, lines: z.array(z.object({ key: z.string().min(1), modelId: zOptId, itemId: zOptId, lineType: z.enum(['SALE', 'RENT']).nullable().optional() })).max(2000) }),
  async ({ partnerId, lines }, user) => {
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is string => !!x))];
    const items = itemIds.length ? await db.item.findMany({ where: { companyId: user.companyId, id: { in: itemIds } }, select: { id: true, modelId: true } }) : [];
    const modelOf = new Map(items.map((i) => [i.id, i.modelId]));
    const modelIds = [...new Set(lines.map((l) => l.modelId ?? (l.itemId ? modelOf.get(l.itemId) : null)).filter((x): x is string => !!x))];
    const agreements = modelIds.length
      ? await db.priceAgreement.findMany({ where: { companyId: user.companyId, partnerId, modelId: { in: modelIds } }, select: { modelId: true, salePrice: true, rentPrice: true } })
      : [];
    const byModel = new Map(agreements.map((a) => [a.modelId, a]));
    const out: Record<string, number> = {};
    for (const l of lines) {
      const a = byModel.get(l.modelId ?? (l.itemId ? modelOf.get(l.itemId) ?? '' : ''));
      const v = l.lineType === 'RENT' ? a?.rentPrice : a?.salePrice;
      if (v != null && num(v) > 0) out[l.key] = num(v);
    }
    return { data: out, revalidate: [] };
  },
);

// ---------------------------------------------------------------- nova usluga iz birača

export const createServiceQuick = action(
  { module: 'sales', level: 'edit' },
  z.object({
    name: z.string().trim().min(1, 'Naziv usluge je obavezan').max(200, 'Naziv je predug'),
    unit: z.string().trim().max(20).default('kom'),
    price: zMoney.refine(nonNegative, 'Cijena ne može biti negativna'),
    kpd: zOptText.refine(optKpd, 'KPD šifra mora biti oblika NN.NN.NN'),
  }),
  async (input, user) =>
    transaction(async (tx) => {
      const exists = await tx.service.findFirst({ where: { companyId: user.companyId, name: input.name }, select: { id: true } });
      assert(!exists, `Usluga „${input.name}" već postoji u šifrarniku.`);
      const s = await tx.service.create({ data: { companyId: user.companyId, name: input.name, unit: input.unit || 'kom', price: input.price, kpd: input.kpd } });
      await audit(tx, user, { entity: 'service', entityId: s.id, action: 'create', summary: `Usluga ${s.name} dodana u šifrarnik (iz računa)` });
      return { message: 'Usluga je dodana u šifrarnik.', data: { id: s.id, name: s.name, unit: s.unit, price: num(s.price), kpd: s.kpd }, revalidate: [] };
    }),
);

// ---------------------------------------------------------------- eRačun: radnje na izdanom računu

const zInv = z.object({ invoiceId: zId });
const outcome = (r: { ok: boolean; message: string; lines?: string[] }) => {
  assert(r.ok, [r.message, ...(r.lines ?? [])].join(' '));
  return { message: r.message };
};

export const validateEInvoiceAction = action({ module: 'sales', level: 'view' }, zInv, async ({ invoiceId }, user) => outcome(await validateEInvoice(invoiceId, user)));
export const refreshEInvoiceAction = action({ module: 'sales', level: 'edit' }, zInv, async ({ invoiceId }, user) => outcome(await refreshEInvoiceStatus(invoiceId, user)));
export const amsCheckAction = action({ module: 'sales', level: 'view' }, zInv, async ({ invoiceId }, user) => outcome(await amsCheckInvoice(invoiceId, user)));
export const fiscalizeIrAction = action({ module: 'sales', level: 'edit' }, zInv, async ({ invoiceId }, user) => outcome(await reportWithoutSending(invoiceId, user, 'IR')));
export const reportTypeIAction = action({ module: 'sales', level: 'edit' }, zInv, async ({ invoiceId }, user) => outcome(await reportWithoutSending(invoiceId, user, 'I')));
export const resetEInvoiceAction = action({ module: 'sales', level: 'edit' }, zInv, async ({ invoiceId }, user) => outcome(await resetEInvoiceTrace(invoiceId, user)));
