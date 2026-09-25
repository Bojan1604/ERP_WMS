import 'server-only';
import { Prisma, type ServiceStatus } from '@prisma/client';
import { db } from '../db';
import type { PortalScope } from './session';
import { attachmentMeta } from '../services/attachments';
import { deviceWarrantyEnd } from '../queries/service';
import { escapeLike } from '@/lib/like';
import { OPEN_SERVICE_STATUSES } from '@/components/service/labels';
import { dateRangeWhere, paramStr, parseDateRange, type SearchParams } from '@/lib/list-params';
import { isPortalWarranty, type PortalWarranty } from '@/domain/portal';
import { today } from '@/domain/dates';

// =============================================================================
//  Čitanja portala. SVAKI upit je sužen na firmu i partnera prijavljenog
//  klijenta (`scope.companyId` + `scope.partnerId`); id iz URL-a se nikad ne
//  koristi bez te provjere.
// =============================================================================

const OPEN = OPEN_SERVICE_STATUSES as ServiceStatus[];

/** Uređaji koje klijent vidi: kod njega, osim onih na skladištu i otpisanih. */
const HIDDEN_STATES = ['IN_STOCK', 'WRITTEN_OFF'] as const;

const baseDeviceWhere = (s: PortalScope): Prisma.ItemWhereInput => ({ companyId: s.companyId, partnerId: s.partnerId, state: { notIn: [...HIDDEN_STATES] } });

/**
 * Id-evi klijentovih uređaja po stanju jamstva — računa baza (početak jamstva
 * ili izdavanja + trajanje uređaja ili modela), bez učitavanja uređaja.
 */
