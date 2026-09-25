'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { zBool, zDate, zId, zIds, zMoney, zOptDate, zOptId, zOptMoney, zOptText, zReq } from '@/server/zod';
import { deleteSupplierInvoice, deleteSupplierInvoices, rebookSupplierInvoice, saveSupplierInvoice } from '@/server/services/supplier-invoices';
import { acceptSupplierInvoice, fetchProviderPdf, markSupplierInvoicesPaid, rejectSupplierInvoice, reportPaid } from '@/server/services/inbound';
import { fetchIncoming } from '@/server/services/inbound-fetch';
import { today } from '@/domain/dates';

const schema = z.object({
  id: zOptId,
  /** Odabrani partner ili slobodni unos (naziv + OIB) — partner se tada otvara pri spremanju. */
  supplierId: zOptId,
  supplierName: zOptText.optional(),
  supplierOib: zOptText.optional(),
  vatPct: zOptMoney.optional(),
  currency: zOptText.optional(),
  orderId: zOptId.optional(),
  receiptId: zOptId.optional(),
  number: zReq('Broj računa'),
  issueDate: zDate,
  dueDate: zOptDate,
  netAmount: zMoney,
  vatAmount: zMoney,
  total: zOptMoney,
  category: zOptText,
  note: zOptText,
  paidDate: zOptDate,
  book: zBool,
  /** „Ovo je račun za robu s primke"; null = zadano pravilo (iznos ≈ vrijednost robe, prvi povezani račun). */
  goods: z.boolean().nullable().optional(),
});

export const saveSupplierInvoiceAction = action({ module: 'purchasing', level: 'edit' }, schema, async ({ id, ...input }, user) => {
  const si = await transaction((tx) => saveSupplierInvoice(tx, user, id, input));
  // eRačun koji je upravo plaćen: status „plaćen" posredniku (neuspjeh ne poništava spremanje)
  const warning = si.newlyPaid && input.paidDate ? await reportPaid(user, [{ id: si.id, source: 'EINVOICE', eInvoiceId: si.eInvoiceId }], input.paidDate) : null;
  const extra = [si.supplierCreated && 'Dobavljač je otvoren u partnerima — dopunite adresu.', si.mode === 'receipt' && 'Trošak robe je knjižen primkom — račun ga ne knjiži ponovno.']
    .filter(Boolean)
    .join(' ');
  return { message: `Ulazni račun ${si.internalNo} spremljen.${extra ? ` ${extra}` : ''}`, redirect: `/nabava/ulazni/${si.id}`, data: { warning } };
});

export const supplierInvoicesPaidAction = action(
  { module: 'purchasing', level: 'edit' },
  z.object({ ids: zIds, paidDate: zOptDate }),
  async ({ ids, paidDate }, user) => {
    const r = await markSupplierInvoicesPaid(user, ids, paidDate);
    return { message: `${r.count} računa označeno kao ${paidDate ? 'plaćeno' : 'neplaćeno'}.`, data: { warning: r.warning } };
  },
);

/** „Plaćeno danas" na stranici računa. */
export const supplierInvoicePaidTodayAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  const r = await markSupplierInvoicesPaid(user, [id], today());
  return { message: 'Označeno kao plaćeno.', data: { warning: r.warning } };
});

export const fetchEInvoicesAction = action({ module: 'purchasing', level: 'edit' }, z.object({}), async (_input, user) => {
  const r = await fetchIncoming(user);
  const parts = [`novih ${r.created}`, `već upisanih ${r.existing}`];
  if (r.failed) parts.push(`neuspjelih ${r.failed}`);
  return {
    message: r.found ? `Preuzeti eRačuni${r.demo ? ' (demo)' : ''}: ${parts.join(', ')}.` : `Posrednik nema primljenih računa${r.demo ? ' (demo)' : ''}.`,
    data: { ...r, warning: r.errors.length ? r.errors.slice(0, 3).join(' · ') : null },
  };
});

