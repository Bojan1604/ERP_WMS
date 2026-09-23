import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { buildUbl, type UblKind } from '@/domain/ubl';
import type { ChargeInput } from '@/domain/invoice';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';

const timeOf = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zagreb', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d) : undefined;

/** eRačun (UBL 2.1, HR CIUS-2025) za izdani račun — preuzimanje XML datoteke. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('sales', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const inv = await db.invoice.findFirst({
    where: { id, companyId: user.companyId },
    include: {
      company: true,
      partner: true,
      refInvoice: { select: { number: true, date: true, kind: true } },
      lines: {
        orderBy: { sort: 'asc' },
        select: {
          description: true,
          unit: true,
          kpd: true,
          qty: true,
          unitPrice: true,
          discountPct: true,
          item: { select: { serial: true } },
          model: { select: { code: true, kpd: true } },
          service: { select: { kpd: true } },
        },
      },
    },
  });
  if (!inv) return new Response('Račun ne postoji.', { status: 404 });
  if (inv.status !== 'ISSUED' || !inv.number) return new Response('eRačun se izrađuje samo za izdani račun.', { status: 409 });

  const c = inv.company;
  const { xml, fileName } = buildUbl({
    kind: inv.kind as UblKind,
    type: inv.type,
    number: inv.number,
    issueDate: toISO(inv.date),
    issueTime: timeOf(inv.issuedAt),
    dueDate: inv.dueDate ? toISO(inv.dueDate) : null,
    deliveryDate: inv.deliveryDate ? toISO(inv.deliveryDate) : null,
    period: inv.period,
    currency: c.currency,
    notes: [inv.description, inv.note],
    seller: { name: c.name, oib: c.oib, vatId: c.vatId, address: c.address, zip: c.zip, city: c.city, country: c.country, iban: c.iban, vatRegistered: c.vatRegistered },
    // korisnik nema vlastiti OIB u modelu — operater nosi OIB firme
    operator: inv.issuedBy ? { name: inv.issuedBy, oib: c.oib } : null,
    buyer: {
      name: inv.partner.name,
      oib: inv.partner.oib,
      vatId: inv.partner.vatId,
      address: inv.partner.address,
      zip: inv.partner.zip,
      city: inv.partner.city,
      country: inv.partner.country,
    },
    vatRate: num(inv.vatRate),
    taxCategory: inv.taxCategory,
    exemptReason: inv.taxExemptReason,
    discountPct: num(inv.discountPct),
    discountAmount: num(inv.discountAmount),
    charges: Array.isArray(inv.charges) ? (inv.charges as unknown as ChargeInput[]) : [],
    advanceAmount: num(inv.advanceAmount),
    paymentModel: 'HR00',
    paymentReference: inv.paymentRef,
    billingReference: inv.refInvoice?.number ? { number: inv.refInvoice.number, date: toISO(inv.refInvoice.date), kind: inv.refInvoice.kind as UblKind } : null,
    lines: inv.lines.map((l) => ({
      description: l.description,
      serial: l.item?.serial ?? null,
      code: l.model?.code ?? null,
      kpd: l.kpd ?? l.model?.kpd ?? l.service?.kpd ?? null,
      unit: l.unit,
      qty: num(l.qty),
      unitPrice: num(l.unitPrice),
      discountPct: num(l.discountPct),
    })),
  });
  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
