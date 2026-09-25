/**
 * Zajednički Combobox (i partner-combobox): čista logika stanja — redni brojevi upita,
 * odbacivanje zastarjelih odgovora, Enter dok se rezultat učitava, Esc/zatvaranje briše upit,
 * te pretraga bez dijakritika (preglednik i isti niz zamjene kao u SQL-u/indeksu).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { comboReducer, filterOptions, initialComboState, type ComboAction, type ComboItem, type ComboState } from '../src/components/ui/combobox-state';
import { FOLD_FROM, FOLD_TO, fold } from '../src/lib/fold';

const o = (value: string, label = value): ComboItem => ({ value, label });
const run = (actions: ComboAction[], s: ComboState = initialComboState()) => actions.reduce(comboReducer, s);

test('otvaranje: novi redni broj, prazan upit, čeka poslužitelj', () => {
  const s = run([{ type: 'open', remote: true }]);
  assert.equal(s.open, true);
  assert.equal(s.q, '');
  assert.equal(s.loading, true);
  assert.equal(s.seq, 1);
  // lokalni popis ne čeka ništa
  assert.equal(run([{ type: 'open', remote: false }]).loading, false);
});

test('svaka promjena upita podiže redni broj; zastarjeli odgovor se odbacuje', () => {
  let s = run([{ type: 'open', remote: true }]);
  const openSeq = s.seq;
  s = comboReducer(s, { type: 'query', q: 'mar', remote: true });
  const marSeq = s.seq;
  assert.ok(marSeq > openSeq);
  s = comboReducer(s, { type: 'query', q: 'mark', remote: true });
  // stiže kasni odgovor za „mar" — odbacuje se
  s = comboReducer(s, { type: 'results', seq: marSeq, options: [o('1', 'Marina')] });
  assert.equal(s.remote, null);
  assert.equal(s.loading, true);
  // odgovor za trenutni upit se prihvaća
  s = comboReducer(s, { type: 'results', seq: s.seq, options: [o('2', 'Market')] });
  assert.deepEqual(s.remote, [o('2', 'Market')]);
  assert.equal(s.loading, false);
});

test('Enter dok se čeka rezultat: ne bira stari, nego prvi rezultat TRENUTNOG upita kad stigne', () => {
  let s = run([{ type: 'open', remote: true }]);
  s = comboReducer(s, { type: 'results', seq: s.seq, options: [o('a', 'Alfa'), o('b', 'Beta')] });
  s = comboReducer(s, { type: 'query', q: 'slastic', remote: true });
  const seq = s.seq;
  // prikazani (stari) popis je još Alfa/Beta — Enter ga ne smije uzeti
  s = comboReducer(s, { type: 'enter', list: [o('a', 'Alfa'), o('b', 'Beta')] });
  assert.equal(s.selection, null);
  assert.equal(s.open, true);
  assert.equal(s.pendingEnter, true);
  // zastarjeli odgovor (neki raniji upit) ne okida odabir
  s = comboReducer(s, { type: 'results', seq: seq - 1, options: [o('a', 'Alfa')] });
  assert.equal(s.selection, null);
  // stiže odgovor za „slastic" → bira se prvi, popis se zatvara, upit briše
  s = comboReducer(s, { type: 'results', seq, options: [o('s', 'Slastičarnica Mandrać'), o('t', 'Slastice')] });
  assert.deepEqual(s.selection, { option: o('s', 'Slastičarnica Mandrać') });
  assert.equal(s.open, false);
  assert.equal(s.q, '');
  assert.equal(s.pendingEnter, false);
});

test('Enter dok se čeka, a rezultat je prazan: ništa se ne bira, popis ostaje otvoren', () => {
  let s = run([{ type: 'open', remote: true }, { type: 'query', q: 'zzz', remote: true }]);
  s = comboReducer(s, { type: 'enter', list: [o('a')] });
  s = comboReducer(s, { type: 'results', seq: s.seq, options: [] });
  assert.equal(s.selection, null);
  assert.equal(s.open, true);
  assert.equal(s.pendingEnter, false);
});

test('novi upit nakon Entera poništava čekanje (bira se tek na novi Enter)', () => {
  let s = run([{ type: 'open', remote: true }, { type: 'query', q: 'a', remote: true }, { type: 'enter', list: [] }]);
  assert.equal(s.pendingEnter, true);
  s = comboReducer(s, { type: 'query', q: 'ab', remote: true });
  assert.equal(s.pendingEnter, false);
  s = comboReducer(s, { type: 'results', seq: s.seq, options: [o('x')] });
  assert.equal(s.selection, null);
});

test('Enter kad je rezultat učitan bira označenu stavku (strelice)', () => {
  let s = run([{ type: 'open', remote: true }]);
  const list = [o('a'), o('b'), o('c')];
  s = comboReducer(s, { type: 'results', seq: s.seq, options: list });
  s = run([{ type: 'move', delta: 1, count: 3 }, { type: 'move', delta: 1, count: 3 }, { type: 'move', delta: 1, count: 3 }], s);
  assert.equal(s.active, 2); // ne ide preko kraja
  s = comboReducer(s, { type: 'move', delta: -5, count: 3 });
  assert.equal(s.active, 0);
  s = comboReducer(s, { type: 'move', delta: 1, count: 3 });
  s = comboReducer(s, { type: 'enter', list });
  assert.deepEqual(s.selection, { option: o('b') });
});

test('lokalni popis: Enter odmah bira (nema čekanja)', () => {
  const list = filterOptions([o('1', 'Čokolada'), o('2', 'Kava')], 'cok');
  const s = run([{ type: 'open', remote: false }, { type: 'query', q: 'cok', remote: false }, { type: 'enter', list }]);
  assert.deepEqual(s.selection, { option: o('1', 'Čokolada') });
});

test('zatvaranje (Esc/Tab/klik izvan) briše upit; odgovor stigao nakon zatvaranja se odbacuje', () => {
  let s = run([{ type: 'open', remote: true }, { type: 'query', q: 'man', remote: true }]);
  const seq = s.seq;
  s = comboReducer(s, { type: 'enter', list: [] });
  s = comboReducer(s, { type: 'close' });
  assert.equal(s.open, false);
  assert.equal(s.q, '');
  assert.equal(s.pendingEnter, false);
  s = comboReducer(s, { type: 'results', seq, options: [o('m', 'Mandrać')] });
  assert.equal(s.selection, null);
  assert.equal(s.remote, null);
  // ponovno otvaranje počinje čisto i s novim rednim brojem
  s = comboReducer(s, { type: 'open', remote: true });
  assert.equal(s.q, '');
  assert.ok(s.seq > seq);
});

test('odabir mišem (i „bez odabira") zatvara i predaje vrijednost', () => {
  const s = run([{ type: 'open', remote: false }, { type: 'pick', option: null }]);
  assert.deepEqual(s.selection, { option: null });
  assert.equal(s.open, false);
});

test('pretraga bez dijakritika i velikih slova', () => {
  assert.equal(fold('Slastičarnica ĐURO Mandrać'), 'slasticarnica duro mandrac');
  const opts = [o('1', 'Slastičarnica Zagreb'), o('2', 'Mandrać d.o.o.'), o('3', 'Kava')];
  assert.deepEqual(filterOptions(opts, 'slasticarnica').map((x) => x.value), ['1']);
  assert.deepEqual(filterOptions(opts, 'MANDRAC').map((x) => x.value), ['2']);
  assert.deepEqual(filterOptions(opts, 'Mandrać').map((x) => x.value), ['2']);
  assert.equal(filterOptions(opts, '').length, 3);
});

test('tablica zamjene je ista u kodu i u migraciji indeksa', () => {
  assert.equal([...FOLD_FROM].length, FOLD_TO.length);
  const dir = new URL('../prisma/migrations/', import.meta.url);
  const mig = readdirSync(dir).find((d) => d.endsWith('_unaccent'));
  assert.ok(mig, 'migracija *_unaccent postoji');
  const sql = readFileSync(new URL(`${mig}/migration.sql`, dir), 'utf8');
  assert.ok(sql.includes(`lower(translate("name", '${FOLD_FROM}', '${FOLD_TO}'))`));
});
