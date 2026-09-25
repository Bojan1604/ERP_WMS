import 'server-only';
import type { OrderStatus, Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { DomainError, assert } from '../errors';
import { nextDocNumber } from '../numbering';
import { audit } from '../audit';
import { statusFor, type Actor } from './items';
import { formatDate, fromISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { supplierVat } from '@/domain/tax';
import { receiptBooksExpense } from '@/domain/purchase-links';
import { lockPurchaseDocs, paidGoodsInvoiceDate, syncOrderSupplierInvoice } from './supplier-invoices';

// =============================================================================
//  Nabava: narudžbenice i primke (zaprimanje robe). Ulazni računi (URA) → expenses.ts
// =============================================================================

export const PURCHASE_CATEGORY = 'Nabava robe';

/** Kategorija troška po nazivu — otvara se ako je firma nema. */
export async function expenseCategoryId(tx: Tx, companyId: string, name: string) {
  const c = await tx.expenseCategory.upsert({
    where: { companyId_name: { companyId, name } },
    update: {},
    create: { companyId, name },
    select: { id: true },
  });
  return c.id;
}

async function vatFor(tx: Tx, companyId: string, supplierCountry: string | null | undefined, net: number) {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { vatRate: true, country: true } });
  const t = supplierVat(supplierCountry, { vatRate: num(company.vatRate), country: company.country });
  return r2((net * t.rate) / 100);
}

// ---------------------------------------------------------------- narudžbenice

export interface OrderLineInput {
  id?: string | null;
  modelId: string;
  qty: number;
  unitCost: number;
}

export interface OrderInput {
  supplierId: string;
  date: string;
  expectedDate?: string | null;
  note?: string | null;
  lines: OrderLineInput[];
}

export async function saveOrder(tx: Tx, actor: Actor, id: string | null, input: OrderInput) {
  const supplier = await tx.partner.findFirst({ where: { id: input.supplierId, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(supplier, 'Dobavljač ne postoji.');
  assert(input.lines.length > 0, 'Narudžbenica mora imati barem jednu stavku.');
  const modelIds = [...new Set(input.lines.map((l) => l.modelId))];
  const models = await tx.deviceModel.count({ where: { id: { in: modelIds }, companyId: actor.companyId } });
  assert(models === modelIds.length, 'Neki modeli ne postoje.');
  input.lines.forEach((l, i) => {
    assert(Number.isInteger(l.qty) && l.qty > 0, `Stavka ${i + 1}: količina mora biti cijeli broj veći od 0.`);
    assert(l.unitCost >= 0, `Stavka ${i + 1}: nabavna cijena ne može biti negativna.`);
  });
  const total = r2(input.lines.reduce((a, l) => a + l.qty * r2(l.unitCost), 0));
  const header = {
    supplierId: supplier.id,
    date: fromISO(input.date),
    expectedDate: input.expectedDate ? fromISO(input.expectedDate) : null,
    note: input.note ?? null,
    total,
  };

  if (!id) {
    const number = await nextDocNumber(tx, actor.companyId, 'ORDER', Number(input.date.slice(0, 4)));
    const order = await tx.purchaseOrder.create({
      data: {
        companyId: actor.companyId,
        number,
        ...header,
        createdBy: actor.name,
        lines: { create: input.lines.map((l) => ({ modelId: l.modelId, qty: l.qty, unitCost: r2(l.unitCost) })) },
      },
      select: { id: true, number: true },
    });
    await audit(tx, actor, { entity: 'purchaseOrder', entityId: order.id, action: 'create', summary: `Narudžbenica ${number} za ${supplier.name}` });
    return order;
  }

  const order = await tx.purchaseOrder.findFirst({ where: { id, companyId: actor.companyId }, include: { lines: true } });
  assert(order, 'Narudžbenica ne postoji.');
  assert(order.status !== 'RECEIVED' && order.status !== 'CANCELLED', 'Zaprimljena ili otkazana narudžbenica se ne mijenja.');
  const kept = new Set(input.lines.map((l) => l.id).filter(Boolean));
  for (const old of order.lines) {
    if (!kept.has(old.id)) assert(old.received === 0, 'Stavka koja je već (djelomično) zaprimljena ne može se obrisati.');
  }
  await tx.purchaseOrderLine.deleteMany({ where: { orderId: id, id: { notIn: [...kept] as string[] } } });
  for (const l of input.lines) {
    const old = l.id ? order.lines.find((x) => x.id === l.id) : undefined;
    if (old) {
      assert(l.qty >= old.received, `Količina ne može biti manja od već zaprimljene (${old.received}).`);
      assert(old.received === 0 || old.modelId === l.modelId, 'Model zaprimljene stavke se ne može promijeniti.');
      await tx.purchaseOrderLine.update({ where: { id: old.id }, data: { modelId: l.modelId, qty: l.qty, unitCost: r2(l.unitCost) } });
    } else {
      await tx.purchaseOrderLine.create({ data: { orderId: id, modelId: l.modelId, qty: l.qty, unitCost: r2(l.unitCost) } });
    }
  }
  await tx.purchaseOrder.update({ where: { id }, data: header });
  await recalcOrderStatus(tx, id);
  await audit(tx, actor, { entity: 'purchaseOrder', entityId: id, action: 'update', summary: `Narudžbenica ${order.number} izmijenjena` });
  return { id, number: order.number };
}

/** Status narudžbenice iz zaprimljenih količina (nacrt i otkazana ostaju kakve jesu). */
export async function recalcOrderStatus(tx: Tx, orderId: string) {
  const order = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, lines: { select: { qty: true, received: true } } } });
  if (order.status === 'CANCELLED') return order.status;
  const received = order.lines.reduce((a, l) => a + l.received, 0);
  let status: OrderStatus;
  if (received === 0) status = order.status === 'DRAFT' ? 'DRAFT' : 'ORDERED';
  else status = order.lines.every((l) => l.received >= l.qty) ? 'RECEIVED' : 'PARTIAL';
  if (status !== order.status) await tx.purchaseOrder.update({ where: { id: orderId }, data: { status } });
  return status;
}

