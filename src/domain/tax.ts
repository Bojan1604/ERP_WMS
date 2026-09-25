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
/**
 * PDV po naplaćenoj naknadi (Company.vatOnPayment): napomena na računu (ispis, PDF,
 * napomena eRačuna) — tekst kao u starom programu (invoiceDoc.js) — i oznaka u
 * HR proširenju eRačuna (HRObracunPDVPoNaplati, stari eracun.js).
 */
export const VAT_ON_PAYMENT_NOTE = 'Obračun PDV-a prema naplaćenim naknadama.';
export const VAT_ON_PAYMENT_UBL = 'Obračun po naplaćenoj naknadi';

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

/** Firma izvan sustava PDV-a (mali porezni obveznik): jedna osnova na računu, ispisu i u eRačunu. */
export const NOT_REGISTERED_REASON = 'Nije u sustavu PDV-a — čl. 90. st. 2. Zakona o PDV-u';
/** Rečenica na ispisu računa firme izvan sustava PDV-a (stari invoiceDoc.js). */
export const NOT_REGISTERED_NOTE = 'Izdavatelj nije u sustavu PDV-a (čl. 90. st. 2. Zakona o PDV-u).';

/**
 * Napomene o PDV-u na ispisu računa (PDF i pregled): razlog oslobođenja i, za firmu
 * izvan sustava PDV-a, jedna osnova (čl. 90. st. 2.) — stariji upisani razlog s
 * čl. 90. se ne ispisuje dvaput (ni s drugom osnovom).
 */
export function taxNotes(inv: { taxCategory: string; taxExemptReason: string | null }, vatRegistered: boolean | undefined): string[] {
  const reason = inv.taxCategory !== 'S' ? inv.taxExemptReason?.trim() || null : null;
  if (vatRegistered !== false) return reason ? [reason] : [];
  return [...(reason && !/čl\.\s*90\./.test(reason) ? [reason] : []), NOT_REGISTERED_NOTE];
}

/** Firma za porezni tretman: sustav PDV-a, stopa, država i vlastiti tekstovi oslobođenja. */
export type VatCompany = { vatRegistered: boolean; vatRate: number; country?: string } & ExemptTexts;

/**
 * Porezni tretman kupca. Ručna kategorija partnera (C8) ima prednost pred
 * izvedenom iz države — osim standardne stope kad firma nije u sustavu PDV-a.
 * Pozivatelji s partnerom predaju cijeli partner (`customerVat(partner, firma, vrsta)`).
 *
 * Strani kupac — prema vrsti isporuke (kao stari eracun.js `taxTreatment`):
 *   EU:        roba (prodaja) → K, čl. 41.; usluga (najam, servis) → AE, čl. 17. (reverse charge)
 *   treća zemlja: roba → G (izvoz), čl. 45.; usluga → E s tekstom čl. 17.
 * Tekst oslobođenja je vlastiti tekst firme (Postavke → Firma) ili zadani (`exemptText`).
 */
export function customerVat(party: VatParty, company: VatCompany, kind: SupplyKind = 'SALE'): VatTreatment {
  const obj = typeof party === 'object' && party !== null ? party : null;
  const country = obj ? obj.country : (party as string | null | undefined);
  const override = obj && isVatOverride(obj.vatCategoryOverride) ? obj.vatCategoryOverride : null;
  if (override && !(override === 'S' && !company.vatRegistered)) {
    if (override === 'S') return { rate: company.vatRate, category: 'S', label: `PDV ${company.vatRate} % (ručno)` };
    const reason = OVERRIDE_REASON[override];
    return { rate: 0, category: override, label: `${VAT_OVERRIDE_LABEL[override]} (ručno)`, ...(reason ? { exemptReason: reason } : {}) };
  }
  if (!company.vatRegistered) {
    return { rate: 0, category: 'O', label: 'Nije u sustavu PDV-a', exemptReason: NOT_REGISTERED_REASON };
  }
  const region = regionOf(country, company.country);
  const goods = kind === 'SALE';
  const exemptReason = exemptText(company, region, kind) ?? undefined;
  switch (region) {
    case 'DOMESTIC':
      return { rate: company.vatRate, category: 'S', label: `PDV ${company.vatRate} %` };
    case 'EU':
      return goods
        ? { rate: 0, category: 'K', label: 'EU — isporuka dobara unutar EU, bez PDV-a', exemptReason }
        : { rate: 0, category: 'AE', label: 'EU — usluga, prijenos porezne obveze', exemptReason };
    default:
      return goods
        ? { rate: 0, category: 'G', label: 'Izvoz izvan EU — bez PDV-a', exemptReason }
        : { rate: 0, category: 'E', label: 'Usluga kupcu izvan EU — bez PDV-a', exemptReason };
  }
}

