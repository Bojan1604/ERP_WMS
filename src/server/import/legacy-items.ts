/**
 * Stara baza → plan: uređaji (serijski i razlikovna napomena, model, status i
 * stanje, veze) i veza uređaja na zadnji račun.
 */
import type { z } from 'zod';
import type { LegacyCtx } from './legacy-ctx';
import type { legacyItem } from './legacy-parse';
import { cleanSpec, type PlanItem, type PlanModel } from './plan';
import type { StatusKind } from '@prisma/client';
import type { Key } from './plan';

/** Status za uređaj s nepoznatim statusom: s kupcem „ostalo", inače na skladištu. */
function statusFallback(ctx: LegacyCtx, hasPartner: boolean): { key: Key; kind: StatusKind } {
  const kind: StatusKind = hasPartner ? 'OTHER' : 'IN_STOCK';
  let st = ctx.plan.statuses.find((s) => s.kind === kind && (kind === 'OTHER' || s.system));
  if (!st) {
    st = { key: ctx.genKey('status'), name: 'Nepoznat status (uvoz)', kind: 'OTHER', color: 'gray', system: false, sort: 999 };
    ctx.plan.statuses.push(st);
  }
  return { key: st.key, kind: st.kind };
}

const rawInvoiceOf = new WeakMap<PlanItem, string>();

export function mapItems(ctx: LegacyCtx, list: Array<z.infer<typeof legacyItem>>) {
  const notesBySerial = new Map<string, Set<string>>();
  const modelByKey = new Map<Key, PlanModel>(ctx.plan.models.map((m) => [m.key, m]));
  let noSerial = 0;
  for (const [i, r] of list.entries()) {
    let serial = r.serial;
    const where = `Uređaj ${serial || `#${i + 1}`}`;
    if (r.id && ctx.items.has(r.id)) {
      ctx.w.warn('dup-id', 'uređaj', `${where}: id se ponavlja — drugi zapis preskočen.`);
      continue;
    }
    if (!serial) {
      serial = `BEZ-SN-${++noSerial}`;
      ctx.w.warn('item-no-serial', 'uređaj', `Uređaj #${i + 1} nema serijski broj — upisan „${serial}".`);
    }
    // isti serijski dopušten je samo uz različitu razlikovnu napomenu
    let dupNote = r.dupNote || null;
    const notes = notesBySerial.get(serial);
    if (!notes) notesBySerial.set(serial, new Set([(dupNote ?? '').toLowerCase()]));
    else {
      if (!dupNote || notes.has(dupNote.toLowerCase())) {
        let k = notes.size + 1;
        while (notes.has(`uvoz ${k}`)) k++;
        const was = dupNote;
        dupNote = `uvoz ${k}`;
        ctx.w.warn('dup-serial', 'uređaj', `Serijski broj ${serial} se ponavlja${was ? ` s istom napomenom „${was}"` : ' bez razlikovne napomene'} — upisana napomena „${dupNote}".`);
      }
      notes.add(dupNote.toLowerCase());
    }
    let modelKey = r.modelId ? ctx.models.get(r.modelId) : undefined;
    if (!modelKey) {
      ctx.w.warn('ref-model', 'veza', `${where}: model „${r.modelId ?? ''}" ne postoji — „Nepoznat model (uvoz)".`);
      modelKey = ctx.modelPlaceholder();
    }
    let st = r.statusId ? ctx.statuses.get(r.statusId) : undefined;
    if (!st) {
      const fb = statusFallback(ctx, !!r.partnerId);
      ctx.w.warn('ref-status', 'veza', `${where}: nepoznat status „${r.statusId ?? ''}" — ${fb.kind === 'IN_STOCK' ? 'na skladištu' : 'status „ostalo"'}.`);
      st = { ...fb, name: '' };
    }
    // kategorija po komadu samo kad odstupa od kategorije modela (null = kategorija modela)
    const model = modelByKey.get(modelKey);
    let categoryKey: Key | null = null;
    if (r.categoryId) {
      const cat = ctx.categories.get(r.categoryId);
      if (!cat) ctx.w.warn('ref-category', 'veza', `${where}: kategorija „${r.categoryId}" ne postoji — vrijedi kategorija modela.`);
      else if (cat !== model?.categoryKey) categoryKey = cat;
    }
    const cost = ctx.money(r.cost, where, 'nabavna cijena', 0);
    const sale = ctx.money(r.salePrice, where, 'prodajna cijena', null);
    const rent = ctx.money(r.rentPrice, where, 'najam', null);
    const item: PlanItem = {
      key: r.id ?? ctx.genKey('item'), serial, dupNote, modelKey, statusKey: st.key, state: st.kind,
      warehouseKey: ctx.warehouse(r.warehouseId, where), supplierKey: ctx.partner(r.supplierId, where, 'dobavljač'),
      partnerKey: ctx.partner(r.partnerId, where, 'kupac'), invoiceKey: null, receiptKey: null,
      cost, salePrice: sale && sale > 0 ? sale : null, rentPrice: rent && rent > 0 ? rent : null, marginPct: ctx.num(r.marginPct, where, 'marža', null),
      importDate: ctx.date(r.importDate, where, 'datum uvoza'), issueDate: ctx.date(r.issueDate, where, 'datum izdavanja'),
      warrantyStart: ctx.date(r.warrantyStart, where, 'početak jamstva'), warrantyMonths: ctx.int(r.warrantyMonths, where, 'jamstvo', 0, 600),
      outAt: ctx.ts(r.outAt), outPartnerKey: r.outPartnerId ? (ctx.partners.get(r.outPartnerId) ?? null) : null, outNote: r.outNote || null,
      writeOffDate: ctx.date(r.writeOffDate, where, 'otpis'), writeOffReason: [r.writeOffReason, r.writeOffNote].filter(Boolean).join(' — ') || null,
      note: r.note || null, createdAt: ctx.ts(r.createdAt),
      // specifikacije po komadu; bez njih zadano s modela (kao pri zaprimanju)
      categoryKey, cpu: cleanSpec(r.cpu) ?? model?.cpu ?? null, screen: cleanSpec(r.screen) ?? model?.screen ?? null, os: cleanSpec(r.os) ?? model?.os ?? null,
    };
    if (item.state === 'IN_STOCK' && !item.warehouseKey) item.warehouseKey = ctx.defaultWarehouse();
    if (r.invoiceId) rawInvoiceOf.set(item, r.invoiceId);
    ctx.plan.items.push(item);
    if (r.id) ctx.items.set(r.id, item);
  }
}

/** Zadnji račun uređaja (veza postoji tek kad su računi učitani). */
export function linkItemInvoices(ctx: LegacyCtx) {
  for (const it of ctx.plan.items) {
    const inv = rawInvoiceOf.get(it);
    if (!inv) continue;
    if (ctx.invoices.has(inv)) it.invoiceKey = inv;
    else if (it.state !== 'IN_STOCK') ctx.w.warn('ref-invoice', 'veza', `Uređaj ${it.serial}: račun „${inv}" ne postoji — veza izostavljena.`);
  }
}
