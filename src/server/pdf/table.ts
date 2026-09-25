import 'server-only';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ExportColumn, ExportColumnType } from '@/lib/csv';
import { inferColumnType } from '@/lib/csv';
import { renderPdf } from './engine';

/**
 * Generički PDF popisa („tablica u PDF"): naslov, podnaslov, tablica s
 * ponavljanjem zaglavlja na svakoj stranici, brojevi stranica. Isti opis
 * stupaca kao CSV/Excel izvoz (`ExportColumn`), pa svaki popis s izvozom
 * dobiva PDF bez dupliciranja.
 */
export interface TablePdfInput<T> {
  title: string;
  subtitle?: string;
  columns: ExportColumn<T>[];
  rows: T[];
  /** Redak zbroja na dnu (vrijednosti po stupcu, npr. `{ 'Ukupno': 1234.5 }` po `label`). */
  totals?: Record<string, string | number | null | undefined>;
  /** Ležeći A4 (zadano kad je više od 7 stupaca). */
  landscape?: boolean;
  /** Naziv firme u zaglavlju stranice. */
  companyName?: string;
}

const money = new Intl.NumberFormat('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const int = new Intl.NumberFormat('hr-HR', { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat('hr-HR', { maximumFractionDigits: 2 });

/** Vrijednost ćelije kao tekst u hrvatskom zapisu. */
export function formatCell(v: string | number | null | undefined, type: ExportColumnType): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') {
    if (type === 'money') return money.format(v);
    if (type === 'int') return int.format(v);
    if (type === 'pct') return `${dec.format(v)} %`;
    return dec.format(v);
  }
  if (type === 'date') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (m) return `${m[3]}.${m[2]}.${m[1]}.`;
  }
  return v;
}

const RIGHT: ExportColumnType[] = ['int', 'number', 'money', 'pct'];

// ---------------------------------------------------------------- raspored stupaca

/** A4 u točkama i rubovi stranice popisa. */
const PAGE = { portrait: 595.28, landscape: 841.89 };
const SIDE = 24;
/** Razmak unutar ćelije (lijevo + desno). */
const PAD = 2;
const FONT_MAX = 8;
const FONT_MIN = 5.5;
/** Najdulji neprelomivi dio teksta u tekstualnom stupcu — dulji se lome (serijski brojevi, e-pošta); u tijesnoj tablici kraći. */
const TOKEN_MAX = 14;
const TOKEN_MIN = 8;