/** Vrsta isporuke računa prema stavkama; MIXED = roba i usluga (najam/servis) na istom računu. */
export type SupplyKind = 'SALE' | 'RENT' | 'SERVICE';

/**
 * Vrsta isporuke računa: vrsta stavaka (stavka bez vlastite vrste prati račun).
 * Najam i servis su usluge — ako računa ima i robu i uslugu, vraća 'MIXED'.
 */
export function supplyKindOf(type: SupplyKind, lines: ReadonlyArray<{ lineType?: SupplyKind | null }>): SupplyKind | 'MIXED' {
  const kinds = new Set(lines.map((l) => l.lineType ?? type));
  if (!kinds.size) return type;
  const goods = kinds.has('SALE');
  const service = kinds.has('RENT') || kinds.has('SERVICE');
  if (goods && service) return 'MIXED';
  if (goods) return 'SALE';
  return kinds.has('RENT') ? 'RENT' : 'SERVICE';
}

/**
 * Miješani račun (roba + najam/usluga) stranom kupcu: roba i usluga imaju različit
 * porezni tretman (čl. 41./45. naspram čl. 17.), a račun ima jednu kategoriju i jedan
 * razlog oslobođenja (zbrojevi, ispis, eRačun) — takav se račun ne izdaje, nego se
 * dijeli na dva. Ne vrijedi uz standardnu stopu (S), ručnu kategoriju partnera ni za
 * firmu izvan sustava PDV-a (tada je tretman svih stavaka isti). Vraća poruku ili null.
 */
export function mixedSupplyError(party: VatParty, company: VatCompany, taxCategory: string | null | undefined, kind: SupplyKind | 'MIXED'): string | null {
  if (kind !== 'MIXED' || (taxCategory ?? 'S') === 'S' || !company.vatRegistered) return null;
  const obj = typeof party === 'object' && party !== null ? party : null;
  if (obj && isVatOverride(obj.vatCategoryOverride)) return null;
  const region = regionOf(obj ? obj.country : (party as string | null | undefined), company.country);
  if (region === 'DOMESTIC') return null;
  return region === 'EU'
    ? 'Kupac je iz EU: prodaja robe (čl. 41. Zakona o PDV-u) i najam/usluga (čl. 17. — prijenos porezne obveze) imaju različit porezni tretman. Izdajte ih na zasebnim računima.'
    : 'Kupac je izvan EU: izvoz robe (čl. 45. Zakona o PDV-u) i najam/usluga (čl. 17.) imaju različit razlog oslobođenja. Izdajte ih na zasebnim računima.';
}

/**
 * Tekstovi koje program sam upisuje kao razlog oslobođenja za stranog kupca (zadani,
 * vlastiti tekstovi firme i stariji zadani tekstovi) — takav razlog se smije
 * zamijeniti ispravnim za vrstu računa; ručno upisan razlog se ne dira.
 */
function automaticReasons(company: ExemptTexts): Set<string> {
  return new Set(
    [
      ...Object.values(EXEMPT_DEFAULTS),
      company.vatTextEuGoods,
      company.vatTextEuService,
      company.vatTextThirdGoods,
      company.vatTextThirdService,
      'Oslobođeno PDV-a — isporuka unutar EU (čl. 41. Zakona o PDV-u)',
      'Oslobođeno PDV-a — izvoz (čl. 45. Zakona o PDV-u)',
    ]
      .map((t) => (t ?? '').trim())
      .filter(Boolean),
  );
}

/**
 * Porezna kategorija i razlog oslobođenja nacrta računa usklađeni s vrstom računa:
 * ako su upisani automatski za stranog kupca (izvedena kategorija K/G/AE/E i
 * automatski tekst ili prazno), zamjenjuju se tretmanom za stvarnu vrstu isporuke
 * (npr. najam kupcu u EU: AE i čl. 17. umjesto K i čl. 41.). Ručni izbor ostaje.
 */
export function alignInvoiceVat(
  party: VatParty,
  company: VatCompany,
  kind: SupplyKind | 'MIXED',
  cur: { taxCategory: string; taxExemptReason: string | null },
): { taxCategory: string; taxExemptReason: string | null } {
  if (kind === 'MIXED') return cur;
  const want = customerVat(party, company, kind);
  if (want.category === 'S' || (want.category === cur.taxCategory && (want.exemptReason ?? '') === (cur.taxExemptReason ?? ''))) return cur;
  const auto = ['K', 'G', 'AE', 'E'].includes(cur.taxCategory) && (!cur.taxExemptReason?.trim() || automaticReasons(company).has(cur.taxExemptReason.trim()));
  // samo kad je i željeni tretman izveden iz države (ne ručna kategorija partnera)
  const derived = !(typeof party === 'object' && party !== null && isVatOverride(party.vatCategoryOverride)) && company.vatRegistered;
  return auto && derived ? { taxCategory: want.category, taxExemptReason: want.exemptReason ?? null } : cur;
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
