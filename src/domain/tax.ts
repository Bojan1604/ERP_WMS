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
  /** UNCL5305 kategorija za eRačun: S standard, AE prijenos obveze, G izvoz, O izvan sustava. */
  category: 'S' | 'AE' | 'G' | 'O' | 'E' | 'K';
  label: string;
  exemptReason?: string;
}

export function customerVat(
  country: string | null | undefined,
  company: { vatRegistered: boolean; vatRate: number; country?: string },
): VatTreatment {
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
