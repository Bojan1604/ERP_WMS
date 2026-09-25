import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { inferColumnType, toCsv, type ExportColumn } from '../src/lib/csv';
import { dateRangeWhere, parseDateRange, parseMulti, parseSort, sortOrderBy } from '../src/lib/list-params';
import { toXlsx, csvOrXlsx } from '../src/server/xlsx';
import { renderTablePdf, formatCell } from '../src/server/pdf/table';
import { renderDocumentPdf, PdfNotImplementedError } from '../src/server/pdf';
import { canSeeCost, resolvePermissions, ROLE_DEFAULTS, can } from '../src/domain/permissions';
import { isMailKind, isPdfKind } from '../src/domain/documents';

type Row = { name: string; qty: number; amount: number; date: string; hr: string };
const rows: Row[] = [
  { name: 'Čćžšđ ČĆŽŠĐ d.o.o.', qty: 3, amount: 1234.5, date: '2026-03-05', hr: '05.03.2026.' },
  { name: 'Đurđa', qty: 10, amount: 0.1, date: '2026-12-31', hr: '31.12.2026.' },
];
const cols: ExportColumn<Row>[] = [
  { label: 'Naziv', value: (r) => r.name },
  { label: 'Količina', value: (r) => r.qty },
  { label: 'Iznos', value: (r) => r.amount },
  { label: 'Datum', value: (r) => r.date },
  { label: 'Datum HR', value: (r) => r.hr },
];

test('izvoz: vrsta stupca se pogađa iz vrijednosti', () => {
  assert.equal(inferColumnType([1, 2, null]), 'int');
  assert.equal(inferColumnType([1, 2.5]), 'money');
  assert.equal(inferColumnType(['2026-01-01', '']), 'date');
  assert.equal(inferColumnType(['01.02.2026.']), 'date');
  assert.equal(inferColumnType(['a', 1]), 'text');
  assert.equal(inferColumnType([]), 'text');
  assert.ok(toCsv(rows, cols).startsWith('﻿Naziv;Količina'));
});

test('izvoz: Excel s brojevima, datumima, podebljanim zaglavljem i autofiltrom', async () => {
  const buf = await toXlsx(cols, rows, 'Računi/2026');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Računi 2026');
  assert.equal(ws.getCell('A1').value, 'Naziv');
  assert.equal(ws.getCell('A1').font?.bold, true);
  assert.equal(ws.getCell('A2').value, 'Čćžšđ ČĆŽŠĐ d.o.o.');
  assert.equal(ws.getCell('B2').value, 3);
  assert.equal(ws.getCell('C2').value, 1234.5);
  assert.equal(ws.getCell('C2').numFmt, '#,##0.00');
  const d = ws.getCell('D2').value as Date;
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString().slice(0, 10), '2026-03-05');
  assert.equal((ws.getCell('E3').value as Date).toISOString().slice(0, 10), '2026-12-31');
  assert.ok(ws.autoFilter);
});

test('izvoz: csvOrXlsx bira format po ?format=', async () => {
  const csv = await csvOrXlsx(new URL('http://x/api?format=csv'), rows, cols, 'popis', 'Popis');
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(csv.headers.get('content-disposition') ?? '', /popis\.csv/);
  const x = await csvOrXlsx(new URL('http://x/api?format=xlsx'), rows, cols, 'popis', 'Popis');
  assert.match(x.headers.get('content-type') ?? '', /spreadsheetml/);
  const p = await csvOrXlsx(new URL('http://x/api?format=pdf'), rows, cols, 'popis', 'Popis');
  assert.equal(p.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await p.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
});

/** Tekst iz PDF-a nije izravno čitljiv (CID fontovi), pa se provjerava ugrađeni podskup fonta i ToUnicode mapa. */
function toUnicodeText(pdf: Buffer): string {
  const s = pdf.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    try {
      const txt = inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1');
      if (txt.includes('beginbfchar') || txt.includes('beginbfrange')) out += txt;
    } catch {
      /* nije komprimirano ili nije tekst */
    }
  }
  return out;
}

