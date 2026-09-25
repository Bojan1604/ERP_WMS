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

export function tableDocDefinition<T>(input: TablePdfInput<T>): TDocumentDefinitions {
  const raw = input.rows.map((r) => input.columns.map((c) => c.value(r)));
  const types = input.columns.map((c, i) => c.type ?? inferColumnType(raw.map((r) => r[i])));
  const landscape = input.landscape ?? input.columns.length > 7;
  const head: TableCell[] = input.columns.map((c, i) => ({ text: c.label, bold: true, alignment: RIGHT.includes(types[i]) ? 'right' : 'left', fillColor: '#eef1f5' }));
  const body: TableCell[][] = raw.map((r) => r.map((v, i) => ({ text: formatCell(v, types[i]), alignment: RIGHT.includes(types[i]) ? 'right' : 'left', noWrap: types[i] === 'date' })));
  if (input.totals) {
    body.push(
      input.columns.map((c, i) => ({
        text: formatCell(input.totals![c.label] ?? (i === 0 ? 'Ukupno' : ''), types[i]),
        bold: true,
        alignment: RIGHT.includes(types[i]) ? 'right' : 'left',
        fillColor: '#f6f7f9',
      })),
    );
  }
  const printed = new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
  const content: Content[] = [
    { text: input.title, fontSize: 14, bold: true, margin: [0, 0, 0, input.subtitle ? 2 : 8] },
    ...(input.subtitle ? [{ text: input.subtitle, color: '#555', margin: [0, 0, 0, 8] as [number, number, number, number] }] : []),
    input.rows.length
      ? {
          table: {
            headerRows: 1,
            // tekstualni stupci dijele širinu, brojevi i datumi su široki koliko treba;
            // s mnogo stupaca svi dijele širinu (inače tablica izlazi preko ruba)
            widths: types.map((t) => (t === 'text' || input.columns.length > 9 ? '*' : 'auto')),
            body: [head, ...body],
          },
          layout: {
            hLineWidth: (i: number) => (i === 0 || i === 1 ? 0.8 : 0.3),
            vLineWidth: () => 0,
            hLineColor: () => '#c9ced6',
            paddingTop: () => 2.5,
            paddingBottom: () => 2.5,
          },
          fontSize: input.columns.length > 10 ? 7 : 8,
        }
      : { text: 'Nema podataka.', italics: true, color: '#777' },
  ];
  return {
    pageOrientation: landscape ? 'landscape' : 'portrait',
    info: { title: input.title },
    header: input.companyName ? { text: input.companyName, fontSize: 7, color: '#777', margin: [36, 18, 36, 0] } : undefined,
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `Ispisano ${printed}`, fontSize: 7, color: '#777' },
        { text: `${page} / ${pages}`, fontSize: 7, color: '#777', alignment: 'right' },
      ],
      margin: [36, 16, 36, 0],
    }),
    content,
  };
}

/** Popis kao PDF (Buffer) — za rute izvoza (`?format=pdf`) i privitke e-pošte. */
export function renderTablePdf<T>(input: TablePdfInput<T>): Promise<Buffer> {
  return renderPdf(tableDocDefinition(input));
}
