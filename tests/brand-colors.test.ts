/** Boje firme: izvođenje tokena teme i zajamčeni kontrast (WCAG) za bilo koju odabranu boju. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_PRESETS, DEFAULT_BRAND_COLOR, DEFAULT_MENU_COLOR, DEFAULT_TOKENS, SURFACES,
  companyColorsCss, contrast, luminance, deriveTheme, isHexColor, normalizeHex, storedColor,
} from '../src/domain/brand-colors';
import { sanitizeCompanySettings } from '../src/domain/company';
import { backupToPlan } from '../src/server/import/backup';

// deterministički generator (ponovljivi testovi)
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const rnd = rng(42);
const randomHex = () => `#${Math.floor(rnd() * 0xffffff).toString(16).padStart(6, '0')}`;

const EXTREMES = ['#000000', '#ffffff', '#ffff00', '#0000ff', '#ff0000', '#00ff00', '#00ffff', '#ff00ff', '#808080', '#767676', '#777777', '#f1f5f9', '#0d7777'];
const SAMPLES = [...EXTREMES, ...COLOR_PRESETS.flatMap((p) => [p.brand, p.menu]), ...Array.from({ length: 600 }, randomHex)];

test('normalizeHex / isHexColor', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex(' 0D7776 '), '#0d7776');
  assert.equal(normalizeHex('#12345'), null);
  assert.equal(normalizeHex('red'), null);
  assert.equal(normalizeHex(null), null);
  assert.ok(isHexColor('#A1b2C3'));
  assert.ok(!isHexColor('#abc'));
  assert.ok(!isHexColor('url(x)'));
  // zadana boja se sprema kao null
  assert.equal(storedColor('#0D7776', DEFAULT_BRAND_COLOR), null);
  assert.equal(storedColor('#2563eb', DEFAULT_BRAND_COLOR), '#2563eb');
  assert.equal(storedColor('nije boja', DEFAULT_BRAND_COLOR), null);
});

test('zadane boje = točno današnji tokeni, bez dodatnog CSS-a', () => {
  assert.deepEqual(deriveTheme({}), DEFAULT_TOKENS);
  assert.deepEqual(deriveTheme({ brandColor: null, menuColor: null }), DEFAULT_TOKENS);
  assert.deepEqual(deriveTheme({ brandColor: DEFAULT_BRAND_COLOR.toUpperCase(), menuColor: DEFAULT_MENU_COLOR }), DEFAULT_TOKENS);
  assert.equal(companyColorsCss({}), '');
  assert.equal(companyColorsCss({ brandColor: DEFAULT_BRAND_COLOR, menuColor: null }), '');
});

test('CSS: samo promijenjena skupina, obje teme, specifičnost iznad globals.css', () => {
  const onlyBrand = companyColorsCss({ brandColor: '#2563eb' });
  assert.match(onlyBrand, /^html:root\{--color-brand:#[0-9a-f]{6};/);
  assert.match(onlyBrand, /html\[data-theme='dark'\]\{--color-brand:/);
  assert.ok(!onlyBrand.includes('--color-nav'));
  const both = companyColorsCss({ brandColor: '#2563eb', menuColor: '#f1f5f9' });
  assert.ok(both.includes('--color-nav-fg-strong:'));
  assert.ok(!/[<>]/.test(both), 'CSS ne smije sadržavati znakove koji zatvaraju <style>');
});

test('kontrast naglaska: tekst na podlogama ≥ 4.5, bijelo na ispuni ≥ 4.5 (obje teme)', () => {
  for (const c of SAMPLES) {
    const t = deriveTheme({ brandColor: c });
    for (const th of ['light', 'dark'] as const) {
      const k = t[th];
      const s = SURFACES[th];
      for (const bg of [s.panel, s.panel2, s.canvas, s.muted, k.brandSoft]) {
        assert.ok(contrast(k.brand, bg) >= 4.5, `${c} ${th}: naglasak ${k.brand} na ${bg} = ${contrast(k.brand, bg).toFixed(2)}`);
      }
      assert.ok(contrast('#ffffff', k.brandSolid) >= 4.5, `${c} ${th}: bijelo na ${k.brandSolid}`);
      assert.ok(contrast('#ffffff', k.brandSolidStrong) >= 4.5, `${c} ${th}: bijelo na ${k.brandSolidStrong}`);
      // hover poveznice ostaje čitljiv
      assert.ok(contrast(k.brandStrong, s.panel) >= 4.5, `${c} ${th}: brand-strong`);
      // ton je blag: blizu panela
      assert.ok(contrast(k.brandSoft, s.panel) < 2, `${c} ${th}: brand-soft ${k.brandSoft} nije blag`);
    }
    // svijetla tema: bg-brand + bijeli tekst (aktivna stavka izbornika, čipovi) koristi brand izravno
    assert.ok(contrast('#ffffff', t.light.brand) >= 4.5, `${c}: bijelo na naglasku`);
  }
});

test('kontrast izbornika: nav-fg ≥ 7 kad je moguće (nikad < 4.5), nav-fg-2 ≥ 3, hover čitljiv', () => {
  for (const c of SAMPLES) {
    const t = deriveTheme({ menuColor: c });
    for (const th of ['light', 'dark'] as const) {
      const k = t[th];
      const best = Math.max(contrast('#ffffff', k.nav), contrast('#000000', k.nav));
      const fg = contrast(k.navFg, k.nav);
      assert.ok(fg >= 4.5, `${c} ${th}: nav-fg ${fg.toFixed(2)}`);
      if (best >= 7.5) assert.ok(fg >= 7, `${c} ${th}: nav-fg ${fg.toFixed(2)} (moguće ${best.toFixed(2)})`);
      assert.ok(contrast(k.navFg2, k.nav) >= 3, `${c} ${th}: nav-fg-2`);
      assert.ok(contrast(k.navFgStrong, k.nav) >= 4.5, `${c} ${th}: nav-fg-strong`);
      assert.ok(contrast(k.navFgStrong, k.nav2) >= 4.5, `${c} ${th}: nav-fg-strong na nav-2`);
      assert.ok(contrast(k.navFg, k.nav2) >= 4.5, `${c} ${th}: nav-fg na nav-2`);
    }
    // tamna tema: izbornik je uvijek taman, sa svijetlim tekstom
    assert.equal(t.dark.navFgStrong, '#ffffff', `${c}: tamna tema`);
  }
});

test('svijetla boja izbornika dobiva taman tekst, tamna svijetao', () => {
  for (const c of ['#f1f5f9', '#ffffff', '#ffff00', '#e0f2f1']) {
    const k = deriveTheme({ menuColor: c }).light;
    assert.equal(k.nav, c);
    assert.ok(luminance(k.navFg) < 0.2 && luminance(k.navFgStrong) < 0.05, `${c}: tekst ${k.navFg} treba biti taman`);
  }
  for (const c of ['#000000', '#172033', '#2a1116']) assert.equal(deriveTheme({ menuColor: c }).light.navFgStrong, '#ffffff');
});

test('uvoz sigurnosne kopije: boje firme se čiste', () => {
  assert.deepEqual(pickColors(sanitizeCompanySettings({ brandColor: '#2563EB', menuColor: '#f1f5f9' }).company), { brandColor: '#2563eb', menuColor: '#f1f5f9' });
  const bad = sanitizeCompanySettings({ brandColor: 'red;}body{display:none', menuColor: null });
  assert.equal(bad.company.brandColor, undefined);
  assert.equal(bad.company.menuColor, null);
  assert.ok(bad.notes.some((n) => n.includes('Boja')));
  // zadana boja iz datoteke → null
  assert.equal(sanitizeCompanySettings({ brandColor: DEFAULT_BRAND_COLOR }).company.brandColor, null);
  const plan = backupToPlan({ format: 'erp-wms-backup', version: 1, company: { name: 'K', brandColor: '#7C3AED', menuColor: 'x' } });
  assert.equal(plan.company.brandColor, '#7c3aed');
  assert.equal(plan.company.menuColor, undefined);
});

const pickColors = (c: { brandColor?: string | null; menuColor?: string | null }) => ({ brandColor: c.brandColor, menuColor: c.menuColor });