export async function setOrderStatus(tx: Tx, actor: Actor, id: string, to: 'ORDERED' | 'CANCELLED' | 'DRAFT') {
  const order = await tx.purchaseOrder.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, number: true, status: true } });
  assert(order, 'Narudžbenica ne postoji.');
  if (to === 'ORDERED') assert(order.status === 'DRAFT', 'Dobavljaču se šalje samo nacrt.');
  if (to === 'DRAFT') assert(order.status === 'ORDERED' || order.status === 'CANCELLED', 'U nacrt se vraća samo poslana ili otkazana narudžbenica bez zaprimljene robe.');
  if (to === 'CANCELLED') assert(order.status !== 'RECEIVED' && order.status !== 'CANCELLED', 'Zaprimljena narudžbenica se ne otkazuje.');
  if (to === 'DRAFT') {
    const received = await tx.purchaseOrderLine.aggregate({ where: { orderId: id }, _sum: { received: true } });
    assert(!received._sum.received, 'Narudžbenica ima zaprimljenu robu.');
  }
  await tx.purchaseOrder.update({ where: { id }, data: { status: to } });
  const label = { ORDERED: 'poslana dobavljaču', CANCELLED: 'otkazana', DRAFT: 'vraćena u nacrt' }[to];
  await audit(tx, actor, { entity: 'purchaseOrder', entityId: id, action: 'status', summary: `Narudžbenica ${order.number} ${label}` });
}

export async function deleteOrder(tx: Tx, actor: Actor, id: string) {
  const order = await tx.purchaseOrder.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, number: true } });
  assert(order, 'Narudžbenica ne postoji.');
  const posted = await tx.goodsReceipt.count({ where: { orderId: id, status: 'POSTED' } });
  assert(!posted, 'Po narudžbenici postoje proknjižene primke — prvo ih stornirajte ili otkažite narudžbenicu.');
  await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'purchaseOrder', entityId: id } });
  await tx.purchaseOrder.delete({ where: { id } });
  await audit(tx, actor, { entity: 'purchaseOrder', entityId: id, action: 'delete', summary: `Narudžbenica ${order.number} obrisana` });
}

// ---------------------------------------------------------------- primke

