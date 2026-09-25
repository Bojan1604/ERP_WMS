import 'server-only';
import type { Prisma, StatusKind } from '@prisma/client';
import type { Tx } from '../db';
import { assert, DomainError } from '../errors';
import { nextDocNumber } from '../numbering';
import { changeItemStatus, itemEvents, statusFor, type Actor } from './items';
import { fromISO, formatDate, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { supplierVat } from '@/domain/tax';
import { suggestedRent } from '@/domain/pricing';
import { addDevices } from './rentals';
import { deleteBlockedMessage } from '@/domain/warehouse-list';
import {
  dupNoteError, MAX_RECEIVE, MOVABLE_STATES, NO_WRITE_OFF_STATES, parseSerials, RETURNABLE_STATES, STATE_LABEL, type StateKind,
} from '@/domain/warehouse';

const yearOf = (d: string) => Number(d.slice(0, 4));

/** Učita uređaje firme i provjeri da postoje svi traženi. */
async function loadItems(tx: Tx, actor: Actor, itemIds: string[]) {
  const ids = [...new Set(itemIds)];
  assert(ids.length, 'Niste odabrali nijedan uređaj.');
  const items = await tx.item.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: { id: true, serial: true, state: true, cost: true, warehouseId: true, contractItem: { select: { contractId: true } } },
  });
  assert(items.length === ids.length, 'Neki od odabranih uređaja ne postoje.');
  return items;
}

function requireStates(items: Array<{ serial: string; state: StatusKind }>, allowed: StateKind[], what: string) {
  const bad = items.filter((i) => !allowed.includes(i.state));
  if (bad.length) {
    const list = bad.slice(0, 10).map((i) => `${i.serial} (${STATE_LABEL[i.state].toLowerCase()})`).join(', ');
    throw new DomainError(`${what}: ${list}${bad.length > 10 ? ` i još ${bad.length - 10}` : ''}.`);
  }
}

async function expenseCategoryId(tx: Tx, companyId: string, name: string) {
  const c = await tx.expenseCategory.upsert({ where: { companyId_name: { companyId, name } }, create: { companyId, name }, update: {}, select: { id: true } });
  return c.id;
}

async function ensureWarehouse(tx: Tx, actor: Actor, id: string) {
  const w = await tx.warehouse.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, name: true } });
  assert(w, 'Skladište ne postoji.');
  return w;
}

async function ensurePartner(tx: Tx, actor: Actor, id: string | null | undefined) {
  if (!id) return null;
  const p = await tx.partner.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, name: true, country: true } });
  assert(p, 'Partner ne postoji.');
  return p;
}

// ---------------------------------------------------------------- promjena statusa

export interface StatusChangeInput {
  itemIds: string[];
  statusId: string;
  note?: string | null;
  /** Skladište na koje uređaji idu ako je novi status „na skladištu". */
  warehouseId?: string | null;
}

/** Izravna promjena statusa (razina „uređivanje" ili odobren zahtjev). */
export async function applyStatusChange(tx: Tx, actor: Actor, input: StatusChangeInput, via?: string) {
  const ids = [...new Set(input.itemIds)];
  await loadItems(tx, actor, ids);
  const status = await tx.itemStatus.findFirst({ where: { id: input.statusId, companyId: actor.companyId }, select: { kind: true } });
  assert(status, 'Status ne postoji.');
  // otpis i najam imaju vlastite tokove (trošak otpisa, ugovor) — generička promjena ih ne smije zaobići
  assert(status.kind !== 'WRITTEN_OFF', 'Za otpis koristite radnju „Otpiši…" — ona provjerava uređaje i knjiži trošak.');
  assert(status.kind !== 'RENTED', 'Uređaj ide u najam dodavanjem na ugovor (Najam → Ugovori).');
  const data: Prisma.ItemUncheckedUpdateManyInput = {};
  if (status.kind === 'IN_STOCK' && input.warehouseId) data.warehouseId = (await ensureWarehouse(tx, actor, input.warehouseId)).id;
  const suffix = [via, input.note].filter(Boolean).join(' — ');
  return changeItemStatus(tx, actor, ids, {
    statusId: input.statusId,
    data,
    event: { type: 'STATUS', message: `Status promijenjen u „{status}"${suffix ? ` — ${suffix}` : ''}` },
  });
}

