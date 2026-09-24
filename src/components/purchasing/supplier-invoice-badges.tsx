import { FileCode2 } from 'lucide-react';
import { Badge, type Tone } from '@/components/ui/misc';
import { SUPPLIER_INVOICE_STATUS_LABEL } from '@/domain/einvoice-inbound';

type Status = keyof typeof SUPPLIER_INVOICE_STATUS_LABEL;

/** Status ulaznog računa; plaćen (datum plaćanja) ima prednost pred „prihvaćen". */
export function SupplierInvoiceStatusBadge({ status, paid }: { status: Status; paid: boolean }) {
  if (status === 'REJECTED') return <Badge tone="bad">Odbijen</Badge>;
  if (paid) return <Badge tone="ok">Plaćen</Badge>;
  const tone: Tone = status === 'RECEIVED' ? 'warn' : 'info';
  return <Badge tone={tone}>{SUPPLIER_INVOICE_STATUS_LABEL[status]}</Badge>;
}

export function SupplierInvoiceSourceBadge({ source }: { source: 'MANUAL' | 'EINVOICE' }) {
  return source === 'EINVOICE' ? (
    <Badge tone="brand" title="Preuzet od informacijskog posrednika (Fiskalizacija 2.0)">
      <FileCode2 className="size-3" /> eRačun
    </Badge>
  ) : (
    <Badge>ručno</Badge>
  );
}
