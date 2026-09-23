import { DocumentShell, DocTable, DocTotals, type DocCompany, type DocParty } from '@/components/doc/document';
import { CHARGE_KINDS, INVOICE_KIND_LABEL, type ChargeInput } from '@/domain/invoice';
import { formatDate } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { amount, decimal, eur } from '@/lib/format';

/** Podaci računa za ispis — obični objekti (poslužitelj ih priprema iz baze). */
export interface InvoiceDocData {
  id: string;
  kind: 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE';
  status: 'DRAFT' | 'ISSUED';
  number: string | null;
  date: string;
  dueDate: string | null;
  deliveryDate: string | null;
  issuedAt: string | null;
  issuedBy: string | null;
  vatRate: number;
  taxCategory: string;
  taxExemptReason: string | null;
  netTotal: number;
  vatTotal: number;
  grandTotal: number;
  advanceAmount: number;
  paidTotal: number;
  openAmount: number;
  charges: ChargeInput[];
  paymentRef: string | null;
  period: string | null;
  description: string | null;
  note: string | null;
  refInvoice: { number: string | null; date: string } | null;
  lines: Array<{ description: string; serial: string | null; code: string | null; kpd: string | null; unit: string; qty: number; unitPrice: number; discountPct: number; netAmount: number }>;
}

const CATEGORY_LABEL: Record<string, string> = {
  S: 'Standardna stopa',
  K: 'Isporuka unutar EU',
  G: 'Izvoz',
  AE: 'Prijenos porezne obveze',
  E: 'Oslobođeno',
  Z: 'Nulta stopa',
  O: 'Izvan sustava PDV-a',
};

const time = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : null;

