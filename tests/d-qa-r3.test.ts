/**
 * QA krug 3 — čista logika: vrsta uređaja na portalu prema vlasništvu, zadana kvačica
 * „Knjiži kao trošak" pri prihvaćanju (pravilo max(primke, računi za robu)), oznake svih
 * akcija dnevnika, pretraga za svakog internog korisnika.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { portalAwaitingReturn, portalDeviceKind, portalDeviceState } from '../src/domain/portal';
import { acceptBookDefault, acceptPreview } from '../src/domain/purchase-links';

const money = (v: number) => `${v.toFixed(2)} €`;

test('portal: uređaj na servisu zadržava vrstu (najam/kupnja), stanje servisa je zasebno', () => {
  assert.equal(portalDeviceKind('SOLD', 'Prodan'), 'kupnja');
  assert.equal(portalDeviceKind('RENTED', 'U najmu'), 'najam');
  assert.equal(portalDeviceKind('SERVICE', 'Pokvaren', 'SOLD'), 'kupnja');
  assert.equal(portalDeviceKind('SERVICE', 'Pokvaren', 'RENTED'), 'najam');
  assert.equal(portalDeviceKind('SERVICE', 'Pokvaren', null), 'pokvaren');
  assert.equal(portalAwaitingReturn({ state: 'SERVICE', openOrderLabel: null }), true);
  assert.equal(portalAwaitingReturn({ state: 'SERVICE', openOrderLabel: 'Dijagnostika' }), false);
  assert.equal(portalDeviceState({ openOrderLabel: null, warrantyEnd: null, state: 'SERVICE' }, '2026-09-25'), 'na servisu · čeka povrat');
  assert.equal(portalDeviceState({ openOrderLabel: 'Zaprimljeno', warrantyEnd: null, state: 'SERVICE' }, '2026-09-25'), 'u servisu · Zaprimljeno');
});

test('prihvaćanje računa: povezani račun za robu po zadanom se knjiži (samo razlika iznad primke)', () => {
  const rows = [{ id: 'a', net: 250, vat: 62.5, goods: true, books: false }];
  const p = acceptPreview(200, rows, 'a', true)!;
  assert.deepEqual({ covered: p.covered, ownNet: p.ownNet, mode: p.mode }, { covered: 200, ownNet: 50, mode: 'partial' });
  const partial = acceptBookDefault(22, { linked: true, goods: true, mode: 'partial', ownNet: 50 }, money);
  assert.equal(partial.book, true, 'uključeno i kad dobavljač ima nedavne primke');
  assert.match(partial.hint, /samo razlika iznad primke \(50\.00 €\)/);
  // bez prava costs iznos se ne prikazuje
  assert.doesNotMatch(acceptBookDefault(0, { linked: true, goods: true, mode: 'partial', ownNet: null }, money).hint, /€/);
  assert.equal(acceptBookDefault(3, { linked: true, goods: true, mode: 'receipt', ownNet: 0 }, money).book, true);
  assert.equal(acceptBookDefault(3, { linked: true, goods: false, mode: 'own', ownNet: 40 }, money).book, true);
  // nepovezani račun uz nedavne primke: isključeno, množina ispravna
  const lone = acceptBookDefault(22, null, money);
  assert.equal(lone.book, false);
  assert.match(lone.hint, /22 primke/);
  assert.match(acceptBookDefault(21, null, money).hint, /21 primku/);
  assert.match(acceptBookDefault(25, null, money).hint, /25 primki/);
  assert.equal(acceptBookDefault(0, null, money).book, true);
});

function files(dir: string, out: string[] = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(f)) out.push(p);
  }
  return out;
}

test('dnevnik: svaka akcija iz audit poziva ima oznaku', () => {
  const page = readFileSync('src/app/(app)/postavke/dnevnik/page.tsx', 'utf8');
  const block = page.slice(page.indexOf('const ACTION_LABEL'), page.indexOf('const ACTION_TONE'));
  const labelled = new Set([...block.matchAll(/(?:'([\w-]+)'|(\w[\w-]*)):\s*'/g)].map((m) => m[1] ?? m[2]));
  const used = new Set<string>();
  for (const f of files('src/server').concat(files('src/app'))) {
    const src = readFileSync(f, 'utf8');
    if (!src.includes('audit(')) continue;
    // action: 'x'  i  action: uvjet ? 'x' : 'y'
    for (const m of src.matchAll(/\baction:\s*([^,}\n]*)/g)) for (const a of m[1].matchAll(/'([\w-]+)'/g)) used.add(a[1]);
  }
  // vrijednosti koje nisu akcije dnevnika (servisni nalog „action", ciljevi povrata…)
  for (const x of ['IR', 'SOLD', 'RENTED', 'IN_STOCK', 'WRITTEN_OFF']) used.delete(x);
  const missing = [...used].filter((a) => !labelled.has(a)).sort();
  assert.deepEqual(missing, [], `akcije bez oznake: ${missing.join(', ')}`);
});

test('pretraga (/trazi) radi za svakog internog korisnika, ne traži nadzornu ploču', () => {
  const src = readFileSync('src/app/(app)/trazi/page.tsx', 'utf8');
  assert.match(src, /internalPageAccess\(\)/);
  assert.doesNotMatch(src, /pageAccess\('dashboard'\)/);
});
