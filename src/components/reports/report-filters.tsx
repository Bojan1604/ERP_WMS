'use client';

import { Combobox } from '@/components/ui/combobox';
import { FilterBar, SegmentFilter, SelectFilter, useQueryParams } from '@/components/ui/filters';
import type { Option } from '@/components/ui/field';

type FilterKey = 'year' | 'partner' | 'category' | 'model' | 'days';

/** Filtri izvještaja u URL-u: godina, partner, kategorija, model, razdoblje u danima. */
export function ReportFilters({
  filters,
  years,
  currentYear,
  partners,
  categories,
  models,
  defaultDays,
}: {
  filters: FilterKey[];
  years: number[];
  currentYear: number;
  partners: Option[];
  categories: Option[];
  models: Option[];
  defaultDays: number;
}) {
  const { params, set } = useQueryParams();
  if (!filters.length) return null;
  const year = params.get('godina') ?? String(currentYear);
  return (
    <FilterBar>
      {filters.includes('year') && (
        <div className="inline-flex rounded-md bg-muted p-0.5">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => set({ godina: y === currentYear ? null : String(y) })}
              className={
                String(y) === year ? 'h-7 rounded bg-panel px-2.5 text-sm font-medium text-fg shadow-sm' : 'h-7 rounded px-2.5 text-sm text-fg-3 hover:text-fg'
              }
            >
              {y}.
            </button>
          ))}
        </div>
      )}
      {filters.includes('days') && (
        <SegmentFilter
          name="dana"
          options={[30, 60, 90, 180, 365].map((d) => ({ value: d === defaultDays ? '' : String(d), label: `${d} dana` }))}
        />
      )}
      {filters.includes('partner') && (
        <Combobox
          className="w-64"
          options={partners}
          value={params.get('partner')}
          allowEmpty
          placeholder="Svi partneri"
          onChange={(v) => set({ partner: v })}
        />
      )}
      {filters.includes('category') && <SelectFilter name="kategorija" placeholder="Sve kategorije" options={categories} />}
      {filters.includes('model') && <SelectFilter name="model" placeholder="Svi modeli" options={models} />}
    </FilterBar>
  );
}
