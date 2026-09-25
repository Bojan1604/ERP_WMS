/**
 * Zajednički kontekst pretvorbe stare baze: plan koji se puni, upozorenja,
 * brojevi dokumenata, mape starih id-eva i pomoćnici za brojeve i datume.
 */
import type { StatusKind } from '@prisma/client';
import { DocNumbers, Warnings, type ImportPlan, type Key, type PlanInvoice, type PlanItem } from './plan';
import { INVALID, parseLegacyDate, parseLegacyTimestamp } from './legacy-parse';
import { r2 } from '@/domain/money';

export class LegacyCtx {
  readonly w: Warnings;
  readonly numbers = new DocNumbers();
  /** stari id → ključ u planu (duplikati šifrarnika se spajaju u prvi zapis) */
  readonly warehouses = new Map<string, Key>();
  readonly categories = new Map<string, Key>();
  readonly models = new Map<string, Key>();
  readonly statuses = new Map<string, { key: Key; kind: StatusKind; name: string }>();
  readonly services = new Map<string, Key>();
  readonly partners = new Map<string, Key>();
  readonly items = new Map<string, PlanItem>();
  readonly invoices = new Map<string, PlanInvoice>();
  readonly contracts = new Set<string>();
  readonly receipts = new Set<string>();
  readonly orders = new Set<string>();
  readonly userNames = new Map<string, string>();
  readonly expenseCategories = new Map<string, Key>(); // naziv (mala slova) → ključ
  /** ključ modela → „Proizvođač Model" (za opise stavki) */
  readonly modelLabels = new Map<Key, string>();
  /** ključ partnera → država (za poreznu kategoriju računa) */
  readonly partnerCountry = new Map<Key, string>();
  /** ključ usluge → naziv */
  readonly serviceNames = new Map<Key, string>();
  vatRegistered = true;
  private seq = 0;
  private placeholders = new Map<string, Key>();

  constructor(readonly plan: ImportPlan, readonly today: string) {
    this.w = new Warnings(plan);
  }

  /** Ključ za zapis bez id-a u staroj bazi. */
  genKey(entity: string): Key {
    return `gen:${entity}:${++this.seq}`;
  }

  /** Broj: prazno → zadano, nečitljivo → zadano uz upozorenje. */
  num(v: number | null | undefined, where: string, field: string, fallback: number): number;
  num(v: number | null | undefined, where: string, field: string, fallback: null): number | null;
  num(v: number | null | undefined, where: string, field: string, fallback: number | null): number | null {
    if (v === null || v === undefined) return fallback;
    if (Number.isNaN(v)) {
      this.w.warn('number', 'broj', `${where}: nečitljiv broj u polju „${field}" — upisano ${fallback ?? 'prazno'}.`);
      return fallback;
    }
    return v;
  }
  money(v: number | null | undefined, where: string, field: string, fallback: number): number;
  money(v: number | null | undefined, where: string, field: string, fallback: null): number | null;
  money(v: number | null | undefined, where: string, field: string, fallback: number | null): number | null {
    const n = this.num(v, where, field, fallback as number);
    return n === null ? null : r2(n);
  }
  /** Cijeli broj u rasponu ili null. */
  int(v: number | null | undefined, where: string, field: string, min: number, max: number): number | null {
    const n = this.num(v, where, field, null);
    if (n === null) return null;
    const i = Math.round(n);
    if (i < min || i > max) {
      this.w.warn('number', 'broj', `${where}: vrijednost ${n} u polju „${field}" je izvan raspona ${min}–${max} — izostavljeno.`);
      return null;
    }
    return i;
  }

