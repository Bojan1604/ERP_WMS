/** Uređaji istog modela i cijene kao jedna stavka (editor, ispis, eRačun). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceLineKey, groupLines, lineNet, unifyDevicePrices } from '../src/domain/invoice';
import { buildUbl, type UblInput } from '../src/domain/ubl';

const dev = (id: string, over: Record<string, unknown> = {}) => ({
  key: id, kind: 'DEVICE', itemId: id, modelId: 'm1', description: 'Sunmi T2s', unit: 'kom', kpd: '26.20.11', qty: 1, unitPrice: 250, discountPct: 0, warrantyMonths: 24, ...over,
});

test('dva uređaja istog modela i cijene = jedna stavka; druga cijena ili usluga ostaju zasebno', () => {
  const lines = [dev('a'), { ...dev('s'), kind: 'SERVICE', itemId: null }, dev('b'), dev('c', { unitPrice: 199 }), dev('d')];
  const g = groupLines(lines, deviceLineKey);
  assert.deepEqual(g.map((x) => x.lines.map((l) => l.key)), [['a', 'b', 'd'], ['s'], ['c']]);
});

test('ne grupira ako bi zaokruživanje promijenilo iznos', () => {
  const lines = [dev('a', { unitPrice: 0.335, discountPct: 0 }), dev('b', { unitPrice: 0.335, discountPct: 0 })];
  // 2 × r2(0.335) = 0.68, r2(2 × 0.335) = 0.67 → zasebne stavke
  assert.equal(r2sum(lines), 0.68);
  assert.equal(groupLines(lines, deviceLineKey).length, 2);
});
const r2sum = (ls: { qty: number; unitPrice: number; discountPct: number }[]) => Math.round(ls.reduce((a, l) => a + lineNet(l), 0) * 100) / 100;

test('eRačun: stavka s količinom 2 i oba serijska broja u opisu', () => {
  const input: UblInput = {
    kind: 'INVOICE', type: 'SALE', number: '1/PP1/1', issueDate: '2026-09-24', dueDate: '2026-10-09', currency: 'EUR',
    seller: { name: 'Prodavatelj d.o.o.', oib: '12345678903', address: 'Ilica 1', zip: '10000', city: 'Zagreb', country: 'HR', iban: 'HR1210010051863000160' },
    buyer: { name: 'Kupac d.o.o.', oib: '98765432106', address: 'Riva 2', zip: '21000', city: 'Split', country: 'HR' },
    vatRate: 25, lines: [{ description: 'Sunmi T2s', serials: ['SN1', 'SN2'], kpd: '26.20.11', unit: 'kom', qty: 2, unitPrice: 250, discountPct: 0 }],
  } as unknown as UblInput;
  const { xml, totals } = buildUbl(input);
  assert.match(xml, /<cbc:InvoicedQuantity unitCode="H87">2\.000<\/cbc:InvoicedQuantity>/);
  assert.match(xml, /<cbc:Description>SN: SN1, SN2<\/cbc:Description>/);
  assert.equal((xml.match(/<cac:InvoiceLine>/g) ?? []).length, 1);
  assert.equal(totals.net, 500);
  assert.equal(totals.total, 625);
});

test('isti model dobiva istu cijenu pa ide kao jedna stavka', () => {
  const dev = (id: string, price: number) => ({ kind: 'DEVICE', itemId: id, modelId: 'm1', description: 'TM-T20III', unit: 'kom', kpd: '', qty: 1, unitPrice: price, discountPct: 0, warrantyMonths: 24, agreedPrice: false });
  const added = unifyDevicePrices([], [dev('a', 94.97), dev('b', 99.15)]);
  assert.deepEqual(added.map((l) => l.unitPrice), [97.06, 97.06]);
  const more = unifyDevicePrices([{ ...added[0], unitPrice: 120, discountPct: 5 }], [dev('c', 90)]);
  assert.equal(more[0].unitPrice, 120);
  assert.equal(more[0].discountPct, 5);
  assert.equal(groupLines([...added], deviceLineKey).length, 1);
});
