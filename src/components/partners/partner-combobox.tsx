'use client';

import { useCallback, useMemo } from 'react';
import { Combobox } from '@/components/ui/combobox';
import { MultiSelectFilter, useQueryParams } from '@/components/ui/filters';
import { cn } from '@/lib/cn';
import { toPartnerOption, type PartnerComboOption, type PartnerOpt, type PartnerRole } from '@/lib/partner-option';
import { searchPartnerOptions } from '@/app/(app)/partneri/search-actions';

/** Pretraga partnera na poslužitelju (prvih 20 ili po upitu). */
export function usePartnerSearch(role: PartnerRole = 'any') {
  return useCallback(
    async (q: string): Promise<PartnerComboOption[]> => {
      const res = await searchPartnerOptions({ q, role });
      return res.ok ? (res.data ?? []) : [];
    },
    [role],
  );
}

const asArray = (v: PartnerOpt | PartnerOpt[] | null | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Odabir partnera s pretragom na poslužitelju — u preglednik ide samo odabrani partner
 * (`initial`), ne cijeli popis. `onChange` uz id vraća i podatke partnera (PDV, rok, napomena).
 */
export function PartnerCombobox({
  value,
  onChange,
  role = 'any',
  initial,
  placeholder = 'Odaberite partnera…',
  name,
  allowEmpty,
  disabled,
  className,
}: {
  value: string | null;
  onChange?: (id: string | null, partner?: PartnerOpt) => void;
  role?: PartnerRole;
  /** Trenutno odabrani (i po želji još koji) partner, razriješen na poslužitelju. */
  initial?: PartnerOpt | PartnerOpt[] | null;
  placeholder?: string;
  name?: string;
  allowEmpty?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const onSearch = usePartnerSearch(role);
  const options = useMemo(() => asArray(initial).map(toPartnerOption), [initial]);
  return (
    <Combobox
      name={name}
      className={className}
      options={options}
      value={value}
      onChange={(id, o) => onChange?.(id, (o as PartnerComboOption | undefined)?.partner)}
      onSearch={onSearch}
      placeholder={placeholder}
      allowEmpty={allowEmpty}
      disabled={disabled}
    />
  );
}

/** Filtar popisa (jedan partner u URL-u, `?partner=id`) s pretragom na poslužitelju. */
export function PartnerFilter({
  name = 'partner',
  placeholder = 'Svi partneri',
  role = 'any',
  current,
  className,
}: {
  name?: string;
  placeholder?: string;
  role?: PartnerRole;
  current?: PartnerOpt | null;
  className?: string;
}) {
  const { params, set } = useQueryParams();
  return (
    <PartnerCombobox
      className={cn('w-full sm:w-56', className)}
      value={params.get(name)}
      onChange={(id) => set({ [name]: id })}
      role={role}
      initial={current}
      placeholder={placeholder}
      allowEmpty
    />
  );
}

/** Višestruki filtar partnera (`?partner=a,b`) — odabrani razriješeni na poslužitelju, ostali pretragom. */
export function PartnerMultiFilter({ name = 'partner', label, role = 'any', selected }: { name?: string; label: string; role?: PartnerRole; selected: PartnerOpt[] }) {
  const onSearch = usePartnerSearch(role);
  return <MultiSelectFilter name={name} label={label} options={selected.map((p) => ({ value: p.id, label: p.name }))} onSearch={onSearch} />;
}
