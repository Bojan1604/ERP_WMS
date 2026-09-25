import 'server-only';
import type { ContractStatus, Prisma, ServiceStatus } from '@prisma/client';
import type { Tx } from '../db';
import { DomainError, assert } from '../errors';
import { nextDocNumber } from '../numbering';
import { audit } from '../audit';
import { changeItemStatus, itemEvents, type Actor } from './items';
import { coveredPeriods } from './invoices';
import { mergePeriods, takeBackReturned } from './contract-items';
import { fromISO, toISO, today } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import {
  CLOSED_SERVICE_STATUSES,
  OPEN_SERVICE_STATUSES,
  SERVICE_STATUS,
  type PrevSnapshot,
  type TimelineEntry,
} from '@/components/service/labels';

// =============================================================================
//  Servis (RMA): nalozi, tijek statusa, povrat uređaja i zamjenski uređaj
// =============================================================================

const OPEN = OPEN_SERVICE_STATUSES as ServiceStatus[];
const isClosing = (s: ServiceStatus) => (CLOSED_SERVICE_STATUSES as string[]).includes(s);

function entry(actor: Actor, status: ServiceStatus, note?: string | null, prev?: PrevSnapshot): TimelineEntry {
  return { at: new Date().toISOString(), status, by: actor.name, note: note || null, ...(prev ? { prev } : {}) };
}

const timelineOf = (v: Prisma.JsonValue): TimelineEntry[] => (Array.isArray(v) ? (v as unknown as TimelineEntry[]) : []);
const toJson = (t: TimelineEntry[]) => t as unknown as Prisma.InputJsonValue;

async function loadOrder(tx: Tx, actor: Actor, id: string) {
  const o = await tx.serviceOrder.findFirst({ where: { id, companyId: actor.companyId } });
  assert(o, 'Servisni nalog ne postoji.');
  return o;
}

const itemSelect = {
  id: true,
  serial: true,
  state: true,
  partnerId: true,
  invoiceId: true,
  warehouseId: true,
  issueDate: true,
  warrantyStart: true,
  warrantyMonths: true,
  contractItem: { select: { id: true, contractId: true, monthly: true, plan: true, skipped: true, paused: true, status: true, pausedSince: true } },
} satisfies Prisma.ItemSelect;

type ServiceItem = Prisma.ItemGetPayload<{ select: typeof itemSelect }>;
type ServiceContractItem = NonNullable<ServiceItem['contractItem']>;
/** Uređaj za snimku stanja — početak pauze nije obavezan (stranica naloga ga ne učitava). */
type SnapshotItem = Omit<ServiceItem, 'contractItem'> & {
  contractItem: (Omit<ServiceContractItem, 'pausedSince'> & { pausedSince?: Date | null }) | null;
};

function snapshot(item: SnapshotItem): PrevSnapshot {
  const ci = item.contractItem;
  return {
    state: item.state,
    partnerId: item.partnerId,
    warehouseId: item.warehouseId,
    contract: ci
      ? { contractId: ci.contractId, monthly: num(ci.monthly), plan: ci.plan, skipped: ci.skipped, paused: ci.paused, status: ci.status, pausedSince: ci.pausedSince ? toISO(ci.pausedSince) : null }
      : null,
  };
}

/**
 * Stanje uređaja prije servisa: iz zapisa pri otvaranju naloga, a za naloge
 * koje je otvorila promjena statusa — iz povijesti uređaja (skidanje s ugovora).
 */
export async function previousState(tx: Tx, order: { itemId: string | null; createdAt: Date; timeline: Prisma.JsonValue }, item: SnapshotItem | null) {
  const saved = timelineOf(order.timeline).find((t) => t.prev)?.prev;
  if (saved) return saved;
  if (!item) return null;
  if (item.contractItem) return snapshot(item);
  const removed = await tx.itemEvent.findFirst({
    where: { itemId: item.id, type: 'CONTRACT', refType: 'contract', at: { gte: new Date(order.createdAt.getTime() - 60_000) } },
    orderBy: { at: 'asc' },
    select: { refId: true },
  });
  return {
    state: removed ? 'RENTED' : item.partnerId ? 'SOLD' : 'IN_STOCK',
    partnerId: item.partnerId,
    warehouseId: item.warehouseId,
    // cijena s ugovora nije poznata — povrat u najam tada nije moguć automatski
    contract: null,
    removedFromContractId: removed?.refId ?? null,
  } as PrevSnapshot & { removedFromContractId: string | null };
}

