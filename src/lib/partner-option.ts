import type { ComboOption } from '@/components/ui/combobox';

/** Partner u odabiru (editori, filtri) — dovoljno za PDV tretman, rok plaćanja i napomenu. */
export interface PartnerOpt {
  id: string;
  name: string;
  city: string | null;
  country: string;
  note: string | null;
  paymentTermDays: number | null;
  excluded: boolean;
  /** Ručna PDV kategorija partnera (nadjačava izvedenu iz države). */
  vatCategoryOverride?: string | null;
}

/** Partneri koje odabir nudi: kupci, dobavljači, svi, ili partneri troškova (dobavljači + već na troškovima). */
export type PartnerRole = 'customer' | 'supplier' | 'any' | 'expense';

export interface PartnerComboOption extends ComboOption {
  partner: PartnerOpt;
}

export const partnerHint = (p: Pick<PartnerOpt, 'city' | 'country' | 'excluded'>) =>
  [p.city, p.country !== 'HR' ? p.country : null, p.excluded ? 'isključen' : null].filter(Boolean).join(', ') || undefined;

export const toPartnerOption = (p: PartnerOpt): PartnerComboOption => ({ value: p.id, label: p.name, hint: partnerHint(p), partner: p });
