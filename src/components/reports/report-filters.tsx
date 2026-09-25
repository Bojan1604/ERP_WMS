'use client';

import { X } from 'lucide-react';
import { DateRangeFilter, FilterBar, MultiSelectFilter, SegmentFilter, useQueryParams } from '@/components/ui/filters';
import type { Option } from '@/components/ui/field';
import { PartnerMultiFilter } from '@/components/partners/partner-combobox';
import type { PartnerOpt } from '@/lib/partner-option';

type FilterKey = 'year' | 'range' | 'partner' | 'category' | 'model' | 'status' | 'warehouse' | 'supplier' | 'type' | 'days';

const PARAMS = ['godina', 'od', 'do', 'partner', 'kategorija', 'model', 'status', 'skladiste', 'dobavljac', 'vrsta', 'dana'];

/**
 * Filtri izvještaja u URL-u: godina (i „Sve"), raspon od/do, višestruki odabir
 * vrste, klijenta, kategorije, modela, statusa, skladišta i dobavljača, razdoblje u danima.
 */
export function ReportFilters({
  filters,
  years,
  currentYear,
  allYears,
  partners,
  suppliers,
  categories,
  models,
  statuses,
  warehouses,
  defaultDays,
}: {
  filters: FilterKey[];
  years: number[];
  currentYear: number;
  /** Nudi se „Sve" (sve godine). */
  allYears: boolean;
  /** Odabrani klijenti / dobavljači (razriješeni na poslužitelju); ostali se traže pretragom. */
  partners: PartnerOpt[];
  suppliers: PartnerOpt[];
  categories: Option[];
  models: Option[];
  statuses: Option[];
  warehouses: Option[];
  defaultDays: number;
}) {
  const { params, set } = useQueryParams();
  if (!filters.length) return null;
  const year = params.get('godina') ?? String(currentYear);
  const has = (k: FilterKey) => filters.includes(k);
  const active = PARAMS.some((p) => params.get(p));
  const yearOptions = [...years.map((y) => ({ value: String(y), label: `${y}.` })), ...(allYears ? [{ value: 'sve', label: 'Sve' }] : [])];
  return (
    <FilterBar>
      {has('year') && (
        <div className="inline-flex flex-wrap rounded-md bg-muted p-0.5">
          {yearOptions.map((y) => (
            <button
              key={y.value}
              type="button"
              onClick={() => set({ godina: y.value === String(currentYear) ? null : y.value })}
              className={y.value === year ? 'h-7 rounded bg-panel px-2.5 text-sm font-medium text-fg shadow-sm' : 'h-7 rounded px-2.5 text-sm text-fg-3 hover:text-fg'}
            >
              {y.label}
            </button>
          ))}
        </div>
      )}
      {has('days') && (
        <SegmentFilter name="dana" options={[30, 60, 90, 180, 365].map((d) => ({ value: d === defaultDays ? '' : String(d), label: `${d} dana` }))} />
      )}
      {has('range') && <DateRangeFilter label="Razdoblje" />}
      {has('type') && (
        <MultiSelectFilter
          name="vrsta"
          label="Vrsta"
          options={[
            { value: 'prodaja', label: 'Prodaja' },
            { value: 'najam', label: 'Najam' },
          ]}
        />
      )}
      {has('partner') && <PartnerMultiFilter name="partner" label="Klijent" selected={partners} />}
      {has('category') && <MultiSelectFilter name="kategorija" label="Kategorija" options={categories} />}
      {has('model') && <MultiSelectFilter name="model" label="Model" options={models} searchable />}
      {has('status') && <MultiSelectFilter name="status" label="Status" options={statuses} />}
      {has('warehouse') && <MultiSelectFilter name="skladiste" label="Skladište" options={warehouses} />}
      {has('supplier') && <PartnerMultiFilter name="dobavljac" label="Dobavljač" role="supplier" selected={suppliers} />}
      {active && (
        <button
          type="button"
          onClick={() => set(Object.fromEntries(PARAMS.map((p) => [p, null])))}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-fg-3 hover:bg-muted hover:text-fg"
        >
          <X className="size-3.5" /> Poništi filtre
        </button>
      )}
    </FilterBar>
  );
}
