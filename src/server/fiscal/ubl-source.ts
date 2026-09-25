import 'server-only';
import { db } from '../db';
import { buildUbl, type UblKind } from '@/domain/ubl';
import { groupLines, type ChargeInput } from '@/domain/invoice';
import { UBL_PAYMENT_MEANS } from '@/domain/fiscal';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { readMeta } from './issue';
import { defaultKpd, effectiveLineType, invoiceRentMonths, kpdIssues, kpdRequired, rentLineView, rentPeriodRange } from '@/domain/sales-lines';

const timeOf = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d) : undefined;

/** eRačun (UBL 2.1, HR CIUS-2025) za izdani račun: XML, naziv datoteke i osnovni podaci. Null ako račun ne postoji. */
export async function invoiceUbl(companyId: string, id: string) {
  const inv = await db.invoice.findFirst({
    where: { id, companyId },
    include: {
      company: { omit: { fiscalCert: true, fiscalCertPassword: true, eInvoiceApiKey: true } },
      partner: true,
      refInvoice: { select: { number: true, date: true, kind: true } },
      advanceUses: { orderBy: { createdAt: 'asc' }, select: { advance: { select: { number: true, date: true } } } },
      lines: {
        orderBy: { sort: 'asc' },
        select: {
          description: true,
          unit: true,
          kpd: true,
          qty: true,
          unitPrice: true,
          discountPct: true,
          kind: true,
          lineType: true,
          monthly: true,
          months: true,
          item: { select: { serial: true } },
          model: { select: { code: true, kpd: true, kpdRent: true } },
          service: { select: { kpd: true } },
        },
      },
    },
  });
  if (!inv) return null;
  if (inv.status !== 'ISSUED' || !inv.number) return { inv, xml: null, fileName: null, issues: [] as string[] };
  const c = inv.company;
  const meta = readMeta(inv.eInvoice);
  // KPD sa stavke; stariji zapisi bez njega — model/usluga, pa zadana šifra firme po vrsti stavke
  const lineKpd = (l: (typeof inv.lines)[number]) =>
    l.kpd ??
    defaultKpd({
      lineType: effectiveLineType(l.lineType, inv.type),
      kind: l.kind,
      serviceKpd: l.service?.kpd,
      modelKpd: l.model?.kpd,
      modelKpdRent: l.model?.kpdRent,
      company: c,
    });
  // lokalna provjera prije slanja posredniku (HR-BR-25): KPD na svakoj stavci računa i storna računa
  const issues = kpdRequired(inv.kind, inv.refInvoice?.kind) ? kpdIssues(inv.lines.map((l) => ({ description: l.description, kpd: lineKpd(l) }))) : [];
  // najam: razdoblje rate od–do prema broju mjeseci naplate; stavka „kom" (količina = uređaji) s razdobljem u nazivu
  const months = invoiceRentMonths(inv.lines);
  const range = rentPeriodRange(inv.period, months);
  const view = (l: (typeof inv.lines)[number]) =>
    rentLineView({ description: l.description, unit: l.unit, monthly: l.monthly === null ? null : num(l.monthly), months: l.months }, range);
  const { xml, fileName } = buildUbl({
    kind: inv.kind as UblKind,
    type: inv.type,
    number: inv.number,
    issueDate: toISO(inv.date),
    issueTime: timeOf(inv.issuedAt),
    dueDate: inv.dueDate ? toISO(inv.dueDate) : null,
    deliveryDate: inv.deliveryDate ? toISO(inv.deliveryDate) : null,
    period: inv.period,
    periodMonths: months,
    currency: c.currency,
    notes: [inv.description, inv.note],
    seller: { name: c.name, oib: c.oib, vatId: c.vatId, address: c.address, zip: c.zip, city: c.city, country: c.country, iban: c.iban, vatRegistered: inv.sellerVatRegistered ?? c.vatRegistered },
    // preslika s izdanog računa (stariji računi bez nje — trenutne postavke firme)
    vatOnPayment: inv.vatOnPayment ?? c.vatOnPayment,
    // operater: ime i OIB korisnika koji je izdao račun (stariji računi bez OIB-a korisnika nose OIB firme)
    operator: inv.issuedBy ? { name: meta.operator?.name ?? inv.issuedBy, oib: meta.operator?.oib ?? c.oib } : null,
    buyer: {
      name: inv.partner.name,
      oib: inv.partner.oib,
      vatId: inv.partner.vatId,
      address: inv.partner.address,
      zip: inv.partner.zip,
      city: inv.partner.city,
      country: inv.partner.country,
      endpointId: inv.partner.endpointId,
      branchCode: inv.partner.branchCode,
      branchName: inv.partner.branchName,
    },
    vatRate: num(inv.vatRate),
    taxCategory: inv.taxCategory,
    exemptReason: inv.taxExemptReason,
    discountPct: num(inv.discountPct),
    discountAmount: num(inv.discountAmount),
    charges: Array.isArray(inv.charges) ? (inv.charges as unknown as ChargeInput[]) : [],
    advanceAmount: num(inv.advanceAmount),
    // model poziva na broj i način plaćanja iz postavki firme (HR00 / 30 ili 58 za transakcijski račun)
    paymentModel: c.paymentModel || 'HR00',
    paymentReference: inv.paymentRef,
    paymentMeansCode: inv.paymentMethod === 'TRANSFER' ? c.eInvoicePaymentMeans || UBL_PAYMENT_MEANS.TRANSFER : UBL_PAYMENT_MEANS[inv.paymentMethod],
    advanceReferences: inv.advanceUses.flatMap((u) => (u.advance.number ? [{ number: u.advance.number, date: toISO(u.advance.date) }] : [])),
    billingReference: inv.refInvoice?.number ? { number: inv.refInvoice.number, date: toISO(inv.refInvoice.date), kind: inv.refInvoice.kind as UblKind } : null,
    // uređaji istog modela i cijene idu kao jedna stavka s količinom i popisom serijskih
    lines: groupLines(
      inv.lines.map((l) => ({
        description: view(l).description,
        unit: view(l).unit,
        serial: l.item?.serial ?? null,
        code: l.model?.code ?? null,
        kpd: lineKpd(l),
        qty: num(l.qty),
        unitPrice: num(l.unitPrice),
        discountPct: num(l.discountPct),
      })),
      (l) => (l.serial ? [l.description, l.code ?? '', l.kpd ?? '', l.unit, l.unitPrice, l.discountPct].join('|') : null),
    ).map(({ lines: g }) =>
      g.length === 1 ? g[0] : { ...g[0], serial: null, serials: g.flatMap((x) => (x.serial ? [x.serial] : [])), qty: g.reduce((a, x) => a + x.qty, 0) },
    ),
  });
  return { inv, xml, fileName, issues };
}
