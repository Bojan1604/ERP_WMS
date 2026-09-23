'use client';

import { useCallback } from 'react';
import { Combobox, type ComboOption } from '@/components/ui/combobox';
import type { ServerAction } from '@/components/ui/action';

export type DeviceSearch = ServerAction<{ q: string; stockOnly: boolean; excludeId: string | null }, ComboOption[]>;

/** Odabir uređaja pretragom po serijskom broju (dohvat s poslužitelja dok korisnik tipka). */
export function DevicePicker({
  search,
  value,
  onChange,
  stockOnly = false,
  excludeId = null,
  initial,
  placeholder = 'Serijski broj, model ili klijent…',
}: {
  search: DeviceSearch;
  value: string | null;
  onChange: (id: string | null, option?: ComboOption) => void;
  stockOnly?: boolean;
  excludeId?: string | null;
  initial?: ComboOption | null;
  placeholder?: string;
}) {
  const onSearch = useCallback(
    async (q: string) => {
      const r = await search({ q, stockOnly, excludeId });
      return r.ok ? (r.data ?? []) : [];
    },
    [search, stockOnly, excludeId],
  );
  return <Combobox options={initial ? [initial] : []} value={value} onChange={onChange} onSearch={onSearch} placeholder={placeholder} />;
}
