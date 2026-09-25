import 'server-only';
import ExcelJS from 'exceljs';
import { csvResponse, inferColumnType, toCsv, type ExportColumn, type ExportColumnType } from '@/lib/csv';
import { renderTablePdf } from './pdf/table';
import { pdfResponse } from './pdf/engine';

export { inferColumnType };

/**
 * Izvoz u Excel (.xlsx) s pravim vrstama ćelija: brojevi su brojevi (ne tekst),
 * datumi su datumi, zaglavlje je podebljano i zamrznuto, uključen je autofiltar.
 * Isti opis stupaca kao za CSV (`ExportColumn`), pa svaki CSV izvoz dobiva
 * Excel bez dupliciranja (vidi `csvOrXlsx`).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** Hrvatski zapis datuma („05.03.2026." ili „5.3.2026") — postojeći CSV izvozi ga koriste. */
const HR_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/;

const FORMAT: Record<Exclude<ExportColumnType, 'text'>, string> = {
  int: '#,##0',
  number: '#,##0.##',
  money: '#,##0.00',
  date: 'dd.mm.yyyy.',
  pct: '0.00" %"',
};

type Cell = string | number | null | undefined;

/** „YYYY-MM-DD" / „DD.MM.YYYY." → Date u UTC ponoć (Excel ga prikazuje kao taj dan, bez pomaka zone). */
function toDate(v: Cell): Date | Cell {
  if (typeof v !== 'string') return v;
  if (ISO_DATE.test(v)) return new Date(`${v}T00:00:00Z`);
  const hr = HR_DATE.exec(v);
  if (hr) return new Date(Date.UTC(Number(hr[3]), Number(hr[2]) - 1, Number(hr[1])));
  if (ISO_DATETIME.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d;
  }
  return v;
}

/** Vrijednost ćelije: brojevi kao brojevi i u tekstualnom obliku „1.234,56" nisu potrebni. */
function cellValue(v: Cell, type: ExportColumnType): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null;
  if (type === 'date') return toDate(v) as ExcelJS.CellValue;
  if (type === 'pct' && typeof v === 'number') return v;
  return v;
}

/** Radna knjiga s jednim listom — Buffer spreman za odgovor. */
export async function toXlsx<T>(columns: ExportColumn<T>[], rows: T[], sheetName = 'Podaci'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ERP/WMS';
  wb.created = new Date();
  // Excel dopušta najviše 31 znak i bez nekih znakova u nazivu lista
  const ws = wb.addWorksheet(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Podaci', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const raw = rows.map((r) => columns.map((c) => c.value(r)));
  const types = columns.map((c, i) => c.type ?? inferColumnType(raw.map((r) => r[i])));

  ws.columns = columns.map((c, i) => {
    const type = types[i];
    let width = c.width;
    if (!width) {
      // širina po najduljem sadržaju (uzorak prvih 500 redaka), između 8 i 60 znakova
      let max = c.label.length;
      for (const r of raw.slice(0, 500)) {
        const v = r[i];
        const len = v === null || v === undefined ? 0 : type === 'date' ? 11 : typeof v === 'number' ? v.toFixed(2).length + 3 : String(v).length;
        if (len > max) max = len;
      }
      width = Math.min(60, Math.max(8, max + 2));
    }
    return {
      header: c.label,
      key: `c${i}`,
      width,
      style: type === 'text' ? {} : { numFmt: FORMAT[type], alignment: type === 'date' ? { horizontal: 'left' } : { horizontal: 'right' } },
    };
  });

  for (const r of raw) ws.addRow(r.map((v, i) => cellValue(v, types[i])));

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F6' } };
  if (columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, raw.length + 1), column: columns.length } };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export function xlsxResponse(buf: Buffer, fileName: string) {
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'no-store',
    },
  });
}

type Source = Request | URL | URLSearchParams;
const searchOf = (req: Source) => (req instanceof URLSearchParams ? req : req instanceof URL ? req.searchParams : new URL(req.url).searchParams);

/** Traži li zahtjev Excel (`?format=xlsx`). */
export const wantsXlsx = (req: Source) => searchOf(req).get('format') === 'xlsx';

/** Najviše redaka u PDF-u popisa (veći popis → Excel). */
export const PDF_MAX_ROWS = 5000;

/**
 * Odgovor izvoza: CSV (zadano), Excel (`?format=xlsx`) ili PDF tablica
 * (`?format=pdf`, naslov = `sheetName`, podnaslov = `opts.subtitle`).
 * `fileName` je bez nastavka (npr. `racuni-2026`).
 */
export async function csvOrXlsx<T>(
  req: Source,
  rows: T[],
  columns: ExportColumn<T>[],
  fileName: string,
  sheetName?: string,
  opts: { subtitle?: string; companyName?: string; landscape?: boolean } = {},
): Promise<Response> {
  const base = fileName.replace(/\.(csv|xlsx|pdf)$/i, '');
  const format = searchOf(req).get('format');
  if (format === 'xlsx') return xlsxResponse(await toXlsx(columns, rows, sheetName), `${base}.xlsx`);
  if (format === 'pdf') {
    const cut = rows.length > PDF_MAX_ROWS;
    const subtitle = [opts.subtitle, cut ? `Prikazano prvih ${PDF_MAX_ROWS} od ${rows.length} redaka — za cijeli popis koristite Excel.` : null].filter(Boolean).join(' · ');
    const buf = await renderTablePdf({
      title: sheetName ?? base,
      subtitle: subtitle || undefined,
      columns,
      rows: cut ? rows.slice(0, PDF_MAX_ROWS) : rows,
      companyName: opts.companyName,
      landscape: opts.landscape,
    });
    return pdfResponse(buf, `${base}.pdf`);
  }
  return csvResponse(toCsv(rows, columns), `${base}.csv`);
}

/** Isto što i `csvOrXlsx` (CSV / Excel / PDF po `?format=`). */
export const exportResponse = csvOrXlsx;