/** Zahtjev za promjenu statusa (razina „operativno" kad firma traži odobrenje). */
export async function requestStatusChange(tx: Tx, actor: Actor, input: StatusChangeInput) {
  const ids = [...new Set(input.itemIds)];
  await loadItems(tx, actor, ids);
  const status = await tx.itemStatus.findFirst({ where: { id: input.statusId, companyId: actor.companyId }, select: { id: true, kind: true } });
  assert(status, 'Status ne postoji.');
  assert(status.kind !== 'WRITTEN_OFF' && status.kind !== 'RENTED', 'Otpis i najam imaju vlastite radnje — ne idu kroz promjenu statusa.');
  const payload: Prisma.InputJsonValue = { itemIds: ids, statusId: input.statusId, note: input.note ?? null, warehouseId: input.warehouseId ?? null, requesterId: actor.id };
  return tx.approvalRequest.create({
    data: { companyId: actor.companyId, kind: 'STATUS_CHANGE', payload, requestedBy: actor.name },
    select: { id: true },
  });
}

/**
 * Odobravanje ili odbijanje zahtjeva za promjenu statusa. Odbiti se može i
 * zahtjev za zaprimanje; odobrava se zaprimanjem (`approveReceiveRequest`).
 */
export async function resolveApproval(tx: Tx, actor: Actor, id: string, approve: boolean, note: string | null) {
  const r = await tx.approvalRequest.findFirst({ where: { id, companyId: actor.companyId } });
  assert(r, 'Zahtjev ne postoji.');
  assert(r.status === 'PENDING', 'Zahtjev je već riješen.');
  if (!approve) assert(note, 'Upišite razlog odbijanja.');
  assert(!approve || r.kind === 'STATUS_CHANGE', 'Zahtjev za zaprimanje odobrava se zaprimanjem robe („Provjeri i zaprimi").');
  let applied = 0;
  if (approve) {
    const p = r.payload as unknown as StatusChangeInput;
    // uređaji obrisani u međuvremenu se preskaču
    const existing = await tx.item.findMany({ where: { companyId: actor.companyId, id: { in: p.itemIds ?? [] } }, select: { id: true } });
    assert(existing.length, 'Uređaji iz zahtjeva više ne postoje.');
    const res = await applyStatusChange(tx, actor, { ...p, itemIds: existing.map((i) => i.id) }, `odobren zahtjev (${r.requestedBy})`);
    applied = res.count;
  }
  // uvjet na PENDING štiti od dvostrukog rješavanja
  const upd = await tx.approvalRequest.updateMany({
    where: { id: r.id, status: 'PENDING' },
    data: { status: approve ? 'APPROVED' : 'REJECTED', resolvedBy: actor.name, resolveNote: note, resolvedAt: new Date() },
  });
  assert(upd.count === 1, 'Zahtjev je već riješen.');
  return { applied, requestedBy: r.requestedBy };
}

// ---------------------------------------------------------------- premještaj

/**
 * Premještaj u drugo skladište. Za svako izvorno skladište nastaje jedna
 * međuskladišnica (dokument ima jedno „iz" i jedno „u").
 */
export async function transferItems(tx: Tx, actor: Actor, input: { itemIds: string[]; toWarehouseId: string; date?: string | null; note?: string | null }) {
  const items = await loadItems(tx, actor, input.itemIds);
  requireStates(items, MOVABLE_STATES, 'Ovi uređaji nisu na skladištu i ne mogu se premjestiti');
  const to = await ensureWarehouse(tx, actor, input.toWarehouseId);
  const moving = items.filter((i) => i.warehouseId !== to.id);
  assert(moving.length, `Odabrani uređaji su već u skladištu „${to.name}".`);

  const date = input.date || today();
  const bySource = new Map<string | null, string[]>();
  for (const i of moving) bySource.set(i.warehouseId, [...(bySource.get(i.warehouseId) ?? []), i.id]);
  const sourceIds = [...bySource.keys()].filter((x): x is string => !!x);
  const sources = new Map(
    (await tx.warehouse.findMany({ where: { companyId: actor.companyId, id: { in: sourceIds } }, select: { id: true, name: true } })).map((w) => [w.id, w.name]),
  );

  const numbers: string[] = [];
  const transferIds: string[] = [];
  for (const [from, ids] of bySource) {
    const number = await nextDocNumber(tx, actor.companyId, 'TRANSFER', yearOf(date));
    const t = await tx.transfer.create({
      data: {
        companyId: actor.companyId,
        number,
        date: fromISO(date),
        fromWarehouseId: from,
        toWarehouseId: to.id,
        note: input.note ?? null,
        createdBy: actor.name,
        items: { createMany: { data: ids.map((itemId) => ({ itemId })) } },
      },
      select: { id: true },
    });
    await tx.item.updateMany({ where: { id: { in: ids }, companyId: actor.companyId }, data: { warehouseId: to.id } });
    await itemEvents(tx, actor, ids, {
      type: 'TRANSFER',
      message: `Premješten: ${from ? sources.get(from) ?? '—' : 'bez skladišta'} → ${to.name} (međuskladišnica ${number})`,
      refType: 'transfer',
      refId: t.id,
    });
    numbers.push(number);
    transferIds.push(t.id);
  }
  return { numbers, transferIds, count: moving.length, skipped: items.length - moving.length, to: to.name };
}

