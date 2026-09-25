'use client';

import { FilePlus2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { eur } from '@/lib/format';
import { PAYMENT_METHOD_LABEL, type PaymentMethodCode } from '@/domain/fiscal';

/** Potvrda izdavanja računa: što se događa s uređajima (prodaja / najam) i fiskalizacija. */
export function IssueDialog({
  open,
  onClose,
  onIssue,
  pending,
  partnerName,
  total,
  paymentMethod,
  sellsDevices,
  rentsDevices,
  contractId,
}: {
  open: boolean;
  onClose: () => void;
  onIssue: () => void;
  pending: boolean;
  partnerName: string;
  total: number;
  paymentMethod: PaymentMethodCode;
  sellsDevices: boolean;
  rentsDevices: boolean;
  contractId: string | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Izdavanje računa"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button variant="primary" loading={pending} icon={<FilePlus2 className="size-4" />} onClick={onIssue}>
            Izdaj račun
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-base text-fg-2">
        <p>
          Račun za <b className="text-fg">{partnerName}</b> na <b className="text-fg tnum">{eur(total)}</b> dobit će redni broj i više se neće moći mijenjati — ispravak je
          moguć samo stornom ili odobrenjem.
        </p>
        {sellsDevices && <p>Prodani uređaji bit će skinuti sa stanja (status „Prodan").</p>}
        {rentsDevices && (
          <p>
            Uređaji u najmu vežu se uz {contractId === 'new' ? 'novi ugovor' : 'odabrani ugovor'} (status „U najmu").
            {!contractId && <b className="text-bad-strong"> Odaberite ugovor ili „+ Novi ugovor".</b>}
          </p>
        )}
        <p>
          Način plaćanja: <b className="text-fg">{PAYMENT_METHOD_LABEL[paymentMethod]}</b>
          {paymentMethod !== 'TRANSFER' && ' — ako je fiskalizacija uključena, račun dobiva ZKI i šalje se u CIS po JIR.'}
        </p>
      </div>
    </Dialog>
  );
}
