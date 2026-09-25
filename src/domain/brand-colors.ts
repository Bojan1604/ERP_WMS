/**
 * Boje firme: naglasak (gumbi, poveznice, oznake) i boja lijevog izbornika.
 *
 * Iz dvije odabrane boje izvode se sve CSS varijable teme (--color-brand*, --color-nav*)
 * za svijetlu i tamnu temu, uz zajamčen kontrast (WCAG 2):
 *   - naglasak kao tekst na podlozi (panel, panel-2, platno, muted, brand-soft) ≥ 4.5
 *     (svijetla tema: potamni se po potrebi; tamna tema: posvijetli se po potrebi),
 *   - bijeli tekst na ispuni naglaska (brand-solid, u svijetloj temi i brand) ≥ 4.5,
 *   - tekst izbornika (nav-fg) na izborniku ≥ 7 (cilj 8.5) kad je moguće, nikad ispod 4.5;
 *     svijetla boja izbornika dobiva taman tekst, tamna svijetao,
 *   - prigušeni tekst izbornika (nav-fg-2) ≥ 3 (≥ 4.5 kad izbornik to dopušta).
 * Bez odabira (null) ili sa zadanom bojom vrijede točno današnje vrijednosti iz globals.css.
 * Čisto: bez baze i Reacta — isti izračun koristi i pregled u pregledniku.
 */

export const DEFAULT_BRAND_COLOR = '#0d7776';
export const DEFAULT_MENU_COLOR = '#15201d';

export interface BrandTokens {
  brand: string;
  brandStrong: string;
  brandSoft: string;
  brandSolid: string;
  brandSolidStrong: string;
}
export interface NavTokens {
  nav: string;
  nav2: string;
  navFg: string;
  navFg2: string;
  /** Naglašeni tekst na izborniku (naslov, hover) — u zadanoj temi bijela. */
  navFgStrong: string;
}
export type ThemeTokens = BrandTokens & NavTokens;
export type ThemeName = 'light' | 'dark';

/** Današnje vrijednosti iz globals.css (tamna tema ne mijenja nav-fg / nav-fg-2). */
export const DEFAULT_TOKENS: Record<ThemeName, ThemeTokens> = {
  light: {
    brand: '#0d7776', brandStrong: '#0a6463', brandSoft: '#e0f2f1', brandSolid: '#0d7776', brandSolidStrong: '#0a6463',
    nav: '#15201d', nav2: '#1f2c28', navFg: '#c9d4cf', navFg2: '#86958f', navFgStrong: '#ffffff',
  },
  dark: {
    brand: '#2bb3a8', brandStrong: '#4cc9be', brandSoft: '#123331', brandSolid: '#1f827a', brandSolidStrong: '#196b64',
    nav: '#0b100f', nav2: '#151d1b', navFg: '#c9d4cf', navFg2: '#86958f', navFgStrong: '#ffffff',
  },
};

/** Podloge na kojima se naglasak pojavljuje kao tekst (globals.css). */
export const SURFACES: Record<ThemeName, { panel: string; panel2: string; canvas: string; muted: string }> = {
  light: { panel: '#ffffff', panel2: '#f9faf8', canvas: '#f4f5f2', muted: '#eef0ec' },
  dark: { panel: '#161d1b', panel2: '#1a2220', canvas: '#0f1413', muted: '#212a27' },
};

/** CSS varijabla za svaki token. */
export const TOKEN_VARS: Record<keyof ThemeTokens, string> = {
  brand: '--color-brand',
  brandStrong: '--color-brand-strong',
  brandSoft: '--color-brand-soft',
  brandSolid: '--color-brand-solid',
  brandSolidStrong: '--color-brand-solid-strong',
  nav: '--color-nav',
  nav2: '--color-nav-2',
  navFg: '--color-nav-fg',
  navFg2: '--color-nav-fg-2',
  navFgStrong: '--color-nav-fg-strong',
};
const BRAND_KEYS = ['brand', 'brandStrong', 'brandSoft', 'brandSolid', 'brandSolidStrong'] as const;
const NAV_KEYS = ['nav', 'nav2', 'navFg', 'navFg2', 'navFgStrong'] as const;

/** Gotove kombinacije (naglasak + izbornik) za brzi odabir. */
export const COLOR_PRESETS: { name: string; brand: string; menu: string }[] = [
  { name: 'Tirkizna (zadano)', brand: DEFAULT_BRAND_COLOR, menu: DEFAULT_MENU_COLOR },
  { name: 'Plava', brand: '#2563eb', menu: '#172033' },
  { name: 'Tamnoplava', brand: '#1e40af', menu: '#0f1a3a' },
  { name: 'Ljubičasta', brand: '#7c3aed', menu: '#1e1633' },
  { name: 'Bordo', brand: '#b91c3c', menu: '#2a1116' },
  { name: 'Narančasta', brand: '#ea580c', menu: '#231a14' },
  { name: 'Antracit', brand: '#475569', menu: '#1f2328' },
  { name: 'Zelena', brand: '#15803d', menu: '#132218' },
];

