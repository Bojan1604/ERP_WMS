import 'server-only';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { db } from '../db';
import { DomainError } from '../errors';
import { readMeta } from '../fiscal/issue';
import { CHARGE_KINDS, groupLines, INVOICE_KIND_LABEL, type ChargeInput } from '@/domain/invoice';
import { PAYMENT_METHOD_LABEL, fiscalQrUrl } from '@/domain/fiscal';
import { hub3Text } from '@/domain/hub3';
import { warrantyEnd } from '@/domain/pricing';
import { toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { taxNotes, VAT_ON_PAYMENT_NOTE } from '@/domain/tax';
import { invoiceRentMonths, rentLineView, rentPeriodRange } from '@/domain/sales-lines';
import { hub3Png, qrPng } from './barcode';
import { currencySign, loadPdfCompany, type LoadedCompany } from './company';
import { amt, box, documentDefinition, fmtDate, GREY, itemsTable, kv, pdfFileName, qty, sums, type Fact, type SumRow } from './layout';

const CATEGORY_LABEL: Record<string, string> = {
  S: 'Standardna stopa',
  K: 'Isporuka unutar EU',
  G: 'Izvoz',
  AE: 'Prijenos porezne obveze',
  E: 'Oslobođeno',
  Z: 'Nulta stopa',
  O: 'Izvan sustava PDV-a',
};

const hhmm = (d: Date | null) =>
  d ? new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', hour: '2-digit', minute: '2-digit' }).format(d) : null;
const fullTime = (d: Date) =>
  new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);

/** Račun sa svime što ispis treba (isti podaci kao stranica računa). */
export async function loadInvoice(companyId: string, id: string) {
  const inv = await db.invoice.findFirst({
    where: { id, companyId },
    include: {
      partner: true,
      lines: {
        orderBy: { sort: 'asc' },
        include: {
          item: { select: { serial: true, warrantyMonths: true, warrantyStart: true } },
          model: { select: { code: true } },
        },
      },
      refInvoice: { select: { number: true, date: true } },
      advanceUses: { orderBy: { createdAt: 'asc' }, select: { amount: true, advance: { select: { number: true, date: true } } } },
    },
  });
  if (!inv) throw new DomainError('Račun ne postoji.');
  return inv;
}
export type LoadedInvoice = Awaited<ReturnType<typeof loadInvoice>>;

export interface InvoiceImages {
  hub3?: string | null;
  qr?: string | null;
}

/** Tekst HUB-3 barkoda za otvoreni iznos računa (null kad se ne ispisuje). */
export function invoiceHub3(inv: LoadedInvoice, c: LoadedCompany): string | null {
  const receivable = inv.kind === 'INVOICE' || inv.kind === 'ADVANCE';
  if (!receivable || inv.status !== 'ISSUED' || inv.paymentMethod !== 'TRANSFER' || !c.iban || num(inv.openAmount) <= 0) return null;
  return hub3Text({
    amount: num(inv.openAmount),
    currency: c.currency,
    payer: { name: inv.partner.name, address: inv.partner.address ?? '', zip: inv.partner.zip ?? '', city: inv.partner.city ?? '' },
    payee: { name: c.name, address: c.address ?? '', zip: c.zip ?? '', city: c.city ?? '' },
    iban: c.iban,
    model: c.paymentModel || 'HR00',
    reference: inv.paymentRef ?? '',
    purpose: 'OTHR',
    description: `Racun ${inv.number ?? ''}`,
  });
}

export function invoiceQrUrl(inv: LoadedInvoice): string | null {
  if (inv.status !== 'ISSUED' || !inv.zki || !inv.issuedAt) return null;
  return fiscalQrUrl({ jir: inv.jir, zki: inv.zki, issuedAt: inv.issuedAt, total: num(inv.grandTotal) });
}

const party = (p: LoadedInvoice['partner']) => ({
  name: p.name,
  oib: p.oib,
  vatId: p.vatId,
  address: p.address,
  zip: p.zip,
  city: p.city,
  country: p.country,
  branchCode: p.branchCode,
  branchName: p.branchName,
});

