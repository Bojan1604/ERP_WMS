import 'server-only';
import { db } from '../db';
import { DomainError } from '../errors';
import { backupToPlan, isBackup } from './backup';
import { mapLegacy } from './legacy';
import { ENTITY_LABEL, planCounts, type ImportPlan } from './plan';
import { STATE_LABEL } from '@/domain/warehouse';
import { INVOICE_KIND_LABEL } from '@/domain/invoice';
import { planSummary, type ContractTerms } from '@/domain/billing';

/** Datoteka → plan (stara verzija u bilo kojem obliku ili sigurnosna kopija ove aplikacije). */
export function planFromJson(raw: unknown): { plan: ImportPlan; notes: string[] } {
  if (isBackup(raw)) return { plan: backupToPlan(raw), notes: [] };
  const legacy = mapLegacy(raw);
  if (!legacy) {
    throw new DomainError('Oblik datoteke nije prepoznat. Očekuje se izvoz stare verzije (objekt s items, invoices, partners…) ili sigurnosna kopija ove aplikacije.');
  }
  return legacy;
}

export interface Analysis {
  format: string;
  label: string;
  isBackup: boolean;
  companyName: string | null;
  exportedAt: string | null;
  notes: string[];
  counts: Array<{ key: string; label: string; count: number }>;
  warningTotal: number;
  warningCounts: Record<string, number>;
  warnings: ImportPlan['warnings'];
  users: ImportPlan['users'];
  samples: {
    items: Array<{ serial: string; model: string; status: string; state: string; partner: string | null; cost: number }>;
    invoices: Array<{ number: string | null; date: string; kind: string; type: string; partner: string; total: number; paid: number; open: number; lines: number }>;
    contracts: Array<{ number: string; partner: string; status: string; devices: number; plans: string[] }>;
  };
  /** Stanje trenutne firme — za odluku uvoziti li u nju. */
  current: { companyName: string; items: number; invoices: number; partners: number; overlap: { items: number; invoices: number; partners: number } };
}

export async function analyzePlan(plan: ImportPlan, notes: string[], companyId: string): Promise<Analysis> {
  const counts = planCounts(plan);
  const models = new Map(plan.models.map((m) => [m.key, [m.brand, m.name].filter(Boolean).join(' ')]));
  const statuses = new Map(plan.statuses.map((s) => [s.key, s.name]));
  const partners = new Map(plan.partners.map((p) => [p.key, p.name]));

  const [company, items, invoices, partnerCount] = await Promise.all([
    db.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } }),
    db.item.count({ where: { companyId } }),
    db.invoice.count({ where: { companyId } }),
    db.partner.count({ where: { companyId } }),
  ]);
  // preklapanje s trenutnom firmom (po istim prirodnim ključevima kao pri uvozu)
  const overlap = { items: 0, invoices: 0, partners: 0 };
  if (items) {
    const serials = [...new Set(plan.items.map((i) => i.serial))];
    for (let i = 0; i < serials.length; i += 10_000) {
      overlap.items += await db.item.count({ where: { companyId, serial: { in: serials.slice(i, i + 10_000) } } });
    }
  }
  if (invoices) {
    const years = [...new Set(plan.invoices.map((i) => i.year))];
    const have = await db.invoice.findMany({ where: { companyId, year: { in: years }, seq: { not: null } }, select: { year: true, seq: true } });
    const set = new Set(have.map((h) => `${h.year}|${h.seq}`));
    overlap.invoices = plan.invoices.filter((i) => i.seq && set.has(`${i.year}|${i.seq}`)).length;
  }
  if (partnerCount) {
    const oibs = plan.partners.map((p) => p.oib).filter((o): o is string => !!o);
    overlap.partners = oibs.length ? await db.partner.count({ where: { companyId, oib: { in: oibs } } }) : 0;
  }

  const terms = (k: ImportPlan['contracts'][number]): ContractTerms => ({
    status: k.status, startDate: k.startDate, endDate: k.endDate, firstBillingDate: k.firstBillingDate, billingDay: k.billingDay,
    billing: k.billing, billingMode: k.billingMode, seasonFrom: k.seasonFrom, seasonTo: k.seasonTo,
  });

  return {
    format: plan.source.format,
    label: plan.source.label,
    isBackup: plan.source.format === 'erp-wms-backup',
    companyName: plan.source.companyName ?? plan.company.name ?? null,
    exportedAt: plan.source.exportedAt,
    notes,
    counts: Object.entries(counts).filter(([, n]) => n > 0).map(([key, count]) => ({ key, label: ENTITY_LABEL[key] ?? key, count })),
    warningTotal: Object.values(plan.warningCounts).reduce((a, b) => a + b, 0) || plan.warnings.length,
    warningCounts: plan.warningCounts,
    warnings: plan.warnings.slice(0, 200),
    users: plan.users.slice(0, 100),
    samples: {
      items: plan.items.slice(0, 8).map((i) => ({
        serial: i.dupNote ? `${i.serial} (${i.dupNote})` : i.serial, model: models.get(i.modelKey) ?? '—', status: statuses.get(i.statusKey) ?? '—',
        state: STATE_LABEL[i.state], partner: i.partnerKey ? (partners.get(i.partnerKey) ?? null) : null, cost: i.cost,
      })),
      invoices: [...plan.invoices].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8).map((i) => ({
        number: i.number, date: i.date, kind: INVOICE_KIND_LABEL[i.kind], type: i.type === 'RENT' ? 'najam' : i.type === 'SERVICE' ? 'usluga' : 'prodaja',
        partner: partners.get(i.partnerKey) ?? '—', total: i.totals?.grandTotal ?? 0, paid: i.totals?.paidTotal ?? 0, open: i.totals?.openAmount ?? 0, lines: i.lines.length,
      })),
      contracts: plan.contracts.slice(0, 5).map((k) => ({
        number: k.number, partner: partners.get(k.partnerKey) ?? '—', status: k.status, devices: k.items.length,
        plans: k.items.slice(0, 3).map((ci) => planSummary(terms(k), { itemId: ci.itemKey, monthly: ci.monthly, plan: ci.plan, status: ci.status, skipped: ci.skipped })),
      })),
    },
    current: { companyName: company.name, items, invoices, partners: partnerCount, overlap },
  };
}
