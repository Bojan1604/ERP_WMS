/**
 * Stupci izvoza — isti opis vrijedi za CSV (`toCsv`), Excel (`toXlsx`, server/xlsx.ts)
 * i PDF tablicu (`renderTablePdf`, server/pdf). `type` je neobavezan: bez njega se
 * vrsta pogađa iz vrijednosti (broj → broj, „YYYY-MM-DD" → datum).
 */
export type ExportColumnType = 'text' | 'int' | 'number' | 'money' | 'date' | 'pct';

export interface CsvColumn<T> {
  label: string;
  value: (row: T) => string | number | null | undefined;
  /** Vrsta stupca za Excel/PDF (format broja/datuma, poravnanje). */
  type?: ExportColumnType;
  /** Širina stupca u Excelu (znakova); bez nje se računa iz sadržaja. */
  width?: number;
}

/** Opis stupca izvoza (CSV, Excel, PDF). */
export type ExportColumn<T> = CsvColumn<T>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HR_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/;

type Cell = string | number | null | undefined;

/** Vrsta stupca iz vrijednosti kad nije zadana: brojevi (cijeli ili s decimalama), datumi, tekst. */
export function inferColumnType(values: Cell[]): ExportColumnType {
  let numbers = 0;
  let decimals = false;
  let dates = 0;
  let filled = 0;
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    filled++;
    if (typeof v === 'number') {
      numbers++;
      if (!Number.isInteger(v)) decimals = true;
    } else if (ISO_DATE.test(v) || HR_DATE.test(v)) dates++;
  }
  if (!filled) return 'text';
  if (numbers === filled) return decimals ? 'money' : 'int';
  if (dates === filled) return 'date';
  return 'text';
}

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d[\d.,]*$/;

/**
 * Tekst ćelije siguran za Excel: tekst koji počinje s = + - @ ili tabom/CR-om
 * Excel bi izvršio kao formulu (CSV injection) — dobiva apostrof ispred.
 * Obični brojevi zapisani kao tekst („-12,50") ostaju kakvi jesu.
 */
export function csvSafeText(s: string): string {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s) ? `'${s}` : s;
}

/** CSV za Excel (točka-zarez, UTF-8 s BOM-om, decimalni zarez). */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const esc = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? String(v).replace('.', ',') : csvSafeText(String(v));
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => esc(c.label)).join(';'), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(';'))];
  return '﻿' + lines.join('\r\n');
}

export function csvResponse(csv: string, fileName: string) {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