/** Razdoblje koje račun za najam pokriva (od–do prema broju mjeseci naplate na stavkama). */
export const invoiceRentRange = (inv: Pick<LoadedInvoice, 'period' | 'lines'>) => rentPeriodRange(inv.period, invoiceRentMonths(inv.lines));

/** Stavke računa: uređaji istog modela i cijene spojeni u jednu stavku (kao ispis i eRačun). */
export function invoiceRows(inv: LoadedInvoice) {
  // stavke najma: opis s razdobljem rate, jedinica „kom" (količina = uređaji), napomena mjesečni iznos
  const range = invoiceRentRange(inv);
  return groupLines(
    inv.lines.map((l) => {
      const rv = rentLineView({ description: l.description, unit: l.unit, monthly: l.monthly === null ? null : num(l.monthly), months: l.months }, range);
      return {
        description: rv.description,
        note: rv.note,
        serial: l.item?.serial ?? null,
        code: l.model?.code ?? null,
        // ispis = KPD na stavci (isti kao stranica računa i XML eRačuna) — bez zamjene KPD-om prodaje s modela
        kpd: l.kpd || null,
        unit: rv.unit,
        qty: num(l.qty),
        unitPrice: num(l.unitPrice),
        discountPct: num(l.discountPct),
        netAmount: num(l.netAmount),
      };
    }),
    (l) => (l.serial ? [l.description, l.code ?? '', l.kpd ?? '', l.unit, l.unitPrice, l.discountPct].join('|') : null),
  ).map(({ lines: g }) => ({
    ...g[0],
    serials: g.flatMap((x) => (x.serial ? [x.serial] : [])),
    qty: g.reduce((a, x) => a + x.qty, 0),
    netAmount: r2(g.reduce((a, x) => a + x.netAmount, 0)),
  }));
}

/** Redak „SN: …" ispod opisa — samo serijski koji već nisu u opisu (npr. stavka najma „…, SN X — mjesečno"). */
function serialNote(description: string, serials: string[]): Content[] {
  const rest = serials.filter((sn) => !description.includes(sn));
  return rest.length ? [{ text: `SN: ${rest.join(', ')}`, fontSize: 7.5, color: GREY, margin: [0, 1, 0, 0] } as Content] : [];
}