// ---------------------------------------------------------------- izlaz iz skladišta

export async function markOut(tx: Tx, actor: Actor, input: { itemIds: string[]; partnerId?: string | null; note?: string | null }) {
  const items = await loadItems(tx, actor, input.itemIds);
  requireStates(items, ['IN_STOCK'], 'Izaći mogu samo uređaji na skladištu');
  const partner = await ensurePartner(tx, actor, input.partnerId);
  await changeItemStatus(tx, actor, items.map((i) => i.id), {
    kind: 'RESERVED',
    data: { outAt: new Date(), outById: actor.id, outPartnerId: partner?.id ?? null, outNote: input.note ?? null },
    event: { type: 'OUT', message: `Izašao iz skladišta${partner ? ` — za ${partner.name}` : ''}${input.note ? ` (${input.note})` : ''}` },
  });
  return { count: items.length };
}

/** Poništenje izlaza — uređaji se vraćaju na stanje. */
export async function cancelOut(tx: Tx, actor: Actor, itemIds: string[]) {
  const items = await loadItems(tx, actor, itemIds);
  requireStates(items, ['RESERVED'], 'Na skladište se vraćaju samo uređaji koji su izašli');
  await changeItemStatus(tx, actor, items.map((i) => i.id), {
    kind: 'IN_STOCK',
    event: { type: 'STATUS', message: 'Vraćen na skladište — poništen izlaz' },
  });
  return { count: items.length };
}

/**
 * Izašli uređaji na postojeći aktivni ugovor (E11): predložena mjesečna cijena
 * (cjenik kupca → uređaj → model → % nabavne), status „U najmu" i klijent s
 * ugovora — kroz servis najma (`addDevices` → `attachItems`), bez dupliciranja.
 */
export async function addOutToContract(tx: Tx, actor: Actor, contractId: string, itemIds: string[]) {
  const ids = [...new Set(itemIds)];
  assert(ids.length, 'Označite uređaje.');
  const c = await tx.contract.findFirst({ where: { id: contractId, companyId: actor.companyId }, select: { id: true, number: true, partnerId: true } });
  assert(c, 'Ugovor ne postoji.');
  const [items, company] = await Promise.all([
    tx.item.findMany({
      where: { id: { in: ids }, companyId: actor.companyId },
      select: { id: true, serial: true, state: true, cost: true, rentPrice: true, modelId: true, model: { select: { rentPrice: true } } },
    }),
    tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { rentFallbackPct: true } }),
  ]);
  assert(items.length === ids.length, 'Neki uređaji ne postoje.');
  const notOut = items.filter((i) => i.state !== 'RESERVED');
  assert(!notOut.length, `Na ugovor s izlaza idu samo uređaji koji su izašli iz skladišta: ${notOut.slice(0, 10).map((i) => i.serial).join(', ')}`);
  const agreed = await tx.priceAgreement.findMany({
    where: { companyId: actor.companyId, partnerId: c.partnerId, modelId: { in: [...new Set(items.map((i) => i.modelId))] } },
    select: { modelId: true, rentPrice: true },
  });
  const agreedBy = new Map(agreed.map((a) => [a.modelId, a.rentPrice === null ? null : num(a.rentPrice)]));
  const rows = items.map((i) => ({
    itemId: i.id,
    monthly: suggestedRent({
      agreed: agreedBy.get(i.modelId) ?? null,
      itemRent: i.rentPrice === null ? null : num(i.rentPrice),
      modelRent: i.model.rentPrice === null ? null : num(i.model.rentPrice),
      cost: num(i.cost),
      fallbackPct: num(company.rentFallbackPct),
    }).price,
    plan: [],
  }));
  const r = await addDevices(tx, actor, c.id, rows, { skipPast: false });
  return { count: r.count, number: c.number };
}

// ---------------------------------------------------------------- povrat

