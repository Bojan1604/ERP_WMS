'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/misc';
import { Checkbox } from '@/components/ui/field';
import { eur } from '@/lib/format';
import { receiveHintsAction } from '@/app/(app)/skladiste/zaprimanje/actions';

/** Oznaka PDV-a pri nabavi od dobavljača (domaći PDV / EU prijenos / uvoz) i zadane specifikacije modela. */
export function useReceiveHints(supplierId: string | null, modelId: string | null) {
  const [hints, setHints] = useState<{ vat: { rate: number; label: string } | null; specs: { cpu: string | null; screen: string | null; os: string | null } | null }>({
    vat: null,
    specs: null,
  });
  useEffect(() => {
    if (!supplierId && !modelId) {
      setHints({ vat: null, specs: null });
      return;
    }
    let live = true;
    void receiveHintsAction({ supplierId, modelId }).then((r) => {
      if (live && r.ok && r.data) setHints(r.data);
    });
    return () => {
      live = false;
    };
  }, [supplierId, modelId]);
  return hints;
}

export function SupplierVatBadge({ vat }: { vat: { rate: number; label: string } | null }) {
  if (!vat) return null;
  return (
    <Badge tone={vat.rate > 0 ? 'info' : 'warn'} title="PDV pri nabavi (po državi dobavljača) — ulazi u trošak nabave">
      {vat.label}
    </Badge>
  );
}

/**
 * Prekidač „Knjiži nabavu u troškove" (E10). Isključen: primka ne knjiži trošak —
 * npr. roba je već plaćena i knjižena ulaznim računom.
 */
export function BookExpenseToggle({ checked, onChange, total, vat }: { checked: boolean; onChange: (v: boolean) => void; total: number | null; vat: { rate: number; label: string } | null }) {
  return (
    <div>
      <Checkbox
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        label={
          <>
            Knjiži nabavu u troškove{total !== null && total > 0 ? ` (${eur(total)}${vat && vat.rate > 0 ? ` + PDV ${vat.rate} %` : ''})` : ''}
          </>
        }
      />
      <p className="mt-1 text-xs text-fg-3">
        {checked
          ? 'Nastaje trošak „Nabava robe". Ulazni račun iste robe povezan s primkom ili narudžbenicom tada ne knjiži trošak ponovno.'
          : 'Primka ne knjiži trošak — robu knjiži ulazni račun (ili je trošak već knjižen). Trošak primke se može knjižiti i kasnije na primci.'}
      </p>
    </div>
  );
}
