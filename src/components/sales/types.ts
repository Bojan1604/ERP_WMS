/** Oblici podataka koje poslužitelj šalje editorima računa i ponude (obični objekti). */

export type LineKindCode = 'DEVICE' | 'MODEL' | 'SERVICE' | 'MANUAL';

export interface EditorLine {
  key: string;
  kind: LineKindCode;
  itemId?: string | null;
  modelId?: string | null;
  serviceId?: string | null;
  description: string;
  unit: string;
  kpd: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  warrantyMonths: number | null;
  agreedPrice: boolean;
  /** Najam: mjesečna cijena i broj mjeseci (samo se čuva). */
  monthly?: number | null;
  months?: number | null;
  /** Samo za prikaz. */
  serial?: string | null;
  cost?: number | null;
}

export interface PartnerOpt {
  id: string;
  name: string;
  city: string | null;
  country: string;
  note: string | null;
  paymentTermDays: number | null;
  excluded: boolean;
}

export interface ServiceOpt {
  id: string;
  name: string;
  unit: string;
  price: number;
  kpd: string | null;
}

export interface ModelOpt {
  id: string;
  brand: string | null;
  name: string;
  categoryId: string | null;
  salePrice: number | null;
  warrantyMonths: number | null;
  kpd: string | null;
}

export interface NamedOpt {
  id: string;
  name: string;
}

export interface CompanyDefaults {
  vatRegistered: boolean;
  vatRate: number;
  country: string;
  paymentTermDays: number;
  quoteValidDays: number;
  defaultWarrantyMonths: number;
  defaultMarginPct: number;
}

export interface SalesLookups {
  partners: PartnerOpt[];
  services: ServiceOpt[];
  models: ModelOpt[];
  categories: NamedOpt[];
  warehouses: NamedOpt[];
  company: CompanyDefaults;
}

/** Uređaj iz birača (isti oblik kao `DeviceOption` na poslužitelju). */
export interface DeviceOpt {
  id: string;
  serial: string;
  modelId: string;
  model: string;
  category: string | null;
  warehouse: string | null;
  state: string;
  status: string;
  cost: number;
  price: number;
  priceSource: 'agreed' | 'model' | 'margin';
  modelPrice: number | null;
  margin: number | null;
  warrantyMonths: number;
  kpd: string | null;
}

export type ChargeKind = 'N' | 'POVNAK' | 'PP' | 'PPMV';
export interface EditorCharge {
  kind: ChargeKind;
  label: string;
  amount: number | null;
  pct: number | null;
}

export const modelName = (m: { brand?: string | null; name: string }) => [m.brand, m.name].filter(Boolean).join(' ');