export async function announceReturn(tx: Tx, actor: Actor, itemIds: string[], note?: string | null) {
  const items = await loadItems(tx, actor, itemIds);
  requireStates(items, RETURNABLE_STATES, 'Povrat se najavljuje samo za prodane, iznajmljene ili ostale uređaje izvan skladišta');
  await changeItemStatus(tx, actor, items.map((i) => i.id), {
    kind: 'RETURNING',
    event: { type: 'RETURN', message: `Najavljen povrat${note ? ` — ${note}` : ''}` },
  });
  return { count: items.length };
}

export async function receiveReturned(tx: Tx, actor: Actor, itemIds: string[], warehouseId: string) {
  const items = await loadItems(tx, actor, itemIds);
  requireStates(items, ['RETURNING'], 'Zaprimaju se samo uređaji u dolasku');
  const w = await ensureWarehouse(tx, actor, warehouseId);
  await changeItemStatus(tx, actor, items.map((i) => i.id), {
    kind: 'IN_STOCK',
    data: { warehouseId: w.id },
    event: { type: 'RETURNED', message: `Vraćen na skladište „${w.name}"` },
  });
  return { count: items.length, warehouse: w.name };
}

// ---------------------------------------------------------------- otpis

export async function writeOff(tx: Tx, actor: Actor, input: { itemIds: string[]; reason: string; note?: string | null; bookExpense: boolean; date?: string | null }) {
  const items = await loadItems(tx, actor, input.itemIds);
  requireStates(
    items,
    (Object.keys(STATE_LABEL) as StateKind[]).filter((s) => !NO_WRITE_OFF_STATES.includes(s)),
    'Prodani i već otpisani uređaji ne mogu se otpisati',
  );
  const date = input.date || today();
  const ids = items.map((i) => i.id);
  await changeItemStatus(tx, actor, ids, {
    kind: 'WRITTEN_OFF',
    data: { writeOffDate: fromISO(date), writeOffReason: input.reason, warehouseId: null, partnerId: null, issueDate: null },
    event: { type: 'WRITE_OFF', message: `Otpisan — ${input.reason}${input.note ? `: ${input.note}` : ''}` },
  });
  const total = r2(items.reduce((s, i) => s + num(i.cost), 0));
  let expenseId: string | null = null;
  if (input.bookExpense && total > 0) {
    const e = await tx.expense.create({
      data: {
        companyId: actor.companyId,
        date: fromISO(date),
        categoryId: await expenseCategoryId(tx, actor.companyId, 'Otpis opreme'),
        description: `Otpis opreme — ${items.length} kom (${input.reason})`,
        netAmount: total,
        vatAmount: 0,
        paid: true,
        paidDate: fromISO(date),
        source: 'WRITE_OFF',
        note: [input.note, `SN: ${items.map((i) => i.serial).slice(0, 50).join(', ')}${items.length > 50 ? '…' : ''}`].filter(Boolean).join('\n'),
        createdBy: actor.name,
      },
      select: { id: true },
    });
    expenseId = e.id;
  }
  return { count: items.length, total, expenseId };
}

// ---------------------------------------------------------------- izmjene

export interface BulkEditInput {
  itemIds: string[];
  warehouseId?: string;
  supplierId?: string | null;
  cost?: number | null;
  modelId?: string;
  note?: string | null;
  /** Klijent kod kojeg je uređaj (null = ukloni klijenta). */
  partnerId?: string | null;
  /** Bruto marža % (null = prati model / firmu). */
  marginPct?: number | null;
}