  /** Datum ili null (nečitljiv uz upozorenje). */
  date(v: unknown, where: string, field: string): string | null {
    const d = parseLegacyDate(v);
    if (d === INVALID) {
      this.w.warn('date', 'datum', `${where}: nečitljiv datum „${String(v)}" u polju „${field}" — izostavljen.`);
      return null;
    }
    return d;
  }
  /** Obavezan datum: prvi čitljiv od ponuđenih, inače danas (uz upozorenje). */
  reqDate(where: string, field: string, ...values: unknown[]): string {
    for (const [i, v] of values.entries()) {
      const d = i === 0 ? this.date(v, where, field) : parseLegacyDate(v);
      if (d && d !== INVALID) return d;
    }
    this.w.warn('date-missing', 'datum', `${where}: nedostaje datum („${field}") — upisan današnji.`);
    return this.today;
  }
  ts(v: unknown): string | null {
    return parseLegacyTimestamp(v);
  }
  text(v: string | null | undefined): string | null {
    const s = (v ?? '').trim();
    return s ? s : null;
  }
  user(id: string | null | undefined): string | null {
    if (!id) return null;
    return this.userNames.get(id) ?? id;
  }

  /**
   * Zamjenski zapis za vezu koja pokazuje na nepostojeći zapis (partner, model…).
   * Stvara se jednom po vrsti.
   */
  placeholder(kind: 'customer' | 'supplier' | 'model' | 'warehouse', create: () => Key): Key {
    let k = this.placeholders.get(kind);
    if (!k) {
      k = create();
      this.placeholders.set(kind, k);
    }
    return k;
  }

  customerPlaceholder(): Key {
    return this.placeholder('customer', () => {
      const key = this.genKey('partner');
      this.plan.partners.push({
        key, name: 'Nepoznat kupac (uvoz)', oib: null, vatId: null, address: null, zip: null, city: null, country: 'HR', email: null, phone: null,
        iban: null, contactPerson: null, isCustomer: true, isSupplier: false, excluded: false, paymentTermDays: null,
        note: 'Stvoren pri uvozu za dokumente kojima kupac nije pronađen u staroj bazi.',
      });
      return key;
    });
  }
  supplierPlaceholder(): Key {
    return this.placeholder('supplier', () => {
      const key = this.genKey('partner');
      this.plan.partners.push({
        key, name: 'Nepoznat dobavljač (uvoz)', oib: null, vatId: null, address: null, zip: null, city: null, country: 'HR', email: null, phone: null,
        iban: null, contactPerson: null, isCustomer: false, isSupplier: true, excluded: false, paymentTermDays: null,
        note: 'Stvoren pri uvozu za dokumente kojima dobavljač nije pronađen u staroj bazi.',
      });
      return key;
    });
  }
  modelPlaceholder(): Key {
    return this.placeholder('model', () => {
      const key = this.genKey('model');
      this.plan.models.push({
        key, categoryKey: null, brand: null, name: 'Nepoznat model (uvoz)', code: null, kpd: null, salePrice: null, rentPrice: null,
        marginPct: null, warrantyMonths: null, minStock: 0, specs: null, active: true,
      });
      return key;
    });
  }
  defaultWarehouse(): Key {
    if (this.plan.warehouses.length) return this.plan.warehouses[0].key;
    return this.placeholder('warehouse', () => {
      const key = this.genKey('warehouse');
      this.plan.warehouses.push({ key, name: 'Glavno skladište', address: null, active: true, sort: 0 });
      return key;
    });
  }

  /** Partner po starom id-u; nepostojeći → null uz upozorenje. */
  partner(id: string | null, where: string, role = 'partner'): Key | null {
    if (!id) return null;
    const k = this.partners.get(id);
    if (!k) this.w.warn('ref-partner', 'veza', `${where}: ${role} „${id}" ne postoji u staroj bazi — veza izostavljena.`);
    return k ?? null;
  }
  warehouse(id: string | null, where: string): Key | null {
    if (!id) return null;
    const k = this.warehouses.get(id);
    if (!k) this.w.warn('ref-warehouse', 'veza', `${where}: skladište „${id}" ne postoji — izostavljeno.`);
    return k ?? null;
  }
  item(id: string | null, where: string): PlanItem | null {
    if (!id) return null;
    const it = this.items.get(id);
    if (!it) this.w.warn('ref-item', 'veza', `${where}: uređaj „${id}" ne postoji u staroj bazi — veza izostavljena.`);
    return it ?? null;
  }
}
