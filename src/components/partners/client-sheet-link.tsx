import { ListChecks } from 'lucide-react';
import { LinkButton } from '@/components/ui/button';

/**
 * Popis uređaja kod klijenta (C3, „ClientSheet"): stranica /partneri/[id]/uredaji
 * s pogledima U najmu / Prodano / Sve, cijenama, uvjetima ugovora, Excelom i PDF-om.
 * `contractId` suzuje popis na uređaje jednog ugovora. Koriste je ugovor, partner i račun (B15).
 */
export const clientSheetHref = (partnerId: string, contractId?: string | null, view?: 'najam' | 'prodano' | 'sve') => {
  const q = new URLSearchParams();
  if (contractId) q.set('ugovor', contractId);
  if (view) q.set('pogled', view);
  const s = q.toString();
  return `/partneri/${partnerId}/uredaji${s ? `?${s}` : ''}`;
};

export function ClientSheetButton({
  partnerId,
  contractId,
  label = 'Popis za klijenta',
  size,
}: {
  partnerId: string;
  contractId?: string | null;
  label?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <LinkButton href={clientSheetHref(partnerId, contractId)} size={size} icon={<ListChecks className="size-4" />}>
      {label}
    </LinkButton>
  );
}