export async function bulkEdit(tx: Tx, actor: Actor, input: BulkEditInput) {
  const items = await loadItems(tx, actor, input.itemIds);
  const data: Prisma.ItemUncheckedUpdateManyInput = {};
  const parts: string[] = [];
  let transfer: Awaited<ReturnType<typeof transferItems>> | null = null;
  if (input.warehouseId !== undefined) {
    const fixed = items.filter((i) => !(MOVABLE_STATES as string[]).includes(i.state));
    assert(!fixed.length, `Skladište se ne mijenja uređajima koji nisu u skladištu (${fixed.slice(0, 5).map((i) => i.serial).join(', ')}).`);
    const w = await ensureWarehouse(tx, actor, input.warehouseId);
    // promjena skladišta je premještaj — ide kroz međuskladišnicu (dokument i povijest), ne izravnim upisom
    if (items.some((i) => i.warehouseId !== w.id)) {
      transfer = await transferItems(tx, actor, { itemIds: items.map((i) => i.id), toWarehouseId: w.id, note: 'Grupna izmjena' });
      parts.push(`skladište → ${w.name} (međuskladišnica ${transfer.numbers.join(', ')})`);
    }
  }
  if (input.supplierId !== undefined) {
    const p = await ensurePartner(tx, actor, input.supplierId);
    data.supplierId = p?.id ?? null;
    parts.push(`dobavljač → ${p?.name ?? '—'}`);
  }
  if (input.cost !== undefined) {
    assert(input.cost !== null, 'Upišite nabavnu cijenu (ili odznačite polje).');
    assert(input.cost >= 0, 'Nabavna cijena ne može biti negativna.');
    data.cost = r2(input.cost);
    parts.push(`nabavna → ${r2(input.cost).toFixed(2).replace('.', ',')} €`);
  }
  if (input.modelId !== undefined) {
    const m = await tx.deviceModel.findFirst({ where: { id: input.modelId, companyId: actor.companyId }, select: { id: true, brand: true, name: true } });
    assert(m, 'Model ne postoji.');
    data.modelId = m.id;
    parts.push(`model → ${[m.brand, m.name].filter(Boolean).join(' ')}`);
  }
  if (input.note !== undefined) {
    data.note = input.note;
    parts.push(input.note ? `napomena → ${input.note}` : 'napomena obrisana');
  }
  if (input.partnerId !== undefined) {
    // uređaj na skladištu nije ni kod koga — klijent se upisuje samo uređajima izvan skladišta
    const p = await ensurePartner(tx, actor, input.partnerId);
    const inStock = items.filter((i) => i.state === 'IN_STOCK');
    assert(!p || !inStock.length, `Uređaji na skladištu ne mogu imati klijenta (${inStock.slice(0, 5).map((i) => i.serial).join(', ')}${inStock.length > 5 ? '…' : ''}).`);
    const onContract = items.filter((i) => i.contractItem);
    assert(!onContract.length, `Klijent uređaja na ugovoru je klijent ugovora — ne mijenja se ručno (${onContract.slice(0, 5).map((i) => i.serial).join(', ')}).`);
    data.partnerId = p?.id ?? null;
    parts.push(p ? `klijent → ${p.name}` : 'klijent uklonjen');
  }
  if (input.marginPct !== undefined) {
    assert(input.marginPct === null || (input.marginPct >= 0 && input.marginPct < 100), 'Marža mora biti između 0 i 100 %.');
    data.marginPct = input.marginPct === null ? null : r2(input.marginPct);
    parts.push(input.marginPct === null ? 'marža → prati model / firmu' : `bruto marža → ${r2(input.marginPct).toFixed(2).replace('.', ',')} %`);
  }
  assert(parts.length || input.warehouseId !== undefined, 'Odaberite barem jedno polje za izmjenu.');
  assert(parts.length, 'Odabrani uređaji su već u tom skladištu.');
  const ids = items.map((i) => i.id);
  // premještaj je već zapisan u povijest (međuskladišnica); ostala polja kao izmjena
  if (Object.keys(data).length) {
    await tx.item.updateMany({ where: { id: { in: ids }, companyId: actor.companyId }, data });
    const edits = parts.filter((p) => !p.startsWith('skladište'));
    await itemEvents(tx, actor, ids, { type: 'EDIT', message: `Grupna izmjena: ${edits.join('; ')}` });
  }
  return { count: ids.length, summary: parts.join('; '), transferIds: transfer?.transferIds ?? [] };
}

export interface ItemEditInput {
  serial: string;
  dupNote: string | null;
  modelId: string;
  warehouseId: string | null;
  supplierId: string | null;
  /** Bez prava na nabavne cijene polja nabavne i marže se ne šalju (undefined = ne mijenja se). */
  cost?: number;
  rentPrice: number | null;
  marginPct?: number | null;
  warrantyMonths: number | null;
  importDate: string | null;
  note: string | null;
  // ručni ispravci (E6) — undefined = ne mijenja se
  cpu?: string | null;
  screen?: string | null;
  os?: string | null;
  categoryId?: string | null;
  salePrice?: number | null;
  issueDate?: string | null;
  invoiceId?: string | null;
  partnerId?: string | null;
}