test('pdf: generička tablica s hrvatskim znakovima (Roboto, UTF-8)', async () => {
  const buf = await renderTablePdf({ title: 'Popis računa — čćžšđ', subtitle: 'Šifra: Đ', columns: cols, rows, totals: { Iznos: 1234.6 } });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length > 5000);
  assert.match(buf.toString('latin1'), /Roboto/);
  const map = toUnicodeText(buf).toLowerCase();
  // ToUnicode sadrži kodne točke č (010d), ć (0107), ž (017e), š (0161), đ (0111) i Đ (0110)
  for (const cp of ['010d', '0107', '017e', '0161', '0111', '0110']) assert.ok(map.includes(`<${cp}>`), `nedostaje U+${cp}`);
  assert.equal(formatCell(1234.5, 'money'), '1.234,50');
  assert.equal(formatCell('2026-03-05', 'date'), '05.03.2026.');
});

test('pdf: renderDocumentPdf odbija nepoznatu vrstu (predlošci: tests/integration/a-pdf-mail.test.ts)', async () => {
  await assert.rejects(renderDocumentPdf('nepostojeca' as never, 'x', 'c'), PdfNotImplementedError);
  assert.ok(isPdfKind('invoice') && !isPdfKind('../etc'));
  assert.ok(isMailKind('accountant-zip') && !isMailKind('x'));
});

test('popisi: višestruki odabir, sortiranje i raspon datuma su sigurni', () => {
  const sp = { status: 'A,B,,A,X', sort: 'datum', dir: 'desc', od: '2026-05-01', do: '2026-01-01' };
  assert.deepEqual(parseMulti(sp, 'status'), ['A', 'B', 'X']);
  assert.deepEqual(parseMulti(sp, 'status', ['A', 'B'] as const), ['A', 'B']);
  assert.deepEqual(parseMulti(new URLSearchParams('p=1,2'), 'p'), ['1', '2']);
  assert.deepEqual(parseSort(sp, ['datum', 'broj'] as const), { sort: 'datum', dir: 'desc' });
  assert.equal(parseSort({ sort: 'password' }, ['datum'] as const), null);
  assert.deepEqual(parseSort({ sort: 'x' }, ['datum'] as const, { sort: 'datum', dir: 'asc' }), { sort: 'datum', dir: 'asc' });
  const s = parseSort(sp, ['datum'] as const);
  assert.deepEqual(sortOrderBy<'datum', Record<string, string>>(s, { datum: (d) => ({ date: d }) }, { id: 'asc' }), [{ date: 'desc' }, { id: 'asc' }]);
  // obrnut raspon se okreće, neispravan datum se zanemaruje
  assert.deepEqual(parseDateRange(sp), { from: '2026-01-01', to: '2026-05-01' });
  assert.deepEqual(parseDateRange({ od: '2026-13-45', do: 'x' }), { from: null, to: null });
  assert.equal(dateRangeWhere({ from: null, to: null }), undefined);
  assert.equal(dateRangeWhere({ from: '2026-01-01', to: null })?.gte?.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('prava: nabavne cijene (costs) i dnevnik (log)', () => {
  assert.ok(canSeeCost(ROLE_DEFAULTS.ADMIN));
  assert.ok(canSeeCost(ROLE_DEFAULTS.MANAGER));
  assert.ok(!canSeeCost(ROLE_DEFAULTS.SALES));
  assert.ok(!canSeeCost(ROLE_DEFAULTS.WAREHOUSE));
  assert.ok(canSeeCost(resolvePermissions('SALES', { costs: 'view' })));
  // razina iznad dopuštene svodi se na „view"
  assert.equal(resolvePermissions('SALES', { costs: 'edit' }).costs, 'view');
  assert.equal(ROLE_DEFAULTS.ADMIN.costs, 'view');
  assert.ok(can(ROLE_DEFAULTS.MANAGER, 'log'));
  assert.ok(!can(ROLE_DEFAULTS.SALES, 'log'));
  assert.ok(!can(ROLE_DEFAULTS.ACCOUNTANT, 'log'));
  // vanjski korisnici nikad
  assert.ok(!canSeeCost(resolvePermissions('CLIENT', { costs: 'view' })));
});