export function InvoiceDocument({ inv, company, party, currency = '€' }: { inv: InvoiceDocData; company: DocCompany; party: DocParty; currency?: string }) {
  const receivable = inv.kind === 'INVOICE' || inv.kind === 'ADVANCE';
  const linesNet = r2(inv.lines.reduce((a, l) => a + l.netAmount, 0));
  const discount = r2(linesNet - inv.netTotal);
  const sign = inv.netTotal < 0 ? -1 : 1;
  const charges = inv.charges.map((c) => {
    const def = CHARGE_KINDS[c.kind] ?? CHARGE_KINDS.N;
    const a = def.pct && c.pct ? (Math.abs(inv.netTotal) * c.pct) / 100 : Math.abs(c.amount ?? 0);
    return { label: c.label || def.label, amount: sign * r2(a) };
  });
  const hasCode = inv.lines.some((l) => l.code);
  const hasKpd = inv.lines.some((l) => l.kpd);
  const hasDisc = inv.lines.some((l) => l.discountPct);
  const payable = r2(inv.grandTotal - inv.advanceAmount);

  const head = ['#', ...(hasCode ? ['Šifra'] : []), 'Opis', ...(hasKpd ? ['KPD'] : []), 'Jed.', 'Kol.', 'Cijena', ...(hasDisc ? ['Pop. %'] : []), 'Iznos'];
  const align: Array<'left' | 'right'> = head.map((h) => (['Kol.', 'Cijena', 'Pop. %', 'Iznos'].includes(h) ? 'right' : 'left'));
  const rows = inv.lines.map((l, i) => [
    i + 1,
    ...(hasCode ? [l.code ?? ''] : []),
    <div key="d">
      {l.description}
      {l.serial && <div className="font-mono text-[10.5px] text-black/60">SN: {l.serial}</div>}
    </div>,
    ...(hasKpd ? [l.kpd ?? ''] : []),
    l.unit,
    decimal(l.qty),
    amount(l.unitPrice),
    ...(hasDisc ? [l.discountPct ? decimal(l.discountPct) : ''] : []),
    amount(l.netAmount),
  ]);

  const totals: Array<[string, React.ReactNode, boolean?]> = [];
  if (discount) totals.push(['Iznos stavki', amount(linesNet)], ['Popust', amount(-discount)]);
  totals.push(['Osnovica', amount(inv.netTotal)], [`PDV ${decimal(inv.vatRate)} %`, amount(inv.vatTotal)]);
  for (const c of charges) totals.push([c.label, amount(c.amount)]);
  totals.push([`Ukupno (${currency})`, amount(inv.grandTotal), true]);
  if (inv.advanceAmount) totals.push(['Uračunati predujam', amount(-inv.advanceAmount)], ['Za platiti', amount(payable), true]);

  const meta: Array<[string, React.ReactNode]> = [
    ['Datum izdavanja', formatDate(inv.date)],
    ...(time(inv.issuedAt) ? ([['Vrijeme izdavanja', time(inv.issuedAt)]] as Array<[string, React.ReactNode]>) : []),
    ['Datum isporuke', formatDate(inv.deliveryDate || inv.date)],
    ...(receivable && inv.dueDate ? ([['Dospijeće', formatDate(inv.dueDate)]] as Array<[string, React.ReactNode]>) : []),
    ...(inv.period ? ([['Razdoblje', inv.period]] as Array<[string, React.ReactNode]>) : []),
    ...(receivable ? ([['Način plaćanja', 'Transakcijski račun']] as Array<[string, React.ReactNode]>) : []),
  ];

  return (
    <DocumentShell
      company={company}
      title={inv.status === 'DRAFT' ? 'Nacrt računa' : INVOICE_KIND_LABEL[inv.kind]}
      number={inv.number}
      meta={meta}
      party={party}
      footer={
        <>
          {inv.issuedBy && <p>Račun izdao: {inv.issuedBy}</p>}
          <p>Dokument je izrađen elektronički i valjan je bez potpisa i pečata.</p>
        </>
      }
    >
      {inv.refInvoice && (
        <p className="mb-3">
          Odnosi se na račun br. <b>{inv.refInvoice.number}</b> od {formatDate(inv.refInvoice.date)}
        </p>
      )}
      {inv.description && <p className="mb-3 font-medium">{inv.description}</p>}
      <DocTable head={head} rows={rows} align={align} />
      <div className="mt-3 flex items-start justify-between gap-6">
        <table className="text-[11px]">
          <thead>
            <tr className="border-b border-black/30 text-left">
              <th className="pr-4 font-semibold">Porezna kategorija</th>
              <th className="pr-4 text-right font-semibold">Stopa</th>
              <th className="pr-4 text-right font-semibold">Osnovica</th>
              <th className="text-right font-semibold">PDV</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="pr-4">{CATEGORY_LABEL[inv.taxCategory] ?? inv.taxCategory}</td>
              <td className="pr-4 text-right">{decimal(inv.vatRate)} %</td>
              <td className="pr-4 text-right tnum">{amount(inv.netTotal)}</td>
              <td className="text-right tnum">{amount(inv.vatTotal)}</td>
            </tr>
          </tbody>
        </table>
        <DocTotals rows={totals} />
      </div>
      {inv.taxCategory !== 'S' && inv.taxExemptReason && <p className="mt-3 text-[11px]">{inv.taxExemptReason}</p>}
      {inv.note && <p className="mt-3 whitespace-pre-line">{inv.note}</p>}
      {receivable && inv.status === 'ISSUED' && (
        <section className="mt-5 flex items-end justify-between gap-6 rounded border border-black/15 p-3">
          <div className="text-[11.5px]">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-black/50">Podaci za plaćanje</p>
            <p>
              IBAN: <b>{company.iban ?? '—'}</b>
            </p>
            <p>
              Model i poziv na broj: <b>HR00 {inv.paymentRef}</b>
            </p>
            <p>
              Iznos: <b>{eur(inv.kind === 'ADVANCE' ? inv.grandTotal : payable)}</b>
            </p>
            {inv.paidTotal > 0 && inv.openAmount > 0 && <p>Preostalo za platiti: {eur(inv.openAmount)}</p>}
          </div>
          {inv.openAmount > 0 && company.iban && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/prodaja/racuni/${inv.id}/hub3`} alt="HUB-3 barkod za plaćanje" className="h-[26mm] w-auto" />
          )}
        </section>
      )}
    </DocumentShell>
  );
}

/** Priprema podataka za InvoiceDocument iz zapisa iz baze. */
export function toDocData(inv: {
  id: string;
  kind: InvoiceDocData['kind'];
  status: InvoiceDocData['status'];
  number: string | null;
  date: Date;
  dueDate: Date | null;
  deliveryDate: Date | null;
  issuedAt: Date | null;
  issuedBy: string | null;
  vatRate: unknown;
  taxCategory: string;
  taxExemptReason: string | null;
  netTotal: unknown;
  vatTotal: unknown;
  grandTotal: unknown;
  advanceAmount: unknown;
  paidTotal: unknown;
  openAmount: unknown;
  charges: unknown;
  paymentRef: string | null;
  period: string | null;
  description: string | null;
  note: string | null;
  refInvoice: { number: string | null; date: Date } | null;
  lines: Array<{
    description: string;
    unit: string;
    kpd: string | null;
    qty: unknown;
    unitPrice: unknown;
    discountPct: unknown;
    netAmount: unknown;
    item: { serial: string } | null;
    model: { code: string | null; kpd: string | null } | null;
    service: { kpd: string | null } | null;
  }>;
}): InvoiceDocData {
  const n = (v: unknown) => num(v as number);
  const d = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);
  return {
    id: inv.id,
    kind: inv.kind,
    status: inv.status,
    number: inv.number,
    date: d(inv.date)!,
    dueDate: d(inv.dueDate),
    deliveryDate: d(inv.deliveryDate),
    issuedAt: inv.issuedAt ? inv.issuedAt.toISOString() : null,
    issuedBy: inv.issuedBy,
    vatRate: n(inv.vatRate),
    taxCategory: inv.taxCategory,
    taxExemptReason: inv.taxExemptReason,
    netTotal: n(inv.netTotal),
    vatTotal: n(inv.vatTotal),
    grandTotal: n(inv.grandTotal),
    advanceAmount: n(inv.advanceAmount),
    paidTotal: n(inv.paidTotal),
    openAmount: n(inv.openAmount),
    charges: Array.isArray(inv.charges) ? (inv.charges as ChargeInput[]) : [],
    paymentRef: inv.paymentRef,
    period: inv.period,
    description: inv.description,
    note: inv.note,
    refInvoice: inv.refInvoice ? { number: inv.refInvoice.number, date: d(inv.refInvoice.date)! } : null,
    lines: inv.lines.map((l) => ({
      description: l.description,
      serial: l.item?.serial ?? null,
      code: l.model?.code ?? null,
      kpd: l.kpd ?? l.model?.kpd ?? l.service?.kpd ?? null,
      unit: l.unit,
      qty: n(l.qty),
      unitPrice: n(l.unitPrice),
      discountPct: n(l.discountPct),
      netAmount: n(l.netAmount),
    })),
  };
}