const EDIT_LABEL: Record<string, string> = {
  serial: 'serijski broj',
  dupNote: 'razlikovna napomena',
  modelId: 'model',
  warehouseId: 'skladište',
  supplierId: 'dobavljač',
  cost: 'nabavna cijena',
  rentPrice: 'cijena najma',
  marginPct: 'marža',
  warrantyMonths: 'jamstvo',
  importDate: 'datum uvoza',
  note: 'napomena',
  cpu: 'procesor',
  screen: 'ekran',
  os: 'operativni sustav',
  categoryId: 'kategorija',
  salePrice: 'prodajna cijena',
  issueDate: 'datum izlaza',
  invoiceId: 'račun',
  partnerId: 'klijent',
};

const optText = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

/** Izmjena kartice uređaja; vraća promijenjena polja (za dnevnik). */
export async function updateItem(tx: Tx, actor: Actor, id: string, input: ItemEditInput) {
  const before = await tx.item.findFirst({ where: { id, companyId: actor.companyId }, include: { contractItem: { select: { id: true } } } });
  assert(before, 'Uređaj ne postoji.');
  const serial = input.serial.trim();
  assert(serial, 'Serijski broj je obavezan.');
  const dupNote = input.dupNote?.trim() || null;

  const others = await tx.item.findMany({ where: { companyId: actor.companyId, serial, id: { not: id } }, select: { dupNote: true } });
  const dupErr = dupNoteError(serial, dupNote, others);
  if (dupErr) throw new DomainError(dupErr);

  const [model] = await Promise.all([
    tx.deviceModel.findFirst({ where: { id: input.modelId, companyId: actor.companyId }, select: { id: true } }),
    input.warehouseId ? ensureWarehouse(tx, actor, input.warehouseId) : null,
    ensurePartner(tx, actor, input.supplierId),
  ]);
  assert(model, 'Model ne postoji.');
  const warehouseId = input.warehouseId ?? null;
  const moving = warehouseId !== before.warehouseId;
  assert(!moving || (MOVABLE_STATES as string[]).includes(before.state), 'Skladište se mijenja samo uređajima koji su u skladištu.');
  assert(!moving || warehouseId || before.state !== 'IN_STOCK', 'Uređaj na stanju mora biti u nekom skladištu.');
  assert(input.cost === undefined || input.cost >= 0, 'Nabavna cijena ne može biti negativna.');
  assert(input.marginPct === undefined || input.marginPct === null || (input.marginPct >= 0 && input.marginPct < 100), 'Marža mora biti između 0 i 100 %.');
  assert(input.warrantyMonths === null || (input.warrantyMonths >= 0 && input.warrantyMonths <= 240), 'Jamstvo mora biti između 0 i 240 mjeseci.');
  assert(input.salePrice === undefined || input.salePrice === null || input.salePrice >= 0, 'Prodajna cijena ne može biti negativna.');

  // ručni ispravci: kategorija, račun i klijent moraju pripadati firmi
  if (input.categoryId) {
    assert(await tx.category.count({ where: { id: input.categoryId, companyId: actor.companyId } }), 'Kategorija ne postoji.');
  }
  if (input.invoiceId) {
    assert(await tx.invoice.count({ where: { id: input.invoiceId, companyId: actor.companyId } }), 'Račun ne postoji.');
  }
  if (input.partnerId !== undefined && input.partnerId !== before.partnerId) {
    await ensurePartner(tx, actor, input.partnerId);
    assert(!input.partnerId || before.state !== 'IN_STOCK', 'Uređaj na skladištu nije kod klijenta — klijent se upisuje uređajima izvan skladišta.');
    assert(!before.contractItem, 'Klijent uređaja na ugovoru je klijent ugovora — mijenja se na ugovoru.');
  }

  // promjena skladišta je premještaj — međuskladišnica (dokument i povijest), ne izravan upis
  let transfer: Awaited<ReturnType<typeof transferItems>> | null = null;
  if (moving && warehouseId) transfer = await transferItems(tx, actor, { itemIds: [id], toWarehouseId: warehouseId, note: 'Izmjena kartice uređaja' });

  const data: Record<string, unknown> = {
    serial,
    dupNote,
    modelId: input.modelId,
    warehouseId,
    supplierId: input.supplierId,
    rentPrice: input.rentPrice === null ? null : r2(input.rentPrice),
    warrantyMonths: input.warrantyMonths,
    importDate: input.importDate ? fromISO(input.importDate) : null,
    note: input.note,
  };
  if (input.cost !== undefined) data.cost = r2(input.cost);
  if (input.marginPct !== undefined) data.marginPct = input.marginPct;
  for (const k of ['cpu', 'screen', 'os'] as const) {
    const v = optText(input[k]);
    if (v !== undefined) data[k] = v;
  }
  if (input.categoryId !== undefined) data.categoryId = input.categoryId;
  if (input.salePrice !== undefined) data.salePrice = input.salePrice === null ? null : r2(input.salePrice);
  if (input.issueDate !== undefined) data.issueDate = input.issueDate ? fromISO(input.issueDate) : null;
  if (input.invoiceId !== undefined) data.invoiceId = input.invoiceId;
  if (input.partnerId !== undefined) data.partnerId = input.partnerId;
  await tx.item.update({ where: { id }, data: data as Prisma.ItemUncheckedUpdateInput });

  const b = before as unknown as Record<string, unknown>;
  const changed = Object.keys(data).filter((k) => norm(b[k]) !== norm(data[k]));
  // premještaj ima vlastiti zapis u povijesti (međuskladišnica)
  const edited = transfer ? changed.filter((k) => k !== 'warehouseId') : changed;
  if (edited.length) {
    await itemEvents(tx, actor, [id], { type: 'EDIT', message: `Izmijenjeno: ${edited.map((k) => EDIT_LABEL[k] ?? k).join(', ')}` });
  }
  const after = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]));
  return { before, after, changed, transfer };
}

