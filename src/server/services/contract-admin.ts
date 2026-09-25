import 'server-only';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import { changeItemStatus, itemEvents, type Actor } from './items';
import { periodLabel } from '@/domain/dates';
import { r2 } from '@/domain/money';

// =============================================================================
//  Ugovori — brisanje, vraćanje preskočene rate, skupni ručni iznosi najma
// =============================================================================

/**
 * Brisanje ugovora (C5) — samo dok za njega ne postoji nijedan račun (ni nacrt).
 * Uređaji na ugovoru: `warehouseId` = ugovor je otvoren greškom, uređaji se vraćaju
 * na to skladište; bez njega su uređaji kod klijenta i idu u povrat („U dolasku").
 * Uređaji već u povratu („U dolasku") uz skladište idu na skladište, bez njega
 * ostaju u povratu (zaprimaju se na skladištu i bez ugovora). Ručni iznosi najma
 * tih uređaja od početka ugovora brišu se s njim.
 * Prilozi ugovora brišu se s njim; ponude gube vezu (SetNull).
 */
export async function deleteContract(tx: Tx, actor: Actor, id: string, opts: { warehouseId?: string | null } = {}) {
  const c = await tx.contract.findFirst({
    where: { id, companyId: actor.companyId },
    select: { id: true, number: true, startDate: true, partner: { select: { name: true } }, _count: { select: { invoices: true } } },
  });
  assert(c, 'Ugovor ne postoji.');
  assert(
    !c._count.invoices,
    `Ugovor ${c.number} ima račune (${c._count.invoices}) — ne može se obrisati. Otkažite ga ili ga označite kao istekao.`,
  );
  const onContract = await tx.contractItem.findMany({ where: { contractId: id }, select: { itemId: true, item: { select: { state: true } } } });
  const rented = onContract.filter((r) => r.item.state === 'RENTED').map((r) => r.itemId);
  const returning = onContract.filter((r) => r.item.state === 'RETURNING').map((r) => r.itemId);
  let moved = '';
  if ((rented.length || returning.length) && opts.warehouseId) {
    const wh = await tx.warehouse.findFirst({ where: { id: opts.warehouseId, companyId: actor.companyId }, select: { id: true, name: true } });
    assert(wh, 'Skladište ne postoji.');
    await changeItemStatus(tx, actor, [...rented, ...returning], {
      kind: 'IN_STOCK',
      data: { warehouseId: wh.id },
      event: { type: 'CONTRACT', message: `Vraćen na skladište ${wh.name} — ugovor ${c.number} obrisan`, refType: 'contract', refId: id },
    });
    moved = ` — ${rented.length + returning.length} uređaja vraćeno na skladište ${wh.name}`;
  } else if (rented.length) {
    await changeItemStatus(tx, actor, rented, {
      kind: 'RETURNING',
      event: { type: 'RETURNING', message: `Najavljen povrat — ugovor ${c.number} obrisan`, refType: 'contract', refId: id },
    });
    moved = ` — ${rented.length} uređaja najavljeno za povrat`;
  }
  if (returning.length && !opts.warehouseId) {
    await itemEvents(tx, actor, returning, { type: 'CONTRACT', message: `Ugovor ${c.number} obrisan — povrat se zaprima na skladištu`, refType: 'contract', refId: id });
  }
  // ručni iznosi najma uređaja ugovora (i skinutih) od početka ugovora
  const returnedIds = await tx.returnedContractItem.findMany({ where: { contractId: id }, select: { itemId: true } });
  const itemIds = [...new Set([...onContract.map((r) => r.itemId), ...returnedIds.map((r) => r.itemId)])];
  if (itemIds.length) {
    const y = c.startDate.getUTCFullYear();
    const m = c.startDate.getUTCMonth() + 1;
    await tx.rentOverride.deleteMany({
      where: { companyId: actor.companyId, itemId: { in: itemIds }, OR: [{ year: { gt: y } }, { year: y, month: { gte: m } }] },
    });
  }
  await tx.attachment.deleteMany({ where: { companyId: actor.companyId, entity: 'contract', entityId: id } });
  // uređaji na ugovoru i snimke skinutih brišu se s ugovorom (Cascade)
  await tx.contract.delete({ where: { id } });
  await audit(tx, actor, {
    entity: 'contract',
    entityId: id,
    action: 'delete',
    summary: `Ugovor ${c.number} (${c.partner.name}) obrisan${moved}`,
  });
  return { number: c.number, returned: opts.warehouseId ? rented.length + returning.length : rented.length };
}

/**
 * „Vrati u izdavanje" (C5): razdoblje označeno kao izdano izvan programa
 * (preskočeno) ponovno se traži kao rata — na svim uređajima ugovora, i skinutim.
 */