// ---------------------------------------------------------------- otvaranje

export interface NewServiceInput {
  itemId: string;
  issue: string;
  reportedAt: string;
  status: 'REPORTED' | 'RECEIVED';
  underWarranty: boolean;
  note?: string | null;
  /** Uređaj dobiva status vrste SERVICE (Pokvaren / Na servisu). */
  setServiceStatus: boolean;
}

export async function createServiceOrder(tx: Tx, actor: Actor, input: NewServiceInput) {
  const item = await tx.item.findFirst({ where: { id: input.itemId, companyId: actor.companyId }, select: itemSelect });
  assert(item, 'Uređaj ne postoji.');
  const open = await tx.serviceOrder.findFirst({ where: { companyId: actor.companyId, itemId: item.id, status: { in: OPEN } }, select: { number: true } });
  assert(!open, `Uređaj ${item.serial} već ima otvoren servisni nalog ${open?.number}.`);

  const number = await nextDocNumber(tx, actor.companyId, 'SERVICE', Number(input.reportedAt.slice(0, 4)));
  const order = await tx.serviceOrder.create({
    data: {
      companyId: actor.companyId,
      number,
      itemId: item.id,
      serial: item.serial,
      partnerId: item.partnerId,
      invoiceId: item.invoiceId,
      status: input.status,
      reportedAt: fromISO(input.reportedAt),
      receivedAt: input.status === 'RECEIVED' ? fromISO(today()) : null,
      issue: input.issue,
      underWarranty: input.underWarranty,
      note: input.note ?? null,
      timeline: toJson([entry(actor, input.status, 'Nalog otvoren', snapshot(item))]),
      createdBy: actor.name,
    },
    select: { id: true, number: true },
  });

  // nalog postoji prije promjene statusa, pa changeItemStatus ne otvara drugi
  if (input.setServiceStatus && item.state !== 'SERVICE') {
    await changeItemStatus(tx, actor, [item.id], {
      kind: 'SERVICE',
      event: { type: 'SERVICE', message: `Status „{status}" — servisni nalog ${number}`, refType: 'service', refId: order.id },
    });
  } else {
    await itemEvents(tx, actor, [item.id], { type: 'SERVICE', message: `Otvoren servisni nalog ${number}`, refType: 'service', refId: order.id });
  }
  await audit(tx, actor, { entity: 'service', entityId: order.id, action: 'create', summary: `Servisni nalog ${number} za ${item.serial}` });
  return order;
}

// ---------------------------------------------------------------- izmjene i status

export interface ServiceFieldsInput {
  issue: string;
  diagnosis?: string | null;
  action?: string | null;
  solution?: string | null;
  cost: number;
  underWarranty: boolean;
  publicNote?: string | null;
  note?: string | null;
  reportedAt: string;
  receivedAt?: string | null;
}

export async function updateServiceOrder(tx: Tx, actor: Actor, id: string, input: ServiceFieldsInput) {
  const o = await loadOrder(tx, actor, id);
  assert(input.cost >= 0, 'Trošak ne može biti negativan.');
  await tx.serviceOrder.update({
    where: { id },
    data: {
      issue: input.issue,
      diagnosis: input.diagnosis ?? null,
      action: input.action ?? null,
      solution: input.solution ?? null,
      cost: r2(input.cost),
      underWarranty: input.underWarranty,
      publicNote: input.publicNote ?? null,
      note: input.note ?? null,
      reportedAt: fromISO(input.reportedAt),
      receivedAt: input.receivedAt ? fromISO(input.receivedAt) : null,
    },
  });
  await audit(tx, actor, { entity: 'service', entityId: id, action: 'update', summary: `Servisni nalog ${o.number} izmijenjen` });
}