/** pdfmake definicija računa (sve vrste: račun, predujam, storno, odobrenje, nacrt). */
export function invoiceDefinition(inv: LoadedInvoice, c: LoadedCompany, img: InvoiceImages = {}): TDocumentDefinitions {
  const cur = currencySign(c.currency);
  const receivable = inv.kind === 'INVOICE' || inv.kind === 'ADVANCE';
  // postavke firme u trenutku izdavanja (preslika na računu); nacrt i stariji računi — trenutne
  const vatRegistered = inv.sellerVatRegistered ?? c.vatRegistered;
  const meta = readMeta(inv.eInvoice);
  const operator = meta.operator?.name ? meta.operator : inv.issuedBy ? { name: inv.issuedBy, oib: null } : null;
  const netTotal = num(inv.netTotal);
  const grand = num(inv.grandTotal);
  const advance = num(inv.advanceAmount);
  const open = num(inv.openAmount);
  const paid = num(inv.paidTotal);
  const vatRate = num(inv.vatRate);
  const rows = invoiceRows(inv);
  const linesNet = r2(rows.reduce((a, l) => a + l.netAmount, 0));
  const discount = r2(linesNet - netTotal);
  const sign = netTotal < 0 ? -1 : 1;
  const charges = (Array.isArray(inv.charges) ? (inv.charges as unknown as ChargeInput[]) : []).map((ch) => {
    const def = CHARGE_KINDS[ch.kind] ?? CHARGE_KINDS.N;
    const a = def.pct && ch.pct ? (Math.abs(netTotal) * ch.pct) / 100 : Math.abs(ch.amount ?? 0);
    return { label: ch.label || def.label, amount: sign * r2(a) };
  });
  const payable = r2(grand - advance);
  const hasCode = rows.some((l) => l.code);
  const hasKpd = rows.some((l) => l.kpd);
  const hasDisc = rows.some((l) => l.discountPct);

  const head = ['#', ...(hasCode ? ['Šifra'] : []), 'Naziv robe / usluge', ...(hasKpd ? ['KPD'] : []), 'Jed.', 'Kol.', 'Cijena', ...(hasDisc ? ['Pop. %'] : []), 'Iznos'];
  const widths: Array<number | string> = [14, ...(hasCode ? [46] : []), '*', ...(hasKpd ? [44] : []), 28, 32, 56, ...(hasDisc ? [34] : []), 60];
  const right = head.map((h, i) => (['Kol.', 'Cijena', 'Pop. %', 'Iznos'].includes(h) ? i : -1)).filter((i) => i >= 0);
  const body: TableCell[][] = rows.map((l, i) => [
    { text: String(i + 1), color: GREY },
    ...(hasCode ? [{ text: l.code ?? '', fontSize: 7.5 }] : []),
    { stack: [{ text: l.description }, ...(l.note ? [{ text: l.note, fontSize: 7.5, color: GREY }] : []), ...serialNote(l.description, l.serials)] },
    ...(hasKpd ? [{ text: l.kpd ?? '', fontSize: 7.5 }] : []),
    { text: l.unit, noWrap: true },
    qty(l.qty),
    { text: amt(l.unitPrice), noWrap: true },
    ...(hasDisc ? [l.discountPct ? qty(l.discountPct) : ''] : []),
    { text: amt(l.netAmount), noWrap: true },
  ] as TableCell[]);

  const totals: SumRow[] = [];
  if (discount) totals.push({ k: 'Iznos stavki', v: amt(linesNet) }, { k: 'Popust', v: amt(-discount) });
  totals.push({ k: 'Osnovica', v: amt(netTotal) }, { k: `PDV ${qty(vatRate)} %`, v: amt(num(inv.vatTotal)) });
  for (const ch of charges) totals.push({ k: ch.label, v: amt(ch.amount) });
  totals.push({ k: `Ukupno (${cur})`, v: amt(grand), strong: !advance });
  if (advance) {
    // uračunati predujam s brojem i datumom računa za predujam (stariji računi: samo iznos)
    if (inv.advanceUses.length) for (const u of inv.advanceUses) totals.push({ k: `Uračunati predujam ${u.advance.number ?? ''} (${fmtDate(toISO(u.advance.date))})`, v: amt(-num(u.amount)) });
    else totals.push({ k: 'Uračunati predujam', v: amt(-advance) });
    totals.push({ k: 'Za platiti', v: amt(payable), strong: true });
  }

  const paidInFull = receivable && inv.status === 'ISSUED' && paid > 0 && open <= 0;
  const notes = [
    ...taxNotes(inv, vatRegistered),
    (inv.vatOnPayment ?? c.vatOnPayment) ? VAT_ON_PAYMENT_NOTE : null,
    // datum već završava točkom („25.09.2026.") — bez dvostruke točke
    paidInFull ? (inv.paidDate ? `Račun je plaćen u cijelosti ${fmtDate(toISO(inv.paidDate))}` : 'Račun je plaćen u cijelosti.') : null,
    inv.note,
  ];

  const facts: Fact[] = [
    { k: 'Datum izdavanja', v: fmtDate(toISO(inv.date)) + (hhmm(inv.issuedAt) ? ` ${hhmm(inv.issuedAt)}` : '') },
    { k: 'Datum isporuke', v: fmtDate(toISO(inv.deliveryDate ?? inv.date)) },
    receivable && inv.dueDate ? { k: 'Dospijeće', v: fmtDate(toISO(inv.dueDate)) } : null,
    inv.period ? { k: 'Razdoblje', v: invoiceRentRange(inv)?.label ?? inv.period } : null,
    receivable || inv.paymentMethod !== 'TRANSFER' ? { k: 'Način plaćanja', v: PAYMENT_METHOD_LABEL[inv.paymentMethod] } : null,
  ];

  const taxTable: Content = {
    margin: [0, 6, 16, 0],
    table: {
      widths: ['auto', 'auto', 'auto', 'auto'],
      body: [
        ['Porezna kategorija', 'Stopa', 'Osnovica', 'PDV'].map((h, i) => ({ text: h, bold: true, fontSize: 7.5, alignment: i ? 'right' : 'left' })),
        [
          { text: CATEGORY_LABEL[inv.taxCategory] ?? inv.taxCategory, fontSize: 8 },
          { text: `${qty(vatRate)} %`, fontSize: 8, alignment: 'right' },
          { text: amt(netTotal), fontSize: 8, alignment: 'right' },
          { text: amt(num(inv.vatTotal)), fontSize: 8, alignment: 'right' },
        ],
      ],
    },
    layout: { hLineWidth: (i: number) => (i === 1 ? 0.6 : 0), vLineWidth: () => 0, hLineColor: () => '#999', paddingLeft: (i: number) => (i ? 10 : 0), paddingRight: () => 0, paddingTop: () => 2, paddingBottom: () => 2 },
  } as Content;

  // fiskalizacija i porezna tablica stoje lijevo od zbrojeva (kompaktno: račun do ~14 stavki na jednoj stranici)
  const fiscal: Content | null =
    inv.status === 'ISSUED' && inv.zki
      ? box(
          'Fiskalizacija',
          [
            kv('ZKI', inv.zki, { fontSize: 7.5, margin: [0, 1, 0, 0] }),
            kv('JIR', inv.jir ?? 'naknadna dostava', { fontSize: 7.5, margin: [0, 1, 0, 0] }),
            ...(inv.issuedAt ? [kv('Vrijeme izdavanja', fullTime(inv.issuedAt), { fontSize: 7.5, margin: [0, 1, 0, 0] })] : []),
          ],
          img.qr ? ({ image: img.qr, width: 52 } as Content) : null,
          [0, 6, 16, 0],
        )
      : null;

  const payment: Content | null =
    receivable && inv.status === 'ISSUED' && inv.paymentMethod === 'TRANSFER' && !paidInFull
      ? box(
          'Podaci za plaćanje',
          [
            { text: `IBAN ${c.iban ?? '—'}`, fontSize: 10, bold: true, margin: [0, 2, 0, 1] } as Content,
            ...(c.swift ? [kv('SWIFT / BIC', c.swift)] : []),
            kv('Model i poziv na broj', `${c.paymentModel || 'HR00'} ${inv.paymentRef ?? ''}`.trim()),
            kv('Iznos', `${amt(inv.kind === 'ADVANCE' ? grand : payable)} ${cur}`),
            ...(paid > 0 && open > 0 ? [kv('Preostalo za platiti', `${amt(open)} ${cur}`)] : []),
            kv('Primatelj', c.name, { bold: false }),
          ],
          img.hub3
            ? ({ stack: [{ image: img.hub3, width: 170 }, { text: '2D barkod za plaćanje — skenirajte u bankovnoj aplikaciji', fontSize: 6.5, color: GREY, margin: [0, 2, 0, 0] }] } as Content)
            : null,
        )
      : null;

  return documentDefinition({
    company: { ...c.doc, vatRegistered },
    title: inv.status === 'DRAFT' ? 'Nacrt računa' : INVOICE_KIND_LABEL[inv.kind],
    number: inv.number,
    party: party(inv.partner),
    partyLabel: 'Kupac',
    issuerNote: operator ? `Račun izdao: ${operator.name}${operator.oib ? ` (OIB operatera ${operator.oib})` : ''}` : null,
    facts,
    body: [
      inv.refInvoice ? { text: [`Odnosi se na račun br. `, { text: inv.refInvoice.number ?? '', bold: true }, ` od ${fmtDate(toISO(inv.refInvoice.date))}`], margin: [0, 10, 0, 0] } : null,
      inv.description ? { text: inv.description, bold: true, margin: [0, 10, 0, 0] } : null,
      itemsTable({ widths, head, right, rows: body }),
      sums(totals, notes, [taxTable, fiscal]),
      payment,
    ],
    footer: 'Dokument je izrađen elektronički i valjan je bez potpisa i pečata.',
  });
}

