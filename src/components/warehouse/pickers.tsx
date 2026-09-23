'use client';

import { useCallback, useState } from 'react';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import { useQueryParams } from '@/components/ui/filters';
import { cn } from '@/lib/cn';
import { searchPartners } from '@/app/(app)/skladiste/actions';

type Role = 'customer' | 'supplier' | 'any';

function usePartnerSearch(role: Role) {
  return useCallback(async (q: string): Promise<ComboOption[]> => {
    const res = await searchPartners({ q, role });
    return res.ok ? (res.data ?? []) : [];
  }, [role]);
}

/** Odabir partnera s pretragom na poslužitelju. */
export function PartnerPicker({
  value,
  onChange,
  role = 'any',
  initial,
  placeholder = 'Odaberite partnera…',
  name,
}: {
  value: string | null;
  onChange?: (v: string | null) => void;
  role?: Role;
  initial?: ComboOption | null;
  placeholder?: string;
  name?: string;
}) {
  const onSearch = usePartnerSearch(role);
  return (
    <Combobox
      name={name}
      options={initial ? [initial] : []}
      value={value}
      onChange={(v) => onChange?.(v)}
      onSearch={onSearch}
      placeholder={placeholder}
      allowEmpty
    />
  );
}

/** Isto, ali upravlja sam sobom (za obrasce s `name`). */
export function PartnerField({ name, role, initial, placeholder }: { name: string; role?: Role; initial?: ComboOption | null; placeholder?: string }) {
  const [v, setV] = useState<string | null>(initial?.value ?? null);
  return <PartnerPicker name={name} value={v} onChange={setV} role={role} initial={initial} placeholder={placeholder} />;
}

/** Filtar u URL-u s padajućim odabirom i pretragom (modeli, partneri). */
export function ComboFilter({
  name,
  placeholder,
  options,
  partnerRole,
  current,
  className,
}: {
  name: string;
  placeholder: string;
  options?: ComboOption[];
  /** Ako je zadano, opcije se traže na poslužitelju među partnerima. */
  partnerRole?: Role;
  current?: ComboOption | null;
  className?: string;
}) {
  const { params, set } = useQueryParams();
  const onSearch = usePartnerSearch(partnerRole ?? 'any');
  const value = params.get(name);
  const opts = options ?? (current ? [current] : []);
  return (
    <Combobox
      className={cn('w-full sm:w-52', className)}
      options={opts}
      value={value}
      onChange={(v) => set({ [name]: v })}
      onSearch={partnerRole ? onSearch : undefined}
      placeholder={placeholder}
      allowEmpty
    />
  );
}