async function warrantyIds(s: PortalScope, cls: PortalWarranty): Promise<string[]> {
  const start = Prisma.sql`COALESCE(i."warrantyStart", i."issueDate")`;
  const months = Prisma.sql`COALESCE(i."warrantyMonths", m."warrantyMonths")`;
  const end = Prisma.sql`(${start} + make_interval(months => ${months}))::date`;
  const t = today();
  const cond =
    cls === 'bez'
      ? Prisma.sql`(${start} IS NULL OR COALESCE(${months}, 0) <= 0)`
      : cls === 'u'
        ? Prisma.sql`(${start} IS NOT NULL AND ${months} > 0 AND ${end} >= ${t}::date)`
        : Prisma.sql`(${start} IS NOT NULL AND ${months} > 0 AND ${end} < ${t}::date)`;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT i."id" FROM "Item" i JOIN "DeviceModel" m ON m."id" = i."modelId"
    WHERE i."companyId" = ${s.companyId} AND i."partnerId" = ${s.partnerId}
      AND i."state"::text NOT IN ('IN_STOCK', 'WRITTEN_OFF') AND ${cond}`;
  return rows.map((r) => r.id);
}

export interface PortalDeviceFilters {
  q: string;
  model: string;
  warranty: PortalWarranty | '';
  from: string | null;
  to: string | null;
}

export function parsePortalDeviceFilters(sp: SearchParams | URLSearchParams): PortalDeviceFilters {
  const w = paramStr(sp, 'jamstvo');
  const r = parseDateRange(sp);
  return { q: paramStr(sp, 'q').slice(0, 100), model: paramStr(sp, 'model'), warranty: isPortalWarranty(w) ? w : '', from: r.from, to: r.to };
}

async function deviceWhere(s: PortalScope, f: PortalDeviceFilters): Promise<Prisma.ItemWhereInput> {
  const and: Prisma.ItemWhereInput[] = [baseDeviceWhere(s)];
  if (f.q) {
    const ci = { contains: escapeLike(f.q), mode: 'insensitive' as const };
    and.push({ OR: [{ serial: ci }, { model: { OR: [{ name: ci }, { brand: ci }] } }] });
  }
  if (f.model) and.push({ modelId: f.model });
  const range = dateRangeWhere({ from: f.from, to: f.to });
  if (range) and.push({ issueDate: range });
  if (f.warranty) and.push({ id: { in: await warrantyIds(s, f.warranty) } });
  return { AND: and };
}

const deviceSelect = {
  id: true,
  serial: true,
  state: true,
  issueDate: true,
  warrantyStart: true,
  warrantyMonths: true,
  model: { select: { brand: true, name: true, warrantyMonths: true } },
  status: { select: { name: true } },
  serviceOrders: { where: { status: { in: OPEN } }, select: { id: true, number: true, status: true }, take: 1 },
} satisfies Prisma.ItemSelect;

export type PortalDevice = Prisma.ItemGetPayload<{ select: typeof deviceSelect }> & { warrantyEnd: string | null; prevState: string | null };

type DeviceRow = Prisma.ItemGetPayload<{ select: typeof deviceSelect }>;

/**
 * Jamstvo i vlasništvo prije servisa (`prevState`): uređaj na servisu (ili drugom stanju osim najma/prodaje)
 * za klijenta je i dalje „najam" ili „kupnja". Stanje prije servisa je u snimci pri otvaranju zadnjeg
 * naloga, a za naloge otvorene promjenom statusa — skidanje s ugovora u povijesti uređaja
 * (isto pravilo kao `previousState` u services/service.ts). Jedan upit za cijelu stranicu.
 */
async function withWarranty(companyId: string, rows: DeviceRow[]): Promise<PortalDevice[]> {
  const other = rows.filter((r) => r.state !== 'RENTED' && r.state !== 'SOLD').map((r) => r.id);
  const prev = new Map<string, string>();
  if (other.length) {
    const orders = await db.serviceOrder.findMany({
      where: { companyId, itemId: { in: other } },
      orderBy: { createdAt: 'desc' },
      distinct: ['itemId'],
      select: { itemId: true, createdAt: true, timeline: true },
    });
    const noSnap: Array<{ itemId: string; createdAt: Date }> = [];
    for (const o of orders) {
      const first = Array.isArray(o.timeline) ? (o.timeline[0] as { prev?: { state?: unknown } } | null) : null;
      const st = first?.prev?.state;
      if (typeof st === 'string') prev.set(o.itemId!, st);
      else noSnap.push({ itemId: o.itemId!, createdAt: o.createdAt });
    }
    if (noSnap.length) {
      const removed = await db.itemEvent.findMany({
        where: { OR: noSnap.map((o) => ({ itemId: o.itemId, type: 'CONTRACT' as const, refType: 'contract', at: { gte: new Date(o.createdAt.getTime() - 60_000) } })) },
        select: { itemId: true },
      });
      const rented = new Set(removed.map((e) => e.itemId));
      for (const o of noSnap) prev.set(o.itemId, rented.has(o.itemId) ? 'RENTED' : 'SOLD');
    }
  }
  return rows.map((r) => ({ ...r, warrantyEnd: deviceWarrantyEnd(r), prevState: prev.get(r.id) ?? null }));
}

/** Popis uređaja klijenta (straničenje u bazi) s brojačima za podnožje. */
export async function listPortalDevices(s: PortalScope, f: PortalDeviceFilters, page: { skip: number; take: number }) {
  const where = await deviceWhere(s, f);
  const [rows, total, all, byState, inService, inWarrantyIds] = await Promise.all([
    db.item.findMany({ where, orderBy: [{ issueDate: { sort: 'desc', nulls: 'last' } }, { serial: 'asc' }], skip: page.skip, take: page.take, select: deviceSelect }),
    db.item.count({ where }),
    db.item.count({ where: baseDeviceWhere(s) }),
    db.item.groupBy({ by: ['state'], where, _count: { _all: true } }),
    db.item.count({ where: { AND: [where, { serviceOrders: { some: { status: { in: OPEN } } } }] } }),
    warrantyIds(s, 'u'),
  ]);
  const inWarranty = inWarrantyIds.length ? await db.item.count({ where: { AND: [where, { id: { in: inWarrantyIds } }] } }) : 0;
  const count = (st: string) => byState.find((g) => g.state === st)?._count._all ?? 0;
  return { rows: await withWarranty(s.companyId, rows), total, all, stats: { rented: count('RENTED'), sold: count('SOLD'), inService, inWarranty } };
}

/** Svi uređaji po filtrima — za izvoz (Excel/PDF). */
export async function exportPortalDevices(s: PortalScope, f: PortalDeviceFilters) {
  const rows = await db.item.findMany({ where: await deviceWhere(s, f), orderBy: [{ issueDate: { sort: 'desc', nulls: 'last' } }, { serial: 'asc' }], select: deviceSelect, take: 20_000 });
  return withWarranty(s.companyId, rows);
}

/** Modeli klijentovih uređaja — za filtar. */
export async function portalModels(s: PortalScope) {
  const groups = await db.item.groupBy({ by: ['modelId'], where: baseDeviceWhere(s) });
  if (!groups.length) return [];
  const models = await db.deviceModel.findMany({ where: { id: { in: groups.map((g) => g.modelId) }, companyId: s.companyId }, select: { id: true, brand: true, name: true } });
  return models.map((m) => ({ value: m.id, label: [m.brand, m.name].filter(Boolean).join(' ') })).sort((a, b) => a.label.localeCompare(b.label, 'hr'));
}

/** Jedan uređaj klijenta (za prijavu kvara) — `null` ako nije njegov ili nije aktivan. */
export function portalDevice(s: PortalScope, itemId: string) {
  return db.item
    .findFirst({ where: { AND: [baseDeviceWhere(s), { id: itemId }] }, select: deviceSelect })
    .then(async (r) => (r ? (await withWarranty(s.companyId, [r]))[0] : null));
}

// ---------------------------------------------------------------- prijave (servisni nalozi)

const orderWhere = (s: PortalScope): Prisma.ServiceOrderWhereInput => ({ companyId: s.companyId, partnerId: s.partnerId });

const orderListSelect = {
  id: true,
  number: true,
  status: true,
  reportedAt: true,
  closedAt: true,
  issue: true,
  solution: true,
  serial: true,
  source: true,
  item: { select: { serial: true, model: { select: { brand: true, name: true } } } },
  replacement: { select: { serial: true, issueDate: true, model: { select: { brand: true, name: true } } } },
} satisfies Prisma.ServiceOrderSelect;

export async function listPortalOrders(s: PortalScope, page: { skip: number; take: number }) {
  const where = orderWhere(s);
  const [rows, total, open] = await Promise.all([
    db.serviceOrder.findMany({ where, orderBy: [{ reportedAt: 'desc' }, { number: 'desc' }], skip: page.skip, take: page.take, select: orderListSelect }),
    db.serviceOrder.count({ where }),
    db.serviceOrder.count({ where: { ...where, status: { in: OPEN } } }),
  ]);
  return { rows, total, open };
}

/** Nalog klijenta s tijekom i fotografijama; bez internih polja (dijagnoza, trošak, napomena). */
export async function portalOrder(s: PortalScope, id: string) {
  const o = await db.serviceOrder.findFirst({
    where: { ...orderWhere(s), id },
    select: { ...orderListSelect, publicNote: true, timeline: true, underWarranty: true, receivedAt: true, contact: true, createdAt: true },
  });
  if (!o) return null;
  // klijent vidi samo priloge označene „vidljivo klijentu" (svoje fotografije s prijave i one koje servis podijeli)
  const photos = await db.attachment.findMany({ where: { companyId: s.companyId, entity: 'serviceOrder', entityId: o.id, public: true }, orderBy: { createdAt: 'asc' }, select: attachmentMeta });
  return { ...o, photos };
}

/** Prilog naloga klijenta (sa sadržajem) — samo prilozi njegovih servisnih naloga vidljivi klijentu. */
export async function portalAttachment(s: PortalScope, attachmentId: string) {
  const a = await db.attachment.findFirst({ where: { id: attachmentId, companyId: s.companyId, entity: 'serviceOrder', public: true }, select: { ...attachmentMeta, data: true } });
  if (!a) return null;
  const mine = await db.serviceOrder.count({ where: { ...orderWhere(s), id: a.entityId } });
  return mine ? a : null;
}

/** Podaci za nalog za dostavu (list u paketu s uređajem). */
export async function portalDeliveryNote(s: PortalScope, id: string) {
  return db.serviceOrder.findFirst({
    where: { ...orderWhere(s), id },
    select: {
      id: true,
      number: true,
      status: true,
      reportedAt: true,
      issue: true,
      serial: true,
      contact: true,
      underWarranty: true,
      item: { select: { serial: true, model: { select: { brand: true, name: true } } } },
      partner: true,
    },
  });
}