export const acceptSupplierInvoiceAction = action(
  { module: 'purchasing', level: 'edit' },
  z.object({ id: zId, book: zBool }),
  async ({ id, book }, user) => {
    const r = await acceptSupplierInvoice(user, id, { book });
    const booked = book ? ' i knjižen kao trošak' : ' (bez knjiženja troška)';
    return {
      message: r.reported
        ? r.already
          ? `Račun prihvaćen (posrednik ga je već imao kao prihvaćen)${booked}.`
          : `Račun prihvaćen, javljen posredniku${booked}.`
        : `Račun prihvaćen${booked}.`,
    };
  },
);

export const rejectSupplierInvoiceAction = action(
  { module: 'purchasing', level: 'edit' },
  z.object({ id: zId, reason: zReq('Razlog odbijanja') }),
  async ({ id, reason }, user) => {
    const r = await rejectSupplierInvoice(user, id, reason);
    return { message: r.reported ? 'Račun odbijen — odbijanje je javljeno dobavljaču i Poreznoj upravi.' : 'Račun označen kao odbijen (ručni račun — nije nikome javljeno).' };
  },
);

/** Skupno brisanje ulaznih računa (sve ili ništa). */
export const deleteSupplierInvoicesAction = action({ module: 'purchasing', level: 'edit' }, z.object({ ids: zIds }), async ({ ids }, user) =>
  transaction(async (tx) => {
    const n = await deleteSupplierInvoices(tx, user, ids);
    return { message: `Obrisano ulaznih računa: ${n}.` };
  }),
);

/** „Knjiži ponovno" — trošak je obrisan ili račun nije knjižen. */
export const rebookSupplierInvoiceAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    const mode = await rebookSupplierInvoice(tx, user, id);
    return { message: mode === 'own' ? 'Račun je ponovno knjižen kao trošak.' : 'Trošak robe je već knjižen primkom — ništa se ne knjiži dvaput.' };
  }),
);

/** PDF posrednika na zahtjev (eRačun): dohvaća izvorni dokument i sprema ugrađeni PDF kao prilog. */
export const providerPdfAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) => {
  const r = await fetchProviderPdf(user, id);
  return { message: r.created ? 'PDF posrednika je preuzet i spremljen uz račun.' : 'PDF posrednika je već spremljen uz račun.', data: { url: `/api/nabava/ulazni/${id}/prilog/${r.attachmentId}` } };
});

export const deleteSupplierInvoiceAction = action({ module: 'purchasing', level: 'edit' }, z.object({ id: zId }), async ({ id }, user) =>
  transaction(async (tx) => {
    await deleteSupplierInvoice(tx, user, id);
    return { message: 'Ulazni račun je obrisan.', redirect: '/nabava/ulazni' };
  }),
);

/** Narudžbenice i primke dobavljača za vezu s ulaznim računom (samo čitanje). */
export const supplierDocsAction = action({ module: 'purchasing', level: 'view' }, z.object({ supplierId: zId }), async ({ supplierId }, user) => {
  const [orders, receipts] = await Promise.all([
    db.purchaseOrder.findMany({
      where: { companyId: user.companyId, supplierId, status: { not: 'CANCELLED' } },
      orderBy: [{ date: 'desc' }],
      take: 100,
      select: { id: true, number: true, date: true, supplierInvoiceNo: true },
    }),
    db.goodsReceipt.findMany({
      where: { companyId: user.companyId, supplierId, status: 'POSTED' },
      orderBy: [{ date: 'desc' }],
      take: 100,
      select: { id: true, number: true, date: true, orderId: true, expense: { select: { id: true } } },
    }),
  ]);
  return {
    data: {
      orders: orders.map((o) => ({ value: o.id, label: o.number, hint: `${o.date.toISOString().slice(0, 10)}${o.supplierInvoiceNo ? ` · račun ${o.supplierInvoiceNo}` : ''}` })),
      receipts: receipts.map((r) => ({ value: r.id, label: r.number, hint: `${r.date.toISOString().slice(0, 10)}${r.expense ? ' · trošak knjižen' : ''}`, orderId: r.orderId })),
    },
    revalidate: [],
  };
});