export async function changeServiceStatus(
  tx: Tx,
  actor: Actor,
  id: string,
  status: ServiceStatus,
  opts: { note?: string | null; writeOffDevice?: boolean } = {},
) {
  const o = await loadOrder(tx, actor, id);
  assert(status !== 'REPLACED', 'Status „Zamijenjeno" postavlja se odabirom zamjenskog uređaja.');
  assert(o.status !== 'REPLACED', 'Nalog je zatvoren zamjenom uređaja.');
  assert(status !== o.status, 'Nalog je već u tom statusu.');
  // ponovno otvaranje zatvorenog naloga: uređaj smije imati samo jedan otvoren nalog
  if (o.itemId && isClosing(o.status) && !isClosing(status)) {
    const other = await tx.serviceOrder.findFirst({
      where: { companyId: actor.companyId, itemId: o.itemId, status: { in: OPEN }, id: { not: o.id } },
      select: { number: true },
    });
    assert(!other, `Uređaj ${o.serial ?? ''} već ima otvoren servisni nalog ${other?.number} — nalog se ne može ponovno otvoriti.`);
  }
  const t = today();
  await tx.serviceOrder.update({
    where: { id },
    data: {
      status,
      closedAt: isClosing(status) ? (o.closedAt ?? fromISO(t)) : null,
      receivedAt: o.receivedAt ?? (status !== 'REPORTED' ? fromISO(t) : null),
      timeline: toJson([...timelineOf(o.timeline), entry(actor, status, opts.note)]),
    },
  });

  if (status === 'WRITTEN_OFF' && opts.writeOffDevice && o.itemId) {
    await changeItemStatus(tx, actor, [o.itemId], {
      kind: 'WRITTEN_OFF',
      data: { writeOffDate: fromISO(t), writeOffReason: `Servisni nalog ${o.number}${opts.note ? ` — ${opts.note}` : ''}`, warehouseId: null },
      event: { type: 'WRITE_OFF', message: `Otpisan — servisni nalog ${o.number}`, refType: 'service', refId: id },
    });
  }
  await audit(tx, actor, { entity: 'service', entityId: id, action: 'status', summary: `Servisni nalog ${o.number}: ${SERVICE_STATUS[status].label}` });
}

// ---------------------------------------------------------------- povrat uređaja

export type ReturnTarget = 'SOLD' | 'RENTED' | 'IN_STOCK';