/** Procjena širine teksta u Robotu (em po znaku; brojke su jednako široke). */
export function textWidth(s: string, fontSize: number, bold = false): number {
  let em = 0;
  for (const ch of s) {
    if (/[0-9]/.test(ch)) em += 0.562;
    else if (/[MWmw@%]/.test(ch)) em += 0.85;
    else if (/[A-ZČĆŽŠĐ]/.test(ch)) em += 0.66;
    else if (/[a-zčćžšđ]/.test(ch)) em += 0.52;
    else if (/[\s.,:;'|!ilj]/.test(ch)) em += 0.26;
    else em += 0.5;
  }
  // sigurnosna rezerva (kerning, zaokruživanje) i podebljani tekst
  return em * fontSize * (bold ? 1.08 : 1) * 1.04;
}

/** Tekst s mjestima prijeloma (razmak nulte širine) u predugim riječima. */
const breakable = (s: string, max: number) => s.replace(new RegExp(`([^\\s]{${max}})(?=[^\\s])`, 'g'), '$1\u200B');

interface ColumnFit {
  /** Najmanja širina (najdulja neprelomiva riječ; brojevi i datumi cijeli). */
  min: number;
  /** Poželjna širina (cijeli sadržaj u jednom retku, ograničeno). */
  want: number;
}

function fitColumn(head: string, cells: string[], wrap: boolean, fontSize: number, tokenMax: number): ColumnFit {
  const words = (v: string) => v.split(/\s+/).filter(Boolean);
  const token = (v: string, bold = false) =>
    Math.max(0, ...words(v).map((w) => textWidth(wrap ? w.slice(0, tokenMax) : w, fontSize, bold)));
  // zaglavlje se lomi po riječima; ćelije broja/datuma ne lome se
  let min = token(head, true);
  let want = textWidth(head, fontSize, true);
  for (const c of cells) {
    min = Math.max(min, wrap ? token(c) : textWidth(c, fontSize));
    want = Math.max(want, textWidth(wrap ? c.slice(0, 48) : c, fontSize));
  }
  return { min: min + 2 * PAD + 0.5, want: want + 2 * PAD + 0.5 };
}

/**
 * Raspored stupaca: najveći font (8 → 5,5 pt) pri kojem svi stupci stanu u širinu
 * stranice; višak širine dijeli se stupcima kojima treba više (tekst). Kad ni uz
 * najmanji font ne stane, stupci se dijele u više tablica (prvi stupac se ponavlja).
 */
export function layoutColumns(
  heads: string[],
  cells: string[][],
  wrap: boolean[],
  width: number,
): { fontSize: number; tokenMax: number; chunks: Array<{ cols: number[]; widths: number[] }> } {
  const n = heads.length;
  let tokenMax = TOKEN_MAX;
  const fitsAt = (fs: number) => heads.map((h, i) => fitColumn(h, cells.map((r) => r[i]), wrap[i], fs, tokenMax));
  let fs = FONT_MAX;
  let fit = fitsAt(fs);
  while (fs > FONT_MIN && fit.reduce((a, f) => a + f.min, 0) > width) {
    fs = Math.max(FONT_MIN, fs - 0.5);
    fit = fitsAt(fs);
  }
  // ni najmanji font nije dovoljan: dulje riječi u tekstu lome se češće
  if (fit.reduce((a, f) => a + f.min, 0) > width) {
    tokenMax = TOKEN_MIN;
    fit = fitsAt(fs);
  }
  // skupine stupaca koje stanu (s mnogo stupaca i najmanjim fontom); prvi stupac se ponavlja
  const chunks: number[][] = [];
  if (fit.reduce((a, f) => a + f.min, 0) <= width || n <= 1) chunks.push(heads.map((_, i) => i));
  else {
    let cur: number[] = [0];
    let used = fit[0].min;
    for (let i = 1; i < n; i++) {
      if (cur.length > 1 && used + fit[i].min > width) {
        chunks.push(cur);
        cur = [0];
        used = fit[0].min;
      }
      cur.push(i);
      used += fit[i].min;
    }
    chunks.push(cur);
  }
  return {
    fontSize: fs,
    tokenMax,
    chunks: chunks.map((cols) => {
      const mins = cols.map((i) => fit[i].min);
      const extra = Math.max(0, width - mins.reduce((a, m) => a + m, 0));
      const need = cols.map((i) => Math.max(0, fit[i].want - fit[i].min));
      const needSum = need.reduce((a, x) => a + x, 0);
      // višak: najprije do poželjne širine, ostatak razmjerno
      const widths = cols.map((_, k) => {
        const give = needSum > 0 ? Math.min(need[k], (extra * need[k]) / needSum) : extra / cols.length;
        return mins[k] + give;
      });
      const left = width - widths.reduce((a, w) => a + w, 0);
      if (left > 0.5) {
        const textCols = cols.map((i, k) => (wrap[i] ? k : -1)).filter((k) => k >= 0);
        const spread = textCols.length ? textCols : cols.map((_, k) => k);
        for (const k of spread) widths[k] += left / spread.length;
      }
      // pdfmake dodaje razmak ćelije na zadanu širinu — širina ovdje je bez njega
      return { cols, widths: widths.map((w) => Math.max(1, Math.floor((w - 2 * PAD) * 100) / 100)) };
    }),
  };
}

export function tableDocDefinition<T>(input: TablePdfInput<T>): TDocumentDefinitions {
  const raw = input.rows.map((r) => input.columns.map((c) => c.value(r)));
  const types = input.columns.map((c, i) => c.type ?? inferColumnType(raw.map((r) => r[i])));
  const landscape = input.landscape ?? input.columns.length > 7;
  const width = (landscape ? PAGE.landscape : PAGE.portrait) - 2 * SIDE;
  const heads = input.columns.map((c) => c.label);
  const text = raw.map((r) => r.map((v, i) => formatCell(v, types[i])));
  const totals = input.totals ? input.columns.map((c, i) => formatCell(input.totals![c.label] ?? (i === 0 ? 'Ukupno' : ''), types[i])) : null;
  // brojevi i datumi se ne lome; tekst se lomi po riječima (preduge riječi uz razmak nulte širine)
  const wrap = types.map((t) => !RIGHT.includes(t) && t !== 'date');
  const layout = layoutColumns(heads, totals ? [...text, totals] : text, wrap, width);
  const align = (i: number) => (RIGHT.includes(types[i]) ? 'right' : 'left');
  const cell = (v: string, i: number) => ({ text: wrap[i] ? breakable(v, layout.tokenMax) : v, alignment: align(i), noWrap: !wrap[i] });

  const many = layout.chunks.length > 1;
  const tables: Content[] = layout.chunks.map(({ cols, widths }, k) => {
    const table = {
      table: {
        headerRows: 1,
        widths,
        body: [
          cols.map((i) => ({ text: heads[i], bold: true, alignment: align(i), fillColor: '#eef1f5' })),
          ...text.map((r) => cols.map((i) => cell(r[i], i))),
          ...(totals ? [cols.map((i) => ({ ...cell(totals[i], i), bold: true, fillColor: '#f6f7f9' }))] : []),
        ] as TableCell[][],
      },
      layout: {
        hLineWidth: (i: number) => (i === 0 || i === 1 ? 0.8 : 0.3),
        vLineWidth: () => 0,
        hLineColor: () => '#c9ced6',
        paddingLeft: () => PAD,
        paddingRight: () => PAD,
        paddingTop: () => 2.5,
        paddingBottom: () => 2.5,
      },
      fontSize: layout.fontSize,
    } as Content;
    if (!many) return table;
    // previše stupaca i za najmanji font: nastavak tablice s ostalim stupcima (prvi stupac se ponavlja)
    const label = `Stupci ${k + 1} / ${layout.chunks.length}: ${cols.map((i) => heads[i]).join(', ')}`;
    return { stack: [{ text: label, fontSize: 7, color: '#555', margin: [0, 0, 0, 3] }, table], ...(k ? { pageBreak: 'before' } : {}) } as Content;
  });

  const printed = new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const content: Content[] = [
    { text: input.title, fontSize: 14, bold: true, margin: [0, 0, 0, input.subtitle ? 2 : 8] },
    ...(input.subtitle ? [{ text: input.subtitle, color: '#555', margin: [0, 0, 0, 8] as [number, number, number, number] }] : []),
    ...(input.rows.length ? tables : [{ text: 'Nema podataka.', italics: true, color: '#777' } as Content]),
  ];
  return {
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageMargins: [SIDE, 40, SIDE, 44],
    info: { title: input.title },
    header: input.companyName ? { text: input.companyName, fontSize: 7, color: '#777', margin: [SIDE, 18, SIDE, 0] } : undefined,
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `Ispisano ${printed}`, fontSize: 7, color: '#777' },
        { text: `${page} / ${pages}`, fontSize: 7, color: '#777', alignment: 'right' },
      ],
      margin: [SIDE, 16, SIDE, 0],
    }),
    content,
  };
}

/** Popis kao PDF (Buffer) — za rute izvoza (`?format=pdf`) i privitke e-pošte. */
export function renderTablePdf<T>(input: TablePdfInput<T>): Promise<Buffer> {
  return renderPdf(tableDocDefinition(input));
}