// ---------------------------------------------------------------- brisanje

/**
 * Brisanje uređaja (pojedinačno ili skupno) — samo uređaji bez računa, ugovora,
 * međuskladišnice i servisnog naloga; inače jasna poruka koji i zašto (takvi se
 * otpisuju). Prilozi uređaja se brišu s njim; primka i njen trošak ostaju.
 */
export async function deleteItems(tx: Tx, actor: Actor, itemIds: string[]) {
  const ids = [...new Set(itemIds)];
  assert(ids.length, 'Niste odabrali nijedan uređaj.');
  const items = await tx.item.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: {
      id: true,
      serial: true,
      invoiceId: true,
      receiptId: true,
      contractItem: { select: { id: true } },
      _count: { select: { invoiceLines: true, returnedFrom: true, transferItems: true, serviceOrders: true, replacements: true } },
    },
  });
  assert(items.length === ids.length, 'Neki od odabranih uređaja ne postoje.');
  const blocked = deleteBlockedMessage(
    items.map((i) => ({
      serial: i.serial,
      invoiceId: i.invoiceId,
      invoiceLines: i._count.invoiceLines,
      onContract: !!i.contractItem,
      returnedFromContract: i._count.returnedFrom,
      transfers: i._count.transferItems,
      serviceOrders: i._count.serviceOrders + i._count.replacements,
    })),
  );
  if (blocked) throw new DomainError(blocked);
  // prilozi i stavke inventure nisu vezani stranim ključem
  await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'item', entityId: { in: ids } } });
  await tx.stocktakeScan.updateMany({ where: { itemId: { in: ids } }, data: { itemId: null } });
  await tx.item.deleteMany({ where: { id: { in: ids }, companyId: actor.companyId } });
  return { count: ids.length, serials: items.map((i) => i.serial), fromReceipt: items.filter((i) => i.receiptId).length };
}

function norm(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && 'toNumber' in (v as object)) return String((v as { toNumber(): number }).toNumber());
  return String(v);
}

// ---------------------------------------------------------------- zaprimanje

export interface ReceiveInput {
  modelId: string;
  warehouseId: string;
  supplierId: string | null;
  cost: number;
  importDate: string;
  supplierDocNumber: string | null;
  note: string | null;
  serials: string[];
  skipExisting: boolean;
  dupNote: string | null;
  /** Specifikacije komada; prazno = zadano s modela. */
  cpu?: string | null;
  screen?: string | null;
  os?: string | null;
  /** Knjiži nabavnu vrijednost kao trošak „Nabava robe" (zadano da). */
  bookExpense?: boolean;
}

/** Postojeći serijski brojevi firme iz zadanog popisa (jedan upit). */
export async function existingSerials(tx: Tx, companyId: string, serials: string[]) {
  if (!serials.length) return new Map<string, Array<{ dupNote: string | null }>>();
  const rows = await tx.item.findMany({ where: { companyId, serial: { in: serials } }, select: { serial: true, dupNote: true } });
  const m = new Map<string, Array<{ dupNote: string | null }>>();
  for (const r of rows) m.set(r.serial, [...(m.get(r.serial) ?? []), { dupNote: r.dupNote }]);
  return m;
}

/**
 * Skupno zaprimanje: jedna primka, uređaji jednim upisom, povijest jednim
 * upisom i jedan trošak nabave. Bez upita po retku — radi i za tisuće komada.
 */