export async function renderInvoiceDefinition(companyId: string, id: string) {
  const [inv, c] = await Promise.all([loadInvoice(companyId, id), loadPdfCompany(companyId)]);
  const hub3 = invoiceHub3(inv, c);
  const qrUrl = invoiceQrUrl(inv);
  const [hub3Img, qrImg] = await Promise.all([hub3 ? hub3Png(hub3) : null, qrUrl ? qrPng(qrUrl) : null]);
  return {
    def: invoiceDefinition(inv, c, { hub3: hub3Img, qr: qrImg }),
    fileName: pdfFileName(inv.kind === 'STORNO' ? 'Storno' : inv.kind === 'CREDIT_NOTE' ? 'Odobrenje' : inv.kind === 'ADVANCE' ? 'Predujam' : 'Racun', inv.number, inv.status === 'DRAFT' ? `nacrt-${inv.id}` : inv.id),
  };
}

/** Otpremnica uz račun: uređaji, modeli i ručne stavke (bez usluga), jamstvo po uređaju, potpisi. */
export function deliveryDefinition(inv: LoadedInvoice, c: LoadedCompany): TDocumentDefinitions {
  const lines = inv.lines.filter((l) => l.kind !== 'SERVICE');
  const start = inv.lines.find((l) => l.item?.warrantyStart)?.item?.warrantyStart;
  const from = toISO(start ?? inv.date);
  const devices = lines.filter((l) => l.item).length;
  return documentDefinition({
    company: c.doc,
    title: 'Otpremnica',
    number: inv.number,
    party: party(inv.partner),
    partyLabel: 'Primatelj',
    issuerNote: inv.issuedBy ? `Izdao: ${inv.issuedBy}` : null,
    facts: [
      { k: 'Datum', v: fmtDate(toISO(inv.deliveryDate ?? inv.date)) },
      { k: 'Uz račun', v: inv.number ?? '—' },
      { k: 'Stavki', v: String(lines.length) },
      devices ? { k: 'Uređaja', v: String(devices) } : null,
    ],
    body: [
      itemsTable({
        widths: [14, '*', 110, 32, 30, 100],
        head: ['#', 'Opis', 'Serijski broj', 'Kol.', 'Jed.', 'Jamstvo'],
        right: [3],
        rows: lines.map((l, i) => {
          const months = l.kind === 'DEVICE' ? (l.warrantyMonths ?? l.item?.warrantyMonths ?? c.defaultWarrantyMonths) : null;
          const end = months ? warrantyEnd(from, months) : null;
          return [
            { text: String(i + 1), color: GREY },
            l.description,
            l.item ? { text: l.item.serial, bold: true } : '—',
            qty(Math.abs(num(l.qty))),
            l.unit,
            { text: months ? `${months} mj · do ${fmtDate(end)}` : '—', fontSize: 8 },
          ] as TableCell[];
        }),
      }),
      sums([], [inv.description]),
    ],
    signatures: ['Robu izdao', 'Robu primio (ime, prezime, potpis)'],
    footer: 'Jamstvo teče od datuma računa uz predočenje ovog dokumenta i računa.',
  });
}

export async function renderDeliveryDefinition(companyId: string, id: string) {
  const [inv, c] = await Promise.all([loadInvoice(companyId, id), loadPdfCompany(companyId)]);
  return { def: deliveryDefinition(inv, c), fileName: pdfFileName('Otpremnica', inv.number, inv.id) };
}