export interface ReceiveLineInput {
  modelId: string;
  unitCost: number;
  serials: string[];
  /** Stavka narudžbenice koju primka zatvara (količina se dodaje na `received`). */
  orderLineId?: string | null;
}

export interface ReceiveInput {
  supplierId?: string | null;
  orderId?: string | null;
  warehouseId: string;
  /** Datum primke = datum uvoza uređaja. */
  date: string;
  supplierDocNumber?: string | null;
  note?: string | null;
  lines: ReceiveLineInput[];
  /** Knjiži nabavnu vrijednost kao trošak „Nabava robe" (zadano da). */
  bookExpense?: boolean;
}

/**
 * Zaprimanje robe: primka, uređaji na skladištu (skupni upis), povijest,
 * zaprimljene količine na narudžbenici i jedan trošak „Nabava robe".
 * Serijski broj koji firma već ima se odbija.
 */
export async function receiveGoods(tx: Tx, actor: Actor, input: ReceiveInput) {
  const lines = input.lines.map((l) => ({ ...l, serials: l.serials.map((s) => s.trim()).filter(Boolean) }));
  const serials = lines.flatMap((l) => l.serials);
  assert(serials.length > 0, 'Upišite barem jedan serijski broj.');
  assert(lines.every((l) => l.unitCost >= 0), 'Nabavna cijena ne može biti negativna.');
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const s of serials) (seen.has(s) ? repeated : seen).add(s);
  if (repeated.size) throw new DomainError(`Serijski brojevi su upisani više puta: ${[...repeated].slice(0, 30).join(', ')}`);
  const existing = await tx.item.findMany({ where: { companyId: actor.companyId, serial: { in: serials } }, select: { serial: true }, take: 50 });
  if (existing.length) {
    throw new DomainError(`Serijski brojevi već postoje u evidenciji (${existing.length}): ${existing.map((e) => e.serial).join(', ')}`);
  }

  const warehouse = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: actor.companyId }, select: { id: true } });
  assert(warehouse, 'Skladište ne postoji.');
  const supplier = input.supplierId
    ? await tx.partner.findFirst({ where: { id: input.supplierId, companyId: actor.companyId }, select: { id: true, name: true, country: true } })
    : null;
  assert(!input.supplierId || supplier, 'Dobavljač ne postoji.');
  const modelIds = [...new Set(lines.map((l) => l.modelId))];
  const models = await tx.deviceModel.findMany({ where: { id: { in: modelIds }, companyId: actor.companyId }, select: { id: true, cpu: true, screen: true, os: true } });
  assert(models.length === modelIds.length, 'Neki modeli ne postoje.');
  // specifikacije novih uređaja zadano s modela
  const specs = new Map(models.map((m) => [m.id, { cpu: m.cpu, screen: m.screen, os: m.os }]));

  const order = input.orderId
    ? await tx.purchaseOrder.findFirst({
        where: { id: input.orderId, companyId: actor.companyId },
        include: { lines: true, supplier: { select: { id: true, name: true, country: true } } },
      })
    : null;
  // koliko se zaprima po stavci narudžbenice (ista stavka može doći u više redaka)
  const perLine = new Map<string, number>();
  if (input.orderId) {
    assert(order, 'Narudžbenica ne postoji.');
    assert(order.status === 'ORDERED' || order.status === 'PARTIAL', 'Roba se zaprima samo po poslanoj narudžbenici (status „Naručeno" ili „Djelomično").');
    for (const l of lines) {
      if (!l.orderLineId) continue;
      const ol = order.lines.find((x) => x.id === l.orderLineId);
      assert(ol, 'Stavka narudžbenice ne postoji.');
      assert(ol.modelId === l.modelId, 'Model ne odgovara stavci narudžbenice.');
      const n = (perLine.get(ol.id) ?? 0) + l.serials.length;
      perLine.set(ol.id, n);
      const left = ol.qty - ol.received;
      assert(n <= left, `Na stavci je preostalo ${left} kom, a upisano je ${n} serijskih brojeva.`);
    }
  }
  // dobavljač robe po narudžbenici je dobavljač narudžbenice (o njegovoj zemlji ovisi PDV troška)
  const vendor = order?.supplier ?? supplier;

  const year = Number(input.date.slice(0, 4));
  const number = await nextDocNumber(tx, actor.companyId, 'RECEIPT', year);
  const total = r2(lines.reduce((a, l) => a + l.serials.length * r2(l.unitCost), 0));
  const supplierId = vendor?.id ?? null;
  const receipt = await tx.goodsReceipt.create({
    data: {
      companyId: actor.companyId,
      number,
      date: fromISO(input.date),
      supplierId,
      orderId: order?.id ?? null,
      warehouseId: warehouse.id,
      supplierDocNumber: input.supplierDocNumber ?? null,
      note: input.note ?? null,
      total,
      createdBy: actor.name,
    },
    select: { id: true },
  });

  const status = await statusFor(tx, actor.companyId, 'IN_STOCK');
  const rows: Prisma.ItemCreateManyInput[] = lines.flatMap((l) =>
    l.serials.map((s) => ({
      companyId: actor.companyId,
      serial: s,
      modelId: l.modelId,
      statusId: status.id,
      state: 'IN_STOCK' as const,
      warehouseId: warehouse.id,
      supplierId,
      receiptId: receipt.id,
      cost: r2(l.unitCost),
      ...specs.get(l.modelId),
      importDate: fromISO(input.date),
    })),
  );
  const created = await tx.item.createManyAndReturn({ data: rows, select: { id: true } });
  await tx.itemEvent.createMany({
    data: created.map((i) => ({
      companyId: actor.companyId,
      itemId: i.id,
      type: 'RECEIVED',
      message: `Zaprimljen — primka ${number}${order ? ` (narudžbenica ${order.number})` : ''}`,
      refType: 'receipt',
      refId: receipt.id,
      userName: actor.name,
    })),
  });

  if (order) {
    for (const [lineId, n] of perLine) {
      // uvjetno povećanje: istovremena primka na istu stavku ne smije zaprimiti više od naručenog
      const done = await tx.$executeRaw`
        UPDATE "PurchaseOrderLine" SET "received" = "received" + ${n}
        WHERE "id" = ${lineId} AND "orderId" = ${order.id} AND "received" + ${n} <= "qty"`;
      if (!done) throw new DomainError('Stavka narudžbenice je u međuvremenu zaprimljena — osvježite stranicu i provjerite preostalu količinu.');
    }
    await recalcOrderStatus(tx, order.id);
  }

  // primka bez vrijednosti ne knjiži trošak od 0 €; ulazni račun narudžbenice s vlastitim troškom već je knjižio robu
  // (narudžbenica je zaključana — istovremeno povezivanje računa čeka, pa se trošak ne knjiži dvaput)
  if (order) await lockPurchaseDocs(tx, actor.companyId, { orderId: order.id });
  const invoiceOwnExpenses = order
    ? await tx.expense.count({ where: { companyId: actor.companyId, source: 'SUPPLIER_INVOICE', supplierInvoice: { orderId: order.id, goodsInvoice: true } } })
    : 0;
  const booked = receiptBooksExpense({ bookExpense: input.bookExpense !== false, total, invoiceOwnExpenses });
  if (booked) {
    // plaćen račun za robu po narudžbenici — i trošak primke je plaćen
    const paidDate = order ? await paidGoodsInvoiceDate(tx, actor.companyId, { orderId: order.id, receiptId: receipt.id }) : null;
    await tx.expense.create({
      data: {
        companyId: actor.companyId,
        date: fromISO(input.date),
        categoryId: await expenseCategoryId(tx, actor.companyId, PURCHASE_CATEGORY),
        description: `Nabava robe — primka ${number}${order ? ` (${order.number})` : ''}`,
        partnerId: supplierId,
        netAmount: total,
        vatAmount: await vatFor(tx, actor.companyId, vendor?.country, total),
        source: 'RECEIPT',
        receiptId: receipt.id,
        paid: !!paidDate,
        paidDate,
        createdBy: actor.name,
      },
    });
  }

  // račun dobavljača upisan na narudžbenici postaje ulazni račun (povezan, bez dvostrukog troška)
  if (order?.supplierInvoiceNo) await syncOrderSupplierInvoice(tx, actor, order.id);

  await audit(tx, actor, {
    entity: 'receipt',
    entityId: receipt.id,
    action: 'create',
    summary: `Primka ${number}: ${created.length} kom${vendor ? ` od ${vendor.name}` : ''}${!booked && total > 0 ? ' — bez knjiženja troška' : ''}`,
  });
  return { id: receipt.id, number, count: created.length, booked };
}