/** Popravljen uređaj se vraća u stanje prije servisa: kupcu, u najam ili na skladište. */
export async function returnDevice(tx: Tx, actor: Actor, id: string, target: ReturnTarget, warehouseId?: string | null) {
  const o = await loadOrder(tx, actor, id);
  assert(o.status === 'REPAIRED', 'Uređaj se vraća tek kad je nalog u statusu „Popravljeno".');
  assert(o.itemId, 'Nalog nije vezan uz uređaj.');
  const item = await tx.item.findFirst({ where: { id: o.itemId, companyId: actor.companyId }, select: itemSelect });
  assert(item, 'Uređaj ne postoji.');
  assert(item.state === 'SERVICE', 'Uređaj nije u statusu servisa — nema što vratiti.');
  const prev = await previousState(tx, o, item);
  const ref = { refType: 'service', refId: id };
  let note: string;

  if (target === 'SOLD') {
    // „prodan" samo ako je uređaj prije servisa bio prodan — najam ili skladište ne smiju postati prodaja
    assert(prev?.state === 'SOLD', 'Uređaj prije servisa nije bio prodan — vratite ga u najam ili na skladište.');
    const partnerId = item.partnerId ?? prev?.partnerId;
    assert(partnerId, 'Uređaj nema kupca — vratite ga na skladište.');
    await changeItemStatus(tx, actor, [item.id], {
      kind: 'SOLD',
      data: { partnerId, warehouseId: null },
      event: { type: 'RETURNED', message: `Vraćen kupcu nakon servisa — nalog ${o.number}`, ...ref },
    });
    note = 'Uređaj vraćen kupcu';
  } else if (target === 'RENTED') {
    let contractId = item.contractItem?.contractId ?? null;
    if (!contractId) {
      const c = prev?.contract;
      assert(c, 'Nije poznat ugovor s kojeg je uređaj skinut — vratite ga na skladište pa ga dodajte na ugovor.');
      const contract = await tx.contract.findFirst({ where: { id: c.contractId, companyId: actor.companyId }, select: { id: true, status: true } });
      assert(contract && (contract.status === 'ACTIVE' || contract.status === 'PAUSED'), 'Ugovor više nije aktivan — vratite uređaj na skladište.');
      // snimka skidanja pri odlasku u servis više ne treba — uređaj nastavlja na istom retku
      const back = await takeBackReturned(tx, contract.id, item.id, o.createdAt);
      await tx.contractItem.create({
        data: {
          contractId: contract.id,
          itemId: item.id,
          monthly: c.monthly,
          plan: (c.plan ?? []) as Prisma.InputJsonValue,
          skipped: mergePeriods(c.skipped, back.skipped),
          paused: mergePeriods(c.paused, back.paused),
          status: (c.status as ContractStatus | null) ?? null,
          pausedSince: c.status === 'PAUSED' && c.pausedSince ? fromISO(c.pausedSince) : null,
        },
      });
      contractId = contract.id;
    }
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: contractId }, select: { number: true, partnerId: true } });
    await changeItemStatus(tx, actor, [item.id], {
      kind: 'RENTED',
      data: { partnerId: contract.partnerId, warehouseId: null },
      event: { type: 'RETURNED', message: `Vraćen u najam nakon servisa — ugovor ${contract.number}, nalog ${o.number}`, ...ref },
    });
    note = `Uređaj vraćen u najam (ugovor ${contract.number})`;
  } else {
    assert(warehouseId, 'Odaberite skladište.');
    const wh = await tx.warehouse.findFirst({ where: { id: warehouseId, companyId: actor.companyId }, select: { id: true, name: true } });
    assert(wh, 'Skladište ne postoji.');
    await changeItemStatus(tx, actor, [item.id], {
      kind: 'IN_STOCK',
      data: { warehouseId: wh.id },
      event: { type: 'RETURNED', message: `Vraćen na skladište ${wh.name} nakon servisa — nalog ${o.number}`, ...ref },
    });
    note = `Uređaj vraćen na skladište ${wh.name}`;
  }

  await tx.serviceOrder.update({ where: { id }, data: { timeline: toJson([...timelineOf(o.timeline), entry(actor, o.status, note)]) } });
  await audit(tx, actor, { entity: 'service', entityId: id, action: 'return', summary: `Servisni nalog ${o.number}: ${note.toLowerCase()}` });
}

// ---------------------------------------------------------------- zamjenski uređaj

/**
 * Zamjenski uređaj preuzima kupca, vrstu statusa (prodan ili u najmu),
 * početak i trajanje jamstva izvornog, te njegovo mjesto na ugovoru.
 * Izvorni se otpisuje ili vraća na skladište.
 */