export async function unskipInstallment(tx: Tx, actor: Actor, contractId: string, period: string) {
  assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(period), 'Neispravno razdoblje.');
  const c = await tx.contract.findFirst({ where: { id: contractId, companyId: actor.companyId }, select: { id: true, number: true } });
  assert(c, 'Ugovor ne postoji.');
  const where = { contractId, skipped: { has: period } };
  const [rows, returned] = await Promise.all([
    tx.contractItem.findMany({ where, select: { id: true, skipped: true } }),
    tx.returnedContractItem.findMany({ where, select: { id: true, skipped: true } }),
  ]);
  const n = rows.length + returned.length;
  assert(n, `Razdoblje ${periodLabel(period)} nije označeno kao izdano izvan programa.`);
  // uređaji s istim popisom preskočenih razdoblja upisuju se zajedno
  const group = <T extends { id: string; skipped: string[] }>(list: T[]) => {
    const m = new Map<string, { skipped: string[]; ids: string[] }>();
    for (const r of list) {
      const next = r.skipped.filter((p) => p !== period);
      const k = next.join(',');
      const g = m.get(k) ?? { skipped: next, ids: [] };
      g.ids.push(r.id);
      m.set(k, g);
    }
    return [...m.values()];
  };
  for (const g of group(rows)) await tx.contractItem.updateMany({ where: { id: { in: g.ids } }, data: { skipped: g.skipped } });
  for (const g of group(returned)) await tx.returnedContractItem.updateMany({ where: { id: { in: g.ids } }, data: { skipped: g.skipped } });
  await audit(tx, actor, {
    entity: 'contract',
    entityId: c.id,
    action: 'unskip',
    summary: `Ugovor ${c.number}: rata za ${periodLabel(period)} vraćena u izdavanje (${n} uređaja)`,
  });
  return n;
}

/**
 * Skupni ručni upis u mreži najma (C4): isti iznos u više ćelija, ili „Auto"
 * (amount = null) briše ručne upise pa vrijedi izračun s ugovora.
 */
export async function setRentOverrides(
  tx: Tx,
  actor: Actor,
  input: { year: number; cells: Array<{ itemId: string; month: number }>; amount: number | null },
) {
  assert(input.cells.length, 'Označite barem jedno polje.');
  assert(input.cells.length <= 5000, 'Odjednom se može izmijeniti najviše 5000 polja.');
  assert(input.cells.every((c) => Number.isInteger(c.month) && c.month >= 1 && c.month <= 12), 'Neispravan mjesec.');
  assert(input.amount === null || input.amount >= 0, 'Iznos ne može biti negativan.');
  const ids = [...new Set(input.cells.map((c) => c.itemId))];
  const items = await tx.item.findMany({ where: { id: { in: ids }, companyId: actor.companyId }, select: { id: true } });
  assert(items.length === ids.length, 'Neki uređaji ne postoje.');
  const uniq = [...new Map(input.cells.map((c) => [`${c.itemId}|${c.month}`, c])).values()];
  // uvjet po mjesecima (najviše 12 grana), ne po ćeliji
  const byMonth = new Map<number, string[]>();
  for (const c of uniq) byMonth.set(c.month, [...(byMonth.get(c.month) ?? []), c.itemId]);
  const cellsWhere = { companyId: actor.companyId, year: input.year, OR: [...byMonth].map(([month, itemIds]) => ({ month, itemId: { in: itemIds } })) };
  if (input.amount === null) {
    const res = await tx.rentOverride.deleteMany({ where: cellsWhere });
    await audit(tx, actor, {
      entity: 'rent',
      entityId: String(input.year),
      action: 'rent-override',
      summary: `Pregled najma ${input.year}: ${uniq.length} polja vraćeno na izračun (${res.count} ručnih upisa uklonjeno)`,
    });
    return uniq.length;
  }
  const amount = r2(input.amount);
  // postojeći upisi se mijenjaju jednim upitom, novi se dodaju zajedno
  await tx.rentOverride.updateMany({ where: cellsWhere, data: { amount } });
  await tx.rentOverride.createMany({
    data: uniq.map((c) => ({ companyId: actor.companyId, itemId: c.itemId, year: input.year, month: c.month, amount })),
    skipDuplicates: true,
  });
  await audit(tx, actor, {
    entity: 'rent',
    entityId: String(input.year),
    action: 'rent-override',
    summary: `Pregled najma ${input.year}: ${uniq.length} polja postavljeno na ${amount.toFixed(2).replace('.', ',')} € (${ids.length} uređaja)`,
  });
  return uniq.length;
}