export async function receiveItems(tx: Tx, actor: Actor, input: ReceiveInput) {
  const serials = parseSerials(input.serials.join('\n')).serials;
  assert(serials.length, 'Upišite barem jedan serijski broj.');
  assert(serials.length <= MAX_RECEIVE, `Najviše ${MAX_RECEIVE} uređaja odjednom.`);
  assert(input.cost >= 0, 'Nabavna cijena ne može biti negativna.');

  const [model, warehouse, supplier, company, status, existing] = await Promise.all([
    tx.deviceModel.findFirst({ where: { id: input.modelId, companyId: actor.companyId }, select: { id: true, brand: true, name: true, cpu: true, screen: true, os: true } }),
    ensureWarehouse(tx, actor, input.warehouseId),
    ensurePartner(tx, actor, input.supplierId),
    tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { vatRate: true, country: true } }),
    statusFor(tx, actor.companyId, 'IN_STOCK'),
    existingSerials(tx, actor.companyId, serials),
  ]);
  assert(model, 'Model ne postoji.');

  const dupNote = input.dupNote?.trim() || null;
  const toCreate = input.skipExisting ? serials.filter((s) => !existing.has(s)) : serials;
  if (!input.skipExisting) {
    for (const s of serials) {
      const err = dupNoteError(s, dupNote, existing.get(s) ?? []);
      if (err) throw new DomainError(err);
    }
  }
  assert(toCreate.length, 'Svi serijski brojevi već postoje — nema novih uređaja za zaprimiti.');

  const cost = r2(input.cost);
  const total = r2(cost * toCreate.length);
  const specs = {
    cpu: input.cpu?.trim() || model.cpu || null,
    screen: input.screen?.trim() || model.screen || null,
    os: input.os?.trim() || model.os || null,
  };
  const date = fromISO(input.importDate);
  const number = await nextDocNumber(tx, actor.companyId, 'RECEIPT', yearOf(input.importDate));

  const receipt = await tx.goodsReceipt.create({
    data: {
      companyId: actor.companyId,
      number,
      date,
      supplierId: supplier?.id ?? null,
      warehouseId: warehouse.id,
      supplierDocNumber: input.supplierDocNumber,
      total,
      note: input.note,
      createdBy: actor.name,
    },
    select: { id: true },
  });

  const created: Array<{ id: string }> = [];
  for (let i = 0; i < toCreate.length; i += 1000) {
    const chunk = toCreate.slice(i, i + 1000);
    const rows = await tx.item.createManyAndReturn({
      data: chunk.map((serial) => ({
        companyId: actor.companyId,
        serial,
        dupNote: existing.has(serial) ? dupNote : null,
        modelId: model.id,
        statusId: status.id,
        state: 'IN_STOCK' as const,
        warehouseId: warehouse.id,
        supplierId: supplier?.id ?? null,
        receiptId: receipt.id,
        cost,
        ...specs,
        importDate: date,
        note: input.note,
      })),
      select: { id: true },
    });
    created.push(...rows);
  }

  await itemEvents(tx, actor, created.map((r) => r.id), {
    type: 'RECEIVED',
    message: `Zaprimljen primkom ${number} u „${warehouse.name}"${supplier ? ` — dobavljač ${supplier.name}` : ''}${input.supplierDocNumber ? `, dok. ${input.supplierDocNumber}` : ''}`,
    refType: 'receipt',
    refId: receipt.id,
  });

  if (total > 0 && input.bookExpense !== false) {
    const vat = supplierVat(supplier?.country, { vatRate: num(company.vatRate), country: company.country });
    await tx.expense.create({
      data: {
        companyId: actor.companyId,
        date,
        categoryId: await expenseCategoryId(tx, actor.companyId, 'Nabava robe'),
        description: `Primka ${number} — ${[model.brand, model.name].filter(Boolean).join(' ')} × ${toCreate.length}`,
        partnerId: supplier?.id ?? null,
        netAmount: total,
        vatAmount: r2((total * vat.rate) / 100),
        source: 'RECEIPT',
        receiptId: receipt.id,
        note: input.supplierDocNumber ? `Dokument dobavljača: ${input.supplierDocNumber}` : null,
        createdBy: actor.name,
      },
    });
  }

  return {
    receiptId: receipt.id,
    number,
    count: toCreate.length,
    skipped: serials.length - toCreate.length,
    total,
    summary: `${formatDate(input.importDate)} · ${toCreate.length} kom`,
  };
}