// ---------------------------------------------------------------- osnovne operacije nad bojama

const HEX_RE = /^#[0-9a-f]{6}$/;

/** Ispravna boja oblika #rrggbb (mala ili velika slova). */
export const isHexColor = (v: unknown): v is string => typeof v === 'string' && HEX_RE.test(v.trim().toLowerCase());

/** „#ABC", „abc", „#AABBCC" → „#aabbcc"; sve ostalo → null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (!s.startsWith('#')) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX_RE.test(s) ? s : null;
}

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

/** Relativna svjetlina (WCAG 2). */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Omjer kontrasta dviju boja (1–21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** `t` boje `a` pomiješano s `(1 − t)` boje `b`. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex(x.map((c, i) => c * t + y[i] * (1 - t)) as Rgb);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** Ista nijansa i zasićenje, drugačija svjetlina (0–1). */
const withLightness = (hex: string, l: number) => {
  const [h, s] = toHsl(hex);
  return fromHsl(h, s, Math.min(1, Math.max(0, l)));
};
const shiftLightness = (hex: string, d: number) => withLightness(hex, toHsl(hex)[2] + d);

/**
 * Najmanja promjena svjetline (tamnije ili svjetlije) uz koju boja zadovoljava `ok`.
 * Svjetlina je u HSL-u monotona po kanalima, pa je binarno pretraživanje sigurno;
 * zaokruživanje na #rrggbb se provjerava, a krajnja pričuva je crna / bijela.
 */
function adjustUntil(hex: string, dir: 'darken' | 'lighten', ok: (c: string) => boolean): string {
  if (ok(hex)) return hex;
  const l0 = toHsl(hex)[2];
  let good = dir === 'darken' ? 0 : 1;
  let bad = l0;
  for (let i = 0; i < 24; i++) {
    const mid = (good + bad) / 2;
    if (ok(withLightness(hex, mid))) good = mid;
    else bad = mid;
  }
  for (let i = 0; i < 40; i++) {
    const c = withLightness(hex, good);
    if (ok(c)) return c;
    good += dir === 'darken' ? -0.005 : 0.005;
  }
  return dir === 'darken' ? '#000000' : '#ffffff';
}

const minContrast = (c: string, bgs: string[]) => Math.min(...bgs.map((b) => contrast(c, b)));

// ---------------------------------------------------------------- izvođenje tokena

/** Tokeni naglaska za temu. Zadana (ili nikakva) boja → točno današnje vrijednosti. */
export function brandTokens(color: string | null | undefined, theme: ThemeName): BrandTokens {
  const accent = normalizeHex(color);
  const d = DEFAULT_TOKENS[theme];
  if (!accent || accent === DEFAULT_BRAND_COLOR) return pick(d, BRAND_KEYS);
  const sf = SURFACES[theme];
  const surfaces = [sf.panel, sf.panel2, sf.canvas, sf.muted];

  if (theme === 'light') {
    // blagi ton naglaska preko panela; kad je naglasak vrlo svijetao (žuta), ton se uzima od potamnjene boje
    const readable = adjustUntil(accent, 'darken', (c) => minContrast(c, surfaces) >= 4.5);
    let soft = mix(accent, sf.panel, 0.12);
    if (contrast(soft, sf.panel) < 1.08) soft = mix(readable, sf.panel, 0.14);
    // naglasak je tekst na podlogama i tonu te ispuna ispod bijelog teksta (bijela = panel)
    const brand = adjustUntil(readable, 'darken', (c) => minContrast(c, [...surfaces, soft]) >= 4.5);
    const brandStrong = shiftLightness(brand, -0.06);
    return { brand, brandStrong, brandSoft: soft, brandSolid: brand, brandSolidStrong: brandStrong };
  }

  // tamna tema: ton naglaska preko tamnog panela, svijetao naglasak za tekst, tamnija ispuna za bijeli tekst
  // ton ostaje blag (kontrast prema panelu ≤ 1.6) — vrlo svijetao naglasak se miješa u manjem udjelu
  let soft = mix(accent, sf.panel, 0.24);
  for (let t = 0.22; t > 0.04 && contrast(soft, sf.panel) > 1.6; t -= 0.02) soft = mix(accent, sf.panel, t);
  const brand = adjustUntil(accent, 'lighten', (c) => minContrast(c, [...surfaces, soft]) >= 4.5);
  const brandStrong = shiftLightness(brand, 0.08);
  const brandSolid = adjustUntil(accent, 'darken', (c) => contrast(c, '#ffffff') >= 4.5);
  const brandSolidStrong = shiftLightness(brandSolid, -0.06);
  return { brand, brandStrong, brandSoft: soft, brandSolid, brandSolidStrong };
}

/** Tokeni izbornika za temu. Svijetla boja izbornika dobiva taman tekst. */
export function navTokens(color: string | null | undefined, theme: ThemeName): NavTokens {
  const menu = normalizeHex(color);
  if (!menu || menu === DEFAULT_MENU_COLOR) return pick(DEFAULT_TOKENS[theme], NAV_KEYS);
  // u tamnoj temi izbornik ostaje taman: ista nijansa, svjetlina ≤ 10 % (kao zadano #15201d → #0b100f)
  const [h, s, l] = toHsl(menu);
  const nav = theme === 'dark' ? fromHsl(h, s, Math.min(l * 0.5, 0.1)) : menu;

  // strana teksta: bijela ili taman ton iste nijanse (ako nema dovoljno kontrasta — crna)
  const lightText = contrast('#ffffff', nav) >= contrast('#000000', nav);
  let strong = '#ffffff';
  if (!lightText) {
    strong = fromHsl(h, Math.min(s, 0.3), 0.1);
    if (contrast(strong, nav) < 7) strong = '#000000';
  }
  const top = contrast(strong, nav);
  // tekst izbornika: blago prema boji izbornika uz kontrast ≥ 8.5 (zadano ~11; nikad ispod 7 kad je moguće)
  const navFg = mixToward(strong, nav, (c) => contrast(c, nav) >= Math.min(8.5, top), 0.3);
  // prigušeni tekst (naslovi grupa, ikone): ≥ 5 kad izbornik dopušta, inače ≥ 3
  const target2 = Math.min(5, Math.max(3, top * 0.6));
  const navFg2 = mixToward(strong, nav, (c) => contrast(c, nav) >= target2, 0.7);

  // podloga pod mišem: malo prema tekstu (kao zadano); ako to kvari čitljivost — od teksta
  const away = lightText ? '#000000' : '#ffffff';
  let nav2 = mix(strong, nav, 0.07);
  if (contrast(strong, nav2) < 4.5 || contrast(navFg, nav2) < 4.5) nav2 = mix(away, nav, 0.07);
  return { nav, nav2, navFg, navFg2, navFgStrong: strong };
}

/** Najveći udio boje izbornika (do `max`) pomiješan u tekst, uz koji vrijedi `ok`. */
function mixToward(text: string, bg: string, ok: (c: string) => boolean, max: number): string {
  let best = text;
  for (let t = 0.01; t <= max + 1e-9; t += 0.01) {
    const c = mix(bg, text, t);
    if (!ok(c)) break;
    best = c;
  }
  return best;
}

function pick<K extends keyof ThemeTokens>(t: ThemeTokens, keys: readonly K[]): Pick<ThemeTokens, K> {
  return Object.fromEntries(keys.map((k) => [k, t[k]])) as Pick<ThemeTokens, K>;
}

export interface CompanyColors {
  brandColor?: string | null;
  menuColor?: string | null;
}

/** Svi tokeni za obje teme. */
export function deriveTheme(c: CompanyColors): Record<ThemeName, ThemeTokens> {
  return {
    light: { ...brandTokens(c.brandColor, 'light'), ...navTokens(c.menuColor, 'light') },
    dark: { ...brandTokens(c.brandColor, 'dark'), ...navTokens(c.menuColor, 'dark') },
  };
}

/** Boja za spremanje: ispravan #rrggbb ili null (zadana boja se sprema kao null). */
export function storedColor(v: unknown, fallback: string): string | null {
  const hex = normalizeHex(v);
  return !hex || hex === fallback ? null : hex;
}

/**
 * CSS s varijablama teme za firmu; prazno kad firma koristi zadane boje.
 * Selektori `html:root` / `html[data-theme='dark']` imaju veću specifičnost od
 * `:root` (@theme) i `[data-theme='dark']` u globals.css, pa redoslijed učitavanja nije bitan.
 */
export function companyColorsCss(c: CompanyColors): string {
  const brand = !!storedColor(c.brandColor, DEFAULT_BRAND_COLOR);
  const nav = !!storedColor(c.menuColor, DEFAULT_MENU_COLOR);
  if (!brand && !nav) return '';
  const keys = [...(brand ? BRAND_KEYS : []), ...(nav ? NAV_KEYS : [])];
  const t = deriveTheme(c);
  const block = (sel: string, tokens: ThemeTokens) => `${sel}{${keys.map((k) => `${TOKEN_VARS[k]}:${tokens[k]}`).join(';')}}`;
  return block('html:root', t.light) + block("html[data-theme='dark']", t.dark);
}

/** Varijable kao objekt stila (pregled u postavkama). */
export function tokenStyle(t: ThemeTokens): Record<string, string> {
  return Object.fromEntries((Object.keys(TOKEN_VARS) as (keyof ThemeTokens)[]).map((k) => [TOKEN_VARS[k], t[k]]));
}