export async function replaceDevice(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { replacementId: string; originalTo: 'WRITTEN_OFF' | 'IN_STOCK'; warehouseId?: string | null; note?: string | null },
) {
  const o = await loadOrder(tx, actor, id);
  assert(o.status !== 'REPLACED' && o.status !== 'WRITTEN_OFF', 'Nalog je već zatvoren.');
  assert(o.itemId, 'Nalog nije vezan uz uređaj.');
  assert(o.itemId !== input.replacementId, 'Zamjenski uređaj mora biti drugi uređaj.');
  const orig = await tx.item.findFirst({ where: { id: o.itemId, companyId: actor.companyId }, select: itemSelect });
  assert(orig, 'Izvorni uređaj ne postoji.');
  const repl = await tx.item.findFirst({ where: { id: input.replacementId, companyId: actor.companyId }, select: { id: true, serial: true, state: true } });
  assert(repl, 'Zamjenski uređaj ne postoji.');
  assert(repl.state === 'IN_STOCK', `Uređaj ${repl.serial} nije na skladištu.`);

  const prev = await previousState(tx, o, orig);
  const partnerId = orig.partnerId ?? prev?.partnerId ?? o.partnerId;
  assert(partnerId, 'Izvorni uređaj nije kod klijenta — zamjena nije potrebna.');
  const contract = orig.contractItem
    ? snapshot(orig).contract!
    : (prev?.contract ?? null);
  // bez poznatog ugovora uređaj iz najma ne smije postati „prodan"
  assert(contract || prev?.state !== 'RENTED', 'Uređaj je bio u najmu, ali ugovor nije poznat — zamjenski uređaj dodajte na ugovor ručno (Najam → Ugovori).');
  const kind = contract ? 'RENTED' : 'SOLD';
  const ref = { refType: 'service', refId: id };
  const c = contract
    ? await tx.contract.findFirst({ where: { id: contract.contractId, companyId: actor.companyId }, select: { id: true, number: true, status: true } })
    : null;
  if (contract) {
    if (!c) throw new DomainError('Ugovor izvornog uređaja ne postoji.');
    assert(c.status === 'ACTIVE' || c.status === 'PAUSED', `Ugovor ${c.number} više nije aktivan — zamjenski uređaj se ne može staviti u najam.`);
  }

  // 1) zamjenski uređaj preuzima kupca, status i jamstvo izvornog
  await changeItemStatus(tx, actor, [repl.id], {
    kind,
    data: {
      partnerId,
      invoiceId: orig.invoiceId,
      issueDate: orig.issueDate ?? fromISO(today()),
      warrantyStart: orig.warrantyStart ?? orig.issueDate,
      warrantyMonths: orig.warrantyMonths,
      warehouseId: null,
    },
    event: { type: 'REPLACEMENT', message: `Zamjenski uređaj za ${orig.serial} — nalog ${o.number}`, ...ref },
  });

  // 2) mjesto na ugovoru prelazi na zamjenski (prije promjene statusa izvornog)
  if (contract && c) {
    // Pokrivenost naplate vodi se po uređaju (`itemId|razdoblje`). Razdoblja već
    // fakturirana za izvorni uređaj zamjenski preuzima kao „izdana" (skipped) —
    // inače bi se ponovno pojavila kao dospjela. Plan, cijena i pauze ostaju isti,
    // pa nema ni dvostruke naplate ni praznine (nefakturirano ostaje dospjelo).
    const covered = (await coveredPeriods(tx, [c.id])).get(c.id) ?? new Set<string>();
    const billed = [...covered].filter((k) => k.startsWith(`${orig.id}|`)).map((k) => k.slice(orig.id.length + 1));
    const skipped = [...new Set([...(contract.skipped ?? []), ...billed])].sort();
    if (orig.contractItem) {
      await tx.contractItem.update({ where: { id: orig.contractItem.id }, data: { itemId: repl.id, skipped } });
    } else {
      // izvorni je pri odlasku u servis skinut s ugovora (snimka za zaostale rate): njegova
      // nefakturirana razdoblja sad preuzima zamjenski — snimka se briše, inače bi se rata tražila dvaput
      const back = await takeBackReturned(tx, c.id, orig.id, o.createdAt);
      await tx.contractItem.create({
        data: {
          contractId: c.id,
          itemId: repl.id,
          monthly: contract.monthly,
          plan: (contract.plan ?? []) as Prisma.InputJsonValue,
          skipped: mergePeriods(skipped, back.skipped),
          paused: mergePeriods(contract.paused, back.paused),
          status: (contract.status as ContractStatus | null) ?? null,
          pausedSince: contract.status === 'PAUSED' && contract.pausedSince ? fromISO(contract.pausedSince) : null,
        },
      });
    }
    await itemEvents(tx, actor, [repl.id], { type: 'CONTRACT', message: `Na ugovoru ${c.number} umjesto ${orig.serial}`, refType: 'contract', refId: c.id });
    if (orig.contractItem) {
      await itemEvents(tx, actor, [orig.id], { type: 'CONTRACT', message: `Skinut s ugovora ${c.number} — zamijenjen uređajem ${repl.serial}`, refType: 'contract', refId: c.id });
    }
  }

  // 3) izvorni uređaj: otpis ili skladište
  if (input.originalTo === 'WRITTEN_OFF') {
    await changeItemStatus(tx, actor, [orig.id], {
      kind: 'WRITTEN_OFF',
      data: { writeOffDate: fromISO(today()), writeOffReason: `Zamijenjen uređajem ${repl.serial} (nalog ${o.number})`, warehouseId: null },
      event: { type: 'WRITE_OFF', message: `Otpisan — zamijenjen uređajem ${repl.serial}, nalog ${o.number}`, ...ref },
    });
  } else {
    assert(input.warehouseId, 'Odaberite skladište za izvorni uređaj.');
    const wh = await tx.warehouse.findFirst({ where: { id: input.warehouseId, companyId: actor.companyId }, select: { id: true, name: true } });
    assert(wh, 'Skladište ne postoji.');
    await changeItemStatus(tx, actor, [orig.id], {
      kind: 'IN_STOCK',
      data: { warehouseId: wh.id },
      event: { type: 'RETURNED', message: `Na skladište ${wh.name} — zamijenjen uređajem ${repl.serial}, nalog ${o.number}`, ...ref },
    });
  }

  const note = `Zamjenski uređaj ${repl.serial}${input.note ? ` — ${input.note}` : ''}`;
  await tx.serviceOrder.update({
    where: { id },
    data: {
      status: 'REPLACED',
      replacementItemId: repl.id,
      closedAt: o.closedAt ?? fromISO(today()),
      solution: o.solution ?? `Zamjena uređajem ${repl.serial}`,
      timeline: toJson([...timelineOf(o.timeline), entry(actor, 'REPLACED', note)]),
    },
  });
  await audit(tx, actor, { entity: 'service', entityId: id, action: 'replace', summary: `Servisni nalog ${o.number}: ${orig.serial} zamijenjen uređajem ${repl.serial}` });
}

