/** Porezni tretman prema državi druge strane. */
export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE',
  'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
]);

export type Region = 'DOMESTIC' | 'EU' | 'NON_EU';

export function regionOf(country: string | null | undefined, home = 'HR'): Region {
  const c = (country || home).toUpperCase();
  if (c === home.toUpperCase()) return 'DOMESTIC';
  return EU_COUNTRIES.has(c) ? 'EU' : 'NON_EU';
}

export interface VatTreatment {
  rate: number;
  /** UNCL5305 kategorija za eRačun: S standard, AE prijenos obveze, G izvoz, O izvan sustava, Z nulta stopa. */
  category: 'S' | 'AE' | 'G' | 'O' | 'E' | 'K' | 'Z';
  label: string;
  exemptReason?: string;
}

/** Ručne PDV kategorije partnera (Partner.vatCategoryOverride) — nadjačavaju izvedenu iz države. */
export const VAT_OVERRIDES = ['S', 'AE', 'E', 'Z', 'O'] as const;
export type VatOverride = (typeof VAT_OVERRIDES)[number];

export const VAT_OVERRIDE_LABEL: Record<VatOverride, string> = {
  S: 'S — standardna stopa',
  AE: 'AE — prijenos porezne obveze',
  E: 'E — oslobođeno PDV-a',
  Z: 'Z — nulta stopa',
  O: 'O — nije predmet PDV-a (mjesto oporezivanja izvan RH)',
};

const OVERRIDE_REASON: Record<Exclude<VatOverride, 'S'>, string> = {
  AE: 'Prijenos porezne obveze — čl. 17. st. 1. Zakona o PDV-u',
  E: 'Oslobođeno PDV-a',
  Z: '',
  O: 'Nije predmet oporezivanja PDV-om u RH — mjesto oporezivanja izvan RH',
};

export const isVatOverride = (v: unknown): v is VatOverride => typeof v === 'string' && (VAT_OVERRIDES as readonly string[]).includes(v);

/** Kupac za porezni tretman: samo država ili partner (država + ručna kategorija). */
export type VatParty = string | null | undefined | { country?: string | null; vatCategoryOverride?: string | null };

/**
 * Porezni tretman kupca. Ručna kategorija partnera (C8) ima prednost pred
 * izvedenom iz države — osim standardne stope kad firma nije u sustavu PDV-a.
 * Pozivatelji s partnerom predaju cijeli partner (`customerVat(partner, firma)`).
 */
export function customerVat(
  party: VatParty,
  company: { vatRegistered: boolean; vatRate: number; country?: string },
): VatTreatment {
  const obj = typeof party === 'object' && party !== null ? party : null;
  const country = obj ? obj.country : (party as string | null | undefined);
  const override = obj && isVatOverride(obj.vatCategoryOverride) ? obj.vatCategoryOverride : null;
  if (override && !(override === 'S' && !company.vatRegistered)) {
    if (override === 'S') return { rate: company.vatRate, category: 'S', label: `PDV ${company.vatRate} % (ručno)` };
    const reason = OVERRIDE_REASON[override];
    return { rate: 0, category: override, label: `${VAT_OVERRIDE_LABEL[override]} (ručno)`, ...(reason ? { exemptReason: reason } : {}) };
  }
  if (!company.vatRegistered) {
    return { rate: 0, category: 'O', label: 'Nije u sustavu PDV-a', exemptReason: 'Obveznik nije u sustavu PDV-a (čl. 90. st. 1. Zakona o PDV-u)' };
  }
  switch (regionOf(country, company.country)) {
    case 'DOMESTIC':
      return { rate: company.vatRate, category: 'S', label: `PDV ${company.vatRate} %` };
    case 'EU':
      return { rate: 0, category: 'K', label: 'EU — prijenos porezne obveze', exemptReason: 'Oslobođeno PDV-a — isporuka unutar EU (čl. 41. Zakona o PDV-u)' };
    default:
      return { rate: 0, category: 'G', label: 'Izvoz izvan EU — bez PDV-a', exemptReason: 'Oslobođeno PDV-a — izvoz (čl. 45. Zakona o PDV-u)' };
  }
}

export function supplierVat(country: string | null | undefined, company: { vatRate: number; country?: string }) {
  switch (regionOf(country, company.country)) {
    case 'DOMESTIC':
      return { rate: company.vatRate, label: `PDV ${company.vatRate} %` };
    case 'EU':
      return { rate: 0, label: 'EU — prijenos porezne obveze' };
    default:
      return { rate: 0, label: 'Uvoz — PDV pri carinjenju' };
  }
}

/** Provjera OIB-a (ISO 7064, MOD 11,10). */
export function isValidOib(oib: string | null | undefined): boolean {
  const s = String(oib ?? '').trim();
  if (!/^\d{11}$/.test(s)) return false;
  let a = 10;
  for (let i = 0; i < 10; i++) {
    a = (a + Number(s[i])) % 10;
    if (a === 0) a = 10;
    a = (a * 2) % 11;
  }
  const check = (11 - a) % 10;
  return check === Number(s[10]);
}

// ---------------------------------------------------------------- tekstovi oslobođenja (F9)

/** Vrsta isporuke za tekst oslobođenja: roba (prodaja) ili usluga (najam, servis). */
export type ExemptKind = 'goods' | 'service';

/** Zadani tekstovi oslobođenja PDV-a za strane kupce (kad firma ne upiše vlastite). */
export const EXEMPT_DEFAULTS = {
  euGoods: 'PDV nije obračunat prema čl. 41. st. 1. Zakona o PDV-u',
  euService: 'PDV nije obračunat prema čl. 17. st. 1. Zakona o PDV-u - reverse charge',
  thirdGoods: 'PDV nije obračunat prema čl. 45. st. 1. Zakona o PDV-u',
  thirdService: 'PDV nije obračunat prema čl. 17. st. 1. Zakona o PDV-u',
} as const;

export interface ExemptTexts {
  vatTextEuGoods?: string | null;
  vatTextEuService?: string | null;
  vatTextThirdGoods?: string | null;
  vatTextThirdService?: string | null;
}

/**
 * Tekst oslobođenja PDV-a na dokumentu: vlastiti tekst firme (Postavke → Firma)
 * ili zadani. Domaći kupac nema teksta (null). Vrsta računa/stavke: prodaja → roba,
 * najam i usluge → usluga (na miješanom računu svaka stavka ima svoj tekst).
 */
export function exemptText(company: ExemptTexts, region: Region, kind: ExemptKind | 'SALE' | 'RENT' | 'SERVICE'): string | null {
  if (region === 'DOMESTIC') return null;
  const goods = kind === 'goods' || kind === 'SALE';
  const eu = region === 'EU';
  const own = eu ? (goods ? company.vatTextEuGoods : company.vatTextEuService) : goods ? company.vatTextThirdGoods : company.vatTextThirdService;
  const fallback = eu ? (goods ? EXEMPT_DEFAULTS.euGoods : EXEMPT_DEFAULTS.euService) : goods ? EXEMPT_DEFAULTS.thirdGoods : EXEMPT_DEFAULTS.thirdService;
  return own?.trim() || fallback;
}
