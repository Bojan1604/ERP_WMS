'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { assert } from '@/server/errors';
import { zBool, zDate, zId, zIds, zMoney, zOptDate, zOptId, zOptInt, zOptMoney, zOptText } from '@/server/zod';
import {
  addPayment,
  createDraft,
  creditNote,
  deleteDraft,
  deletePayment,
  issueInvoice,
  markPaid,
  markUnpaid,
  stornoInvoice,
  updateDraft,
  type InvoiceInput,
} from '@/server/services/invoices';
import { searchDevices } from '@/server/queries/sales';
import { afterIssue, fiscalizeInvoice, reportLatestPayment, sendEInvoice, withOutcome } from '@/server/fiscal';

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
});

/**
 * Spremanje nacrta; uz `issue` se u istoj transakciji i izdaje. Fiskalizacija
 * (CIS / eRačun) ide nakon potvrde transakcije i ne ruši izdavanje.
 */
export const saveInvoice = action({ module: 'sales', level: 'edit' }, zInvoice, async (input, user) => {
  const res = await transaction(async (tx) => {
    let contractId: string | null = null;
    let period: string | null = null;
    let type = input.type;
    if (input.id) {
      const cur = await tx.invoice.findFirst({ where: { id: input.id, companyId: user.companyId }, select: { type: true, contractId: true, period: true } });
      assert(cur, 'Račun ne postoji.');
      // najam, ugovor i razdoblje određuje modul najma — ovdje se samo čuvaju
      contractId = cur.contractId;
      period = cur.period;
      if (cur.type === 'RENT') type = 'RENT';
      else assert(type !== 'RENT', 'Račun za najam izdaje se iz modula Najam.');
    } else {
      assert(type !== 'RENT', 'Račun za najam izdaje se iz modula Najam.');
    }
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
      // količina 0 se ne pretvara u 1 — servis je odbija s porukom
      lines: input.lines,
    };
    let id = input.id;
    if (id) await updateDraft(tx, user, id, data);
    else id = (await createDraft(tx, user, data)).id;
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
  z.object({ q: zOptText, modelId: zOptId, categoryId: zOptId, warehouseId: zOptId, partnerId: zOptId, itemIds: zIds.optional() }),
  async (s, user) => ({
    data: await searchDevices(user.companyId, { ...s, q: s.q ?? undefined, itemIds: s.itemIds?.length ? s.itemIds : undefined }),
    revalidate: [],
  }),
);