// ---------------------------------------------------------------- brisanje

/**
 * Brisanje servisnog naloga (C7) — za naloge otvorene greškom ili dvostruke
 * prijave. Ne briše se nalog zatvoren zamjenom (zamjenski uređaj je preuzeo
 * mjesto kod klijenta) ni otvoren nalog dok je uređaj zbog njega u servisu —
 * uređaj bi ostao „na servisu" bez naloga. Fotografije naloga brišu se s njim.
 */
export async function deleteServiceOrder(tx: Tx, actor: Actor, id: string) {
  const o = await loadOrder(tx, actor, id);
  assert(o.status !== 'REPLACED', `Nalog ${o.number} zatvoren je zamjenom uređaja — ne može se obrisati.`);
  // otpis je trag zašto je uređaj otpisan; račun iz naloga bi izgubio izvor
  assert(o.status !== 'WRITTEN_OFF', `Nalog ${o.number} zatvoren je otpisom — ne može se obrisati.`);
  if (o.invoiceId) {
    const inv = await tx.invoice.findFirst({ where: { id: o.invoiceId, companyId: actor.companyId }, select: { number: true, status: true } });
    assert(
      !inv,
      inv?.status === 'DRAFT'
        ? `Za nalog ${o.number} postoji nacrt računa — prvo obrišite nacrt, pa tek onda nalog.`
        : `Za nalog ${o.number} izdan je račun ${inv?.number ?? ''} — nalog se ne može obrisati.`,
    );
  }
  if (o.itemId) {
    // uređaj u servisu mora imati nalog (otvoren ili popravljen, čeka povrat) — ako je ovo jedini, ne briše se
    const [item, other] = await Promise.all([
      tx.item.findFirst({ where: { id: o.itemId, companyId: actor.companyId }, select: { serial: true, state: true } }),
      tx.serviceOrder.count({ where: { companyId: actor.companyId, itemId: o.itemId, id: { not: o.id }, status: { in: [...OPEN, 'REPAIRED'] } } }),
    ]);
    assert(
      !item || item.state !== 'SERVICE' || other > 0,
      `Uređaj ${item?.serial ?? ''} je na servisu po ovom nalogu — prvo ga vratite kupcu, u najam ili na skladište, pa tek onda obrišite nalog.`,
    );
  }
  await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'serviceOrder', entityId: id } });
  await tx.serviceOrder.delete({ where: { id } });
  if (o.itemId) {
    await itemEvents(tx, actor, [o.itemId], { type: 'SERVICE', message: `Servisni nalog ${o.number} obrisan`, refType: 'service', refId: id });
  }
  await audit(tx, actor, { entity: 'service', entityId: id, action: 'delete', summary: `Servisni nalog ${o.number}${o.serial ? ` (${o.serial})` : ''} obrisan` });
  return o.number;
}
