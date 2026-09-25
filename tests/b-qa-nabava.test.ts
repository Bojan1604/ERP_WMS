/**
 * QA t3 (skladište/nabava) — čista logika: stroga provjera iznosa u obrascima (#6)
 * i višestruki filtar s vrijednostima koje sadrže zarez (#9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, parseNumber } from '../src/domain/money';
import { zMoney, zOptMoney } from '../src/server/zod';
import { joinMulti, parseMulti, splitMulti } from '../src/lib/list-params';

test('#6 parseAmount: hrvatski i engleski zapis, neispravno = NaN (ne 0)', () => {
  assert.equal(parseAmount('1.234,56'), 1234.56);
  assert.equal(parseAmount('1,234.56'), 1234.56);
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount(' 1 500 € '), 1500);
  assert.equal(parseAmount('-5'), -5);
  assert.equal(parseAmount('1.500'), 1500, 'hr: tisućice');
  assert.equal(parseAmount('1.5'), 1.5);
  assert.equal(parseAmount('1.500,5'), 1500.5);
  assert.equal(parseAmount('220.85'), 220.85);
  assert.equal(parseAmount('0'), 0);
  assert.equal(parseAmount('25 %'), 25);
  for (const bad of ['abc', '12x', '1,2,3x', '€', '--1', '']) assert.ok(Number.isNaN(parseAmount(bad)), bad);
  // blaga inačica (uvoz, izvještaji) ostaje ista
  assert.equal(parseNumber('abc'), 0);
  assert.equal(parseNumber('12x'), 12);
});

test('#6 zMoney/zOptMoney: tekst u novčanom polju je greška „Neispravan iznos", prazno ostaje 0 / null', () => {
  assert.equal(zMoney.parse('1.234,56'), 1234.56);
  assert.equal(zMoney.parse(''), 0);
  assert.equal(zMoney.parse(12.5), 12.5);
  assert.equal(zOptMoney.parse(''), null);
  assert.equal(zOptMoney.parse('   '), null);
  assert.equal(zOptMoney.parse(null), null);
  assert.equal(zOptMoney.parse('7,5'), 7.5);
  for (const schema of [zMoney, zOptMoney]) {
    for (const bad of ['abc', '12x', Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = schema.safeParse(bad);
      assert.equal(r.success, false, String(bad));
      assert.equal(r.error?.issues[0].message, 'Neispravan iznos');
    }
  }
  // lanci s .refine i dalje rade
  assert.equal(zMoney.refine((v) => v >= 0, 'neg').safeParse('-1').success, false);
});

test('#9 višestruki filtar: vrijednost sa zarezom ostaje jedna vrijednost', () => {
  const cpu = ['ARM Cortex-A53, 4 jezgre', 'Snapdragon 665', 'a\\b'];
  const raw = joinMulti(cpu);
  assert.deepEqual(splitMulti(raw), cpu);
  assert.deepEqual(parseMulti(new URLSearchParams({ cpu: raw }), 'cpu'), cpu);
  assert.deepEqual(parseMulti({ cpu: raw }, 'cpu'), cpu);
  // stari URL-ovi i enum vrijednosti — isto kao prije
  assert.deepEqual(parseMulti({ status: 'A, B,,A' }, 'status'), ['A', 'B']);
  assert.deepEqual(parseMulti({ status: 'A,X' }, 'status', ['A', 'B'] as const), ['A']);
  // ponovljeni parametar
  const sp = new URLSearchParams();
  sp.append('cpu', 'ARM Cortex-A53\\, 4 jezgre');
  sp.append('cpu', 'x86');
  assert.deepEqual(parseMulti(sp, 'cpu'), ['ARM Cortex-A53, 4 jezgre', 'x86']);
  assert.deepEqual(parseMulti({ cpu: ['a', 'b,c'] }, 'cpu'), ['a', 'b', 'c']);
});
