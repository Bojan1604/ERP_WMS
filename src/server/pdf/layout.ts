import 'server-only';
import type { Content, ContentColumns, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';

/**
 * Zajednički kostur PDF dokumenata (račun, ponuda, predračun, otpremnica,
 * servisni nalog, narudžbenica, primka, popis uređaja) — isti izgled kao
 * ispis A4 u aplikaciji: logo ili naziv i naslov s brojem, blokovi stranke i
 * izdavatelja, traka s podacima, tablica stavki, zbrojevi u okviru, napomene,
 * potpisne crte i podnožje s pravnim podacima firme na svakoj stranici.
 */

export const GREY = '#8a8a8e';
export const LINE = '#d8d8dc';
export const DARK = '#1c1c1e';
export const LIGHT = '#f4f4f6';

const money = new Intl.NumberFormat('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dec = new Intl.NumberFormat('hr-HR', { maximumFractionDigits: 3 });
/** 1234.5 → „1.234,50" */
export const amt = (v: number) => money.format(v);
/** Količina / postotak bez suvišnih decimala. */
export const qty = (v: number) => dec.format(v);
/** YYYY-MM-DD (ili Date) → „10.03.2026." */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '';
  const s = typeof d === 'string' ? d : d.toISOString();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}.` : s;
}

let regionNames: Intl.DisplayNames | null = null;
/** Službeni naziv države na hrvatskom (HR → Hrvatska). */
export function countryName(code: string | null | undefined): string {
  const c = (code || 'HR').toUpperCase();
  try {
    regionNames ??= new Intl.DisplayNames(['hr'], { type: 'region' });
    return regionNames.of(c) ?? c;
  } catch {
    return c;
  }
}

/** Firma izdavatelja kako je treba dokument. */
export interface PdfCompany {
  name: string;
  oib?: string | null;
  vatId?: string | null;
  vatRegistered?: boolean;
  address?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  iban?: string | null;
  bank?: string | null;
  swift?: string | null;
  email?: string | null;
  phone?: string | null;
  web?: string | null;
  logo?: string | null;
  invoiceFooter?: string | null;
  legalFooter?: string | null;
}

export interface PdfParty {
  name: string;
  oib?: string | null;
  vatId?: string | null;
  address?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
  email?: string | null;
  branchCode?: string | null;
  branchName?: string | null;
}

/** Stavka trake podataka (k = naziv, v = vrijednost); null se preskače. */
export type Fact = { k: string; v: string } | null | false | undefined;
/** Redak zbrojeva; `strong` = tamni zadnji redak. */
export type SumRow = { k: string; v: string; strong?: boolean } | null | false | undefined;

const lbl = (t: string): Content => ({ text: t.toUpperCase(), fontSize: 7, color: GREY, characterSpacing: 0.4 });
const row = (t: string, o: Record<string, unknown> = {}): Content => ({ text: t, fontSize: 8.5, lineHeight: 1.1, color: '#3a3a3c', ...o }) as Content;
const compact = <T>(a: Array<T | null | false | undefined | ''>): T[] => a.filter(Boolean) as T[];

/**
 * Slika logotipa za pdfmake: PNG/JPEG kao data URL, SVG kao tekst. Ostali
 * formati (WebP, GIF) pdfmake ne podržava — tada se ispisuje naziv firme.
 */
export function logoNode(logo: string | null | undefined, fit: [number, number] = [150, 48]): Content | null {
  if (!logo) return null;
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(logo.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/jpg') return { image: logo, fit } as Content;
  if (mime === 'image/svg+xml') {
    const svg = m[2] ? Buffer.from(m[3], 'base64').toString('utf8') : decodeURIComponent(m[3]);
    if (!/<svg[\s>]/i.test(svg)) return null;
    return { svg, fit } as Content;
  }
  return null;
}

function header(company: PdfCompany, title: string, number: string | null | undefined): Content[] {
  const logo = logoNode(company.logo);
  return [
    {
      columns: [
        logo ? { width: 'auto', stack: [logo] } : { width: 'auto', text: company.name, fontSize: 15, bold: true },
        {
          width: '*',
          alignment: 'right',
          stack: [
            { text: title.toUpperCase(), fontSize: 14, bold: true, characterSpacing: 1.2 },
            ...(number ? [{ text: `br. ${number}`, fontSize: 11, bold: true, color: '#3a3a3c', margin: [0, 1, 0, 0] }] : []),
          ],
        },
      ],
      columnGap: 20,
    } as ContentColumns,
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: 1.2, lineColor: DARK }], margin: [0, 8, 0, 0] },
  ];
}

function parties(party: PdfParty | null, company: PdfCompany, partyLabel: string, extra: string | null): Content {
  const own = (company.country || 'HR').toUpperCase();
  const left: Content[] = party
    ? compact<Content>([
        lbl(partyLabel),
        { text: party.name || '—', fontSize: 10.5, bold: true, margin: [0, 1, 0, 2] },
        party.address ? row(party.address) : null,
        party.zip || party.city ? row([party.zip, party.city].filter(Boolean).join(' ')) : null,
        row(countryName(party.country)),
        party.branchCode ? row(`${party.branchName || 'Poslovna jedinica'} (${party.branchCode})`) : null,
        party.oib ? row(`OIB ${party.oib}`) : null,
        party.vatId && (party.country ?? 'HR').toUpperCase() !== 'HR' ? row(`PDV ID ${party.vatId}`) : null,
        party.email ? row(party.email) : null,
      ])
    : [];
  const vatId = company.vatRegistered === false ? null : company.vatId || (company.oib && own === 'HR' ? `HR${company.oib}` : null);
  const right = compact<Content>([
    lbl('Izdavatelj'),
    { text: company.name, fontSize: 10.5, bold: true, margin: [0, 1, 0, 2] },
    company.address ? row(company.address) : null,
    company.zip || company.city ? row([company.zip, company.city].filter(Boolean).join(' ')) : null,
    row(countryName(company.country)),
    company.oib ? row(`OIB ${company.oib}`) : null,
    vatId ? row(`PDV ID ${vatId}`) : company.vatRegistered === false ? row('Nije u sustavu PDV-a') : null,
    company.iban ? row(`IBAN ${company.iban}${company.bank ? ` (${company.bank})` : ''}`) : null,
    company.swift ? row(`SWIFT/BIC ${company.swift}`) : null,
    [company.email, company.phone, company.web].some(Boolean) ? row([company.email, company.phone, company.web].filter(Boolean).join(' · ')) : null,
    extra ? row(extra, { color: GREY, margin: [0, 3, 0, 0] }) : null,
  ]);
  return {
    margin: [0, 10, 0, 0],
    columns: [
      { width: '*', stack: left },
      { width: '*', alignment: 'right', stack: right },
    ],
    columnGap: 30,
  } as ContentColumns;
}

function factsBar(facts: Fact[]): Content | null {
  const f = compact<{ k: string; v: string }>(facts);
  if (!f.length) return null;
  return {
    margin: [0, 10, 0, 0],
    table: {
      widths: f.map(() => '*'),
      body: [f.map((x) => ({ stack: [lbl(x.k), { text: x.v, fontSize: 9, bold: true, margin: [0, 1, 0, 0] }], fillColor: LIGHT, margin: [0, 4, 0, 4] }))],
    },
    layout: { defaultBorder: false, paddingLeft: () => 7, paddingRight: () => 5, paddingTop: () => 0, paddingBottom: () => 0 },
  } as Content;
}

export interface TableSpec {
  widths: Array<number | string>;
  head: string[];
  /** Stupci poravnati desno (brojevi). */
  right?: number[];
  rows: TableCell[][];
}

/** Tablica stavki s tamnim zaglavljem (ponavlja se na svakoj stranici) i naizmjeničnim recima. */
export function itemsTable(t: TableSpec): Content {
  const right = new Set(t.right ?? []);
  return {
    margin: [0, 10, 0, 0],
    table: {
      headerRows: 1,
      widths: t.widths,
      dontBreakRows: true,
      body: [
        t.head.map((h, i) => ({ text: h, fontSize: 7.5, bold: true, color: '#fff', fillColor: DARK, alignment: right.has(i) ? 'right' : 'left', margin: [0, 1, 0, 1] })),
        ...t.rows.map((r, ri) =>
          r.map((cell, ci) => {
            const o = (typeof cell === 'object' && cell !== null && !Array.isArray(cell) ? cell : { text: String(cell ?? '') }) as Record<string, unknown>;
            return { fontSize: 8.5, ...o, fillColor: (o.fillColor as string | undefined) ?? (ri % 2 ? LIGHT : undefined), alignment: (o.alignment as string | undefined) ?? (right.has(ci) ? 'right' : 'left') };
          }),
        ),
      ],
    },
    layout: {
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 0 || i === node.table.body.length ? 0.6 : 0),
      vLineWidth: () => 0,
      hLineColor: () => LINE,
      paddingTop: () => 2.5,
      paddingBottom: () => 2.5,
      paddingLeft: (i: number) => (i === 0 ? 4 : 5),
      paddingRight: () => 5,
    },
  } as unknown as Content;
}

/** Napomene (i dodatni blokovi, npr. porezna tablica i fiskalizacija) lijevo, zbrojevi u okviru desno. */
export function sums(rows: SumRow[], notes: Array<string | null | undefined | false> = [], extra: Array<Content | null | undefined | false> = []): Content | null {
  const r = compact<{ k: string; v: string; strong?: boolean }>(rows);
  const n = compact<string>(notes);
  const x = compact<Content>(extra);
  if (!r.length && !n.length && !x.length) return null;
  return {
    margin: [0, 8, 0, 0],
    columns: [
      { width: '*', stack: [...n.map((t, i) => ({ text: t, fontSize: 8, color: '#555', margin: [0, i ? 3 : 2, 16, 0] }) as Content), ...x] },
      r.length
        ? {
            width: 220,
            table: {
              widths: ['*', 'auto'],
              body: r.map((x) => [
                { text: x.k, fontSize: x.strong ? 10 : 8.5, bold: !!x.strong, color: x.strong ? '#fff' : '#3a3a3c', fillColor: x.strong ? DARK : LIGHT },
                { text: x.v, fontSize: x.strong ? 11 : 8.5, bold: !!x.strong, color: x.strong ? '#fff' : '#111', alignment: 'right', fillColor: x.strong ? DARK : LIGHT, noWrap: true },
              ]),
            },
            layout: { defaultBorder: false, paddingLeft: () => 9, paddingRight: () => 9, paddingTop: () => 3, paddingBottom: () => 3 },
          }
        : { width: 0, text: '' },
    ],
    columnGap: 14,
  } as ContentColumns;
}

/** Okvir s naslovom (podaci za plaćanje, fiskalizacija, opis kvara…) i neobaveznom slikom desno. */
export function box(title: string, lines: Content[], side?: Content | null, margin: [number, number, number, number] = [0, 10, 0, 0]): Content {
  return {
    margin,
    unbreakable: true,
    table: {
      widths: side ? ['*', 'auto'] : ['*'],
      body: [[{ stack: [lbl(title), ...lines], margin: [2, 2, 2, 2] }, ...(side ? [{ stack: [side], margin: [2, 2, 2, 2] }] : [])]],
    },
    layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => LINE, vLineColor: () => LINE, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 4, paddingBottom: () => 4 },
  } as unknown as Content;
}

/** Redak „Naziv: vrijednost" (naziv sivo, vrijednost podebljano). */
export const kv = (k: string, v: string, o: Record<string, unknown> = {}): Content => ({ text: [{ text: `${k}: `, color: GREY }, { text: v, bold: true }], fontSize: 9, margin: [0, 2, 0, 0], ...o }) as Content;

/** Odlomak s naslovom (opis kvara, dijagnoza…); prazno se preskače. */
export function section(title: string, text: string | null | undefined): Content | null {
  if (!text?.trim()) return null;
  return { margin: [0, 10, 0, 0], stack: [lbl(title), { text, fontSize: 9, margin: [0, 2, 0, 0] }] } as Content;
}

function signatures(labels: string[]): Content {
  const line = (t: string) => ({
    width: 200,
    stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.5, lineColor: GREY }] }, { text: t, fontSize: 8, color: GREY, margin: [0, 4, 0, 0], alignment: 'center' }],
  });
  return { margin: [0, 30, 0, 0], unbreakable: true, columns: [line(labels[0] ?? ''), { width: '*', text: '' }, labels[1] ? line(labels[1]) : { width: 200, text: '' }] } as ContentColumns;
}

export interface DocShell {
  company: PdfCompany;
  title: string;
  number?: string | null;
  /** Naziv i predmet PDF-a (metapodaci). */
  docTitle?: string;
  party?: PdfParty | null;
  partyLabel?: string;
  /** Redak ispod izdavatelja (npr. „Izradio: Ana"). */
  issuerNote?: string | null;
  facts?: Fact[];
  body: Array<Content | null | undefined | false>;
  signatures?: string[] | null;
  /** Napomena dokumenta u podnožju svake stranice (uz podnožje firme i pravne podatke). */
  footer?: string | null;
}

/** Cijeli dokument — pdfmake definicija. */
export function documentDefinition(d: DocShell): TDocumentDefinitions {
  const footLines = compact<string>([d.footer, d.company.invoiceFooter?.trim(), d.company.legalFooter?.trim()]);
  return {
    pageSize: 'A4',
    pageMargins: [36, 30, 36, 24 + footLines.length * 10 + 10],
    info: { title: d.docTitle ?? [d.title, d.number].filter(Boolean).join(' '), author: d.company.name, subject: d.title },
    footer: (page: number, pages: number) => ({
      margin: [36, 2, 36, 0],
      stack: compact<Content>([
        ...footLines.map((t, i) => ({ text: t, fontSize: i === footLines.length - 1 && d.company.legalFooter ? 6.8 : 7.2, color: GREY, alignment: 'center', margin: [0, i ? 2 : 0, 0, 0] }) as Content),
        pages > 1 ? ({ text: `${page} / ${pages}`, fontSize: 7, color: GREY, alignment: 'right', margin: [0, 2, 0, 0] } as Content) : null,
      ]),
    }),
    content: compact<Content>([
      ...header(d.company, d.title, d.number),
      parties(d.party ?? null, d.company, d.partyLabel ?? 'Kupac', d.issuerNote ?? null),
      factsBar(d.facts ?? []),
      ...d.body.filter(Boolean),
      d.signatures?.length ? signatures(d.signatures) : null,
    ] as Array<Content | null>),
  };
}

/** Siguran naziv datoteke iz vrste i broja dokumenta („Racun-12-PP1-1.pdf"). */
export function pdfFileName(prefix: string, number: string | null | undefined, fallback: string): string {
  const n = String(number || fallback).replace(/[\\/]+/g, '-').replace(/[^\w.-]+/g, '_').slice(0, 80);
  return `${prefix}-${n}.pdf`;
}