/**
 * Storno primke: samo ako su svi uređaji s nje još na skladištu i nisu ni na
 * jednom računu ni ugovoru. Uređaji i trošak se brišu, zaprimljene količine
 * vraćaju, a primka ostaje (stornirana) radi traga.
 */
export async function cancelReceipt(tx: Tx, actor: Actor, id: string, reason?: string | null) {
  const receipt = await tx.goodsReceipt.findFirst({ where: { id, companyId: actor.companyId } });
  assert(receipt, 'Primka ne postoji.');
  assert(receipt.status === 'POSTED', 'Primka je već stornirana.');
  const items = await tx.item.findMany({
    where: { receiptId: id, companyId: actor.companyId },
    select: {
      id: true,
      serial: true,
      state: true,
      modelId: true,
      warehouseId: true,
      model: { select: { brand: true, name: true } },
      contractItem: { select: { id: true } },
      invoiceLines: { select: { id: true }, take: 1 },
      transferItems: { select: { transferId: true }, take: 1 },
    },
    orderBy: { serial: 'asc' },
  });
  const list = (rows: typeof items) => `(${rows.length}): ${rows.slice(0, 30).map((i) => i.serial).join(', ')}`;
  const bad = items.filter((i) => i.state !== 'IN_STOCK' || i.contractItem || i.invoiceLines.length);
  if (bad.length) {
    throw new DomainError(`Primka se ne može stornirati — uređaji nisu više slobodni na skladištu ili su na računu/ugovoru ${list(bad)}`);
  }
  // premješteni uređaj ima međuskladišnicu — brisanje bi je ispraznilo i obrisalo povijest
  const moved = items.filter((i) => i.transferItems.length || i.warehouseId !== receipt.warehouseId);
  if (moved.length) {
    throw new DomainError(`Primka se ne može stornirati — uređaji su premješteni u drugo skladište (međuskladišnica) ${list(moved)}`);
  }

  const itemIds = items.map((i) => i.id);
  // prilozi uređaja nisu vezani stranim ključem — brišu se s uređajima
  if (itemIds.length) await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'item', entityId: { in: itemIds } } });
  await tx.item.deleteMany({ where: { id: { in: itemIds } } });
  await tx.expense.deleteMany({ where: { receiptId: id, companyId: actor.companyId } });

  if (receipt.orderId) {
    const perModel = new Map<string, number>();
    for (const i of items) perModel.set(i.modelId, (perModel.get(i.modelId) ?? 0) + 1);
    const lines = await tx.purchaseOrderLine.findMany({ where: { orderId: receipt.orderId, received: { gt: 0 } }, orderBy: { id: 'asc' } });
    for (const l of lines) {
      const left = perModel.get(l.modelId) ?? 0;
      if (!left) continue;
      const dec = Math.min(left, l.received);
      await tx.purchaseOrderLine.update({ where: { id: l.id }, data: { received: l.received - dec } });
      perModel.set(l.modelId, left - dec);
    }
    await recalcOrderStatus(tx, receipt.orderId);
  }

  // popis obrisanih serijskih brojeva ostaje na primci radi traga
  const trace = items.map((i) => `${[i.model.brand, i.model.name].filter(Boolean).join(' ')}: ${i.serial}`).join('\n');
  const note = [receipt.note, `Stornirano ${formatDate(today())} (${actor.name})${reason ? ` — ${reason}` : ''}. Obrisano uređaja: ${items.length}.`, trace]
    .filter(Boolean)
    .join('\n');
  await tx.goodsReceipt.update({ where: { id }, data: { status: 'CANCELLED', note } });
  await audit(tx, actor, { entity: 'receipt', entityId: id, action: 'storno', summary: `Primka ${receipt.number} stornirana (${items.length} uređaja)` });
  return { count: items.length };
}
