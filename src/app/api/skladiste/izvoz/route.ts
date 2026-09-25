import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { exportItems, parseItemFilters } from '@/server/queries/warehouse';
import { modelLabel } from '@/server/queries/lookups';
import { csvOrXlsx } from '@/server/xlsx';
import type { ExportColumn } from '@/lib/csv';
import { canSeeCost } from '@/domain/permissions';
import { num } from '@/domain/money';
import { formatDate, toISO, today } from '@/domain/dates';
import { suggestedSalePrice } from '@/domain/pricing';
import { warrantyDaysLeft } from '@/domain/warehouse-list';

/** Izvoz filtriranih uređaja (CSV / Excel / PDF) — isti filtri i redoslijed kao popis skladišta, svi stupci. */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('warehouse', 'view');
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    return new Response(e instanceof Error ? e.message : 'Greška', { status });
  }
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const [rows, company] = await Promise.all([
    exportItems(user.companyId, parseItemFilters(sp)),
    db.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { name: true, defaultMarginPct: true, defaultWarrantyMonths: true } }),
  ]);
  type Row = (typeof rows)[number];
  const d = (v: Date | null) => (v ? formatDate(v) : '');
  const n = (v: { toNumber(): number } | null | undefined) => (v === null || v === undefined ? null : num(v));
  const costs = canSeeCost(user.perms);
  const margin = num(company.defaultMarginPct);
  const suggested = (r: Row) =>
    suggestedSalePrice({ modelPrice: n(r.model.salePrice), cost: num(r.cost), itemMargin: n(r.marginPct), modelMargin: n(r.model.marginPct), companyMargin: margin }).price;
  const warranty = (r: Row) => {
    const start = r.warrantyStart ?? r.invoice?.date ?? r.issueDate;
    return warrantyDaysLeft(start ? toISO(start) : null, r.warrantyMonths ?? r.model.warrantyMonths ?? company.defaultWarrantyMonths);
  };
  const columns: Array<ExportColumn<Row> & { cost?: boolean }> = [
    { label: 'Status', value: (r) => r.status.name },
    { label: 'Serijski broj', value: (r) => r.serial },
    { label: 'Razlikovna napomena', value: (r) => r.dupNote },
    { label: 'Klijent', value: (r) => r.partner?.name },
    { label: 'Kategorija', value: (r) => r.category?.name ?? r.model.category?.name },
    { label: 'Proizvođač', value: (r) => r.model.brand },
    { label: 'Model', value: (r) => modelLabel(r.model) },
    { label: 'Procesor', value: (r) => r.cpu },
    { label: 'Ekran', value: (r) => r.screen },
    { label: 'OS', value: (r) => r.os },
    { label: 'Skladište', value: (r) => r.warehouse?.name },
    { label: 'Dobavljač', value: (r) => r.supplier?.name },
    { label: 'Nabavna cijena', value: (r) => num(r.cost), type: 'money', cost: true },
    { label: 'Preporučena cijena', value: suggested, type: 'money' },
    { label: 'Prodajna cijena', value: (r) => n(r.salePrice), type: 'money' },
    { label: 'Najam €/mj', value: (r) => n(r.rentPrice ?? r.model.rentPrice), type: 'money' },
    { label: 'Datum uvoza', value: (r) => d(r.importDate), type: 'date' },
    { label: 'Datum izdavanja', value: (r) => d(r.issueDate), type: 'date' },
    { label: 'Račun', value: (r) => r.invoice?.number },
    { label: 'Ugovor', value: (r) => r.contractItem?.contract.number },
    { label: 'Jamstvo (dana)', value: warranty, type: 'int' },
    { label: 'Napomena', value: (r) => r.note },
  ];
  return csvOrXlsx<Row>(
    req,
    rows,
    columns.filter((c) => costs || !c.cost),
    `skladiste-${today()}`,
    'Uređaji',
    { companyName: company.name, landscape: true, subtitle: `${rows.length} uređaja · ${formatDate(today())}` },
  );
}
