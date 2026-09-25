import 'server-only';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { db } from '../db';
import { DomainError } from '../errors';
import { documentTotals, paymentReference } from '@/domain/invoice';
import { hub3Text } from '@/domain/hub3';
import { quoteDocTitle } from '@/domain/documents';
import { toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { hub3Png } from './barcode';
import { currencySign, loadPdfCompany, type LoadedCompany } from './company';
import { amt, box, documentDefinition, fmtDate, GREY, itemsTable, kv, pdfFileName, qty, sums, type SumRow } from './layout';

export async function loadQuote(companyId: string, id: string) {
  const q = await db.quote.findFirst({
    where: { id, companyId },
    include: {
      partner: true,
      lines: {
        orderBy: { sort: 'asc' },
        include: { item: { select: { serial: true } }, model: { select: { code: true } } },
      },
    },
  });
  if (!q) throw new DomainError('Ponuda ne postoji.');
  return q;
}
export type LoadedQuote = Awaited<ReturnType<typeof loadQuote>>;

/** Poziv na broj predračuna iz broja (PRED-2026-0005 → 5-2026); inače znamenke broja. */
export function proformaReference(number: string): string {
  const m = /(\d{4})-0*(\d+)$/.exec(number);
  if (m) return paymentReference(Number(m[2]), Number(m[1]));
  return number.replace(/\D+/g, '-').replace(/^-|-$/g, '').slice(0, 22);
}

export function quoteHub3(q: LoadedQuote, c: LoadedCompany, total: number): string | null {
  if (q.kind !== 'PROFORMA' || !c.iban || total <= 0) return null;
  return hub3Text({
    amount: total,
    currency: c.currency,
    payer: { name: q.partner.name, address: q.partner.address ?? '', zip: q.partner.zip ?? '', city: q.partner.city ?? '' },
    payee: { name: c.name, address: c.address ?? '', zip: c.zip ?? '', city: c.city ?? '' },
    iban: c.iban,
    model: c.paymentModel || 'HR00',
    reference: proformaReference(q.number),
    purpose: 'OTHR',
    description: `${quoteDocTitle(q, c)} ${q.number}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D'),
  });
}

/**
 * Stavke za ispis: isti uređaji (model, cijena) uvijek su jedan redak s količinom i serijskima
 * ispod (kao na računu); uz „bez serijskih brojeva" spajaju se i ostale iste stavke.
 */
function quoteRows(q: LoadedQuote) {
  const lines = q.lines.map((l) => ({
    description: l.description,
    serial: l.item?.serial ?? null,
    code: l.model?.code ?? null,
    unit: l.unit,
    rent: l.lineType === 'RENT',
    qty: num(l.qty),
    unitPrice: num(l.unitPrice),
    discountPct: num(l.discountPct),
  }));
  const rows: Array<(typeof lines)[number] & { serials: string[] }> = [];
  const idx = new Map<string, number>();
  for (const l of lines) {
    const key = q.hideSerials || l.serial ? [l.code ?? '', l.description, l.unitPrice, l.discountPct, l.unit, l.rent].join('|') : null;
    const i = key === null ? undefined : idx.get(key);
    if (i === undefined) {
      if (key !== null) idx.set(key, rows.length);
      rows.push({ ...l, serials: l.serial ? [l.serial] : [] });
    } else {
      rows[i].qty += l.qty;
      if (l.serial) rows[i].serials.push(l.serial);
    }
  }
  return { lines, rows };
}

/** Ponuda ili predračun (Quote.kind = PROFORMA: naslov iz postavki, podaci za plaćanje i HUB-3). */
export function quoteDefinition(q: LoadedQuote, c: LoadedCompany, hub3Img: string | null = null): TDocumentDefinitions {
  const cur = currencySign(c.currency);
  const proforma = q.kind === 'PROFORMA';
  const title = quoteDocTitle(q, c);
  const vatRate = num(q.vatRate);
  const { lines, rows } = quoteRows(q);
  const t = documentTotals({ lines, vatRate, discountPct: num(q.discountPct), discountAmount: num(q.discountAmount) });
  const hasCode = rows.some((l) => l.code);
  const hasDisc = rows.some((l) => l.discountPct);
  const hasRent = rows.some((l) => l.rent);
  const head = ['#', ...(hasCode ? ['Šifra'] : []), 'Opis', 'Jed.', 'Kol.', 'Cijena', ...(hasDisc ? ['Pop. %'] : []), 'Iznos'];
  const widths: Array<number | string> = [14, ...(hasCode ? [46] : []), '*', hasRent ? 44 : 28, 32, 56, ...(hasDisc ? [34] : []), 60];
  const right = head.map((h, i) => (['Kol.', 'Cijena', 'Pop. %', 'Iznos'].includes(h) ? i : -1)).filter((i) => i >= 0);
  const body = rows.map((l, i) => [
    { text: String(i + 1), color: GREY },
    ...(hasCode ? [{ text: l.code ?? '', fontSize: 7.5 }] : []),
    {
      stack: [
        { text: l.description },
        ...(l.rent ? [{ text: 'Najam — mjesečni iznos', fontSize: 7.5, color: GREY }] : []),
        ...(!q.hideSerials && l.serials.length ? [{ text: `SN: ${l.serials.join(', ')}`, fontSize: 7.5, color: GREY, margin: [0, 2, 0, 0] }] : []),
      ],
    },
    // najam: cijena je mjesečna — „kom/mj.", a jedinica „mj" ostaje „mj" (ne „mj/mj.")
    { text: l.rent && !/^mj/i.test(l.unit.trim()) ? `${l.unit}/mj.` : l.unit, noWrap: true },
    qty(l.qty),
    { text: amt(l.unitPrice), noWrap: true },
    ...(hasDisc ? [l.discountPct ? qty(l.discountPct) : ''] : []),
    { text: amt(r2(l.qty * l.unitPrice * (1 - l.discountPct / 100))), noWrap: true },
  ]) as TableCell[][];

  const totals: SumRow[] = [];
  if (t.discount) totals.push({ k: 'Iznos stavki', v: amt(t.linesNet) }, { k: 'Popust', v: amt(-t.discount) });
  totals.push({ k: 'Osnovica', v: amt(t.net) }, { k: `PDV ${qty(vatRate)} %`, v: amt(t.vat) }, { k: `Ukupno (${cur})`, v: amt(t.total), strong: true });

  const payment: Content | null =
    proforma && c.iban
      ? box(
          'Podaci za plaćanje',
          [
            { text: `IBAN ${c.iban}`, fontSize: 10.5, bold: true, margin: [0, 4, 0, 2] } as Content,
            ...(c.swift ? [kv('SWIFT / BIC', c.swift)] : []),
            kv('Model i poziv na broj', `${c.paymentModel || 'HR00'} ${proformaReference(q.number)}`),
            kv('Iznos', `${amt(t.total)} ${cur}`),
            kv('Primatelj', c.name, { bold: false }),
          ],
          hub3Img
            ? ({ stack: [{ image: hub3Img, width: 190 }, { text: '2D barkod za plaćanje — skenirajte u bankovnoj aplikaciji', fontSize: 6.5, color: GREY, margin: [0, 3, 0, 0] }] } as Content)
            : null,
        )
      : null;

  const validUntil = q.validUntil ? fmtDate(toISO(q.validUntil)) : null;
  return documentDefinition({
    company: c.doc,
    title,
    number: q.number,
    party: q.partner,
    issuerNote: q.createdBy ? `Izradio: ${q.createdBy}` : null,
    facts: [
      { k: proforma ? 'Datum' : 'Datum ponude', v: fmtDate(toISO(q.date)) },
      { k: 'Vrijedi do', v: validUntil ?? '—' },
      { k: 'Stavki', v: String(rows.length) },
      { k: 'PDV', v: `${qty(vatRate)} %` },
    ],
    body: [
      itemsTable({ widths, head, right, rows: body }),
      sums(totals, [
        validUntil ? `${title} vrijedi do ${validUntil}` : null,
        q.note,
        proforma ? `${title} nije račun i ne služi kao dokaz o isporuci — račun se izdaje nakon uplate.` : null,
      ]),
      payment,
    ],
    footer: proforma
      ? `${title} je poziv na plaćanje; račun se izdaje po uplati. Dokument je izrađen elektroničkim putem.`
      : 'Ponuda nije račun. Cijene su u eurima; PDV je iskazan zasebno.',
  });
}

export async function renderQuoteDefinition(companyId: string, id: string, expect: 'quote' | 'proforma' | null = null) {
  const [q, c] = await Promise.all([loadQuote(companyId, id), loadPdfCompany(companyId)]);
  if (expect === 'proforma' && q.kind !== 'PROFORMA') throw new DomainError('Predračun ne postoji.');
  const total = documentTotals({
    lines: q.lines.map((l) => ({ qty: num(l.qty), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) })),
    vatRate: num(q.vatRate),
    discountPct: num(q.discountPct),
    discountAmount: num(q.discountAmount),
  }).total;
  const hub3 = quoteHub3(q, c, total);
  const img = hub3 ? await hub3Png(hub3) : null;
  return { def: quoteDefinition(q, c, img), fileName: pdfFileName(q.kind === 'PROFORMA' ? 'Predracun' : 'Ponuda', q.number, q.id) };
}
