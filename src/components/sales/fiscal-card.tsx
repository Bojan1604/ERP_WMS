'use client';

import Link from 'next/link';
import { RefreshCw, Send } from 'lucide-react';
import { ActionButton } from '@/components/ui/action';
import { Badge, Card } from '@/components/ui/misc';
import { dateTime } from '@/lib/format';
import { FISCAL_ROUTE_LABEL, FISCAL_STATUS_LABEL, FISCAL_STATUS_TONE, PAYMENT_METHOD_LABEL, type FiscalRoute, type FiscalStatusCode, type PaymentMethodCode } from '@/domain/fiscal';
import { refiscalizeInvoice, sendEInvoiceAction } from '@/app/(app)/prodaja/racuni/actions';

export interface FiscalCardData {
  id: string;
  route: FiscalRoute;
  paymentMethod: PaymentMethodCode;
  status: FiscalStatusCode;
  zki: string | null;
  jir: string | null;
  fiscalizedAt: string | null;
  error: string | null;
  attempts: number;
  demo: boolean;
  /** Stanje kod posrednika. */
  eInvoice: { id: string | null; status: string | null; provider: string | null; sentAt: string | null };
  /** Može li se račun poslati kao eRačun (domaći poslovni subjekt). */
  canSendEInvoice: boolean;
}

/** Fiskalizacija računa: stanje, ZKI/JIR, ponovno slanje i eRačun. */
export function FiscalCard({ f, canEdit, canSeeLog }: { f: FiscalCardData; canEdit: boolean; canSeeLog: boolean }) {
  const eSent = !!f.eInvoice.id && f.eInvoice.status === 'SENT';
  return (
    <Card
      title="Fiskalizacija"
      actions={
        <Badge tone={FISCAL_STATUS_TONE[f.status]}>
          {FISCAL_STATUS_LABEL[f.status]}
          {f.demo && f.status === 'SENT' ? ' (demo)' : ''}
        </Badge>
      }
    >
      <dl className="space-y-1 text-sm">
        <Row k="Način plaćanja" v={PAYMENT_METHOD_LABEL[f.paymentMethod]} />
        <Row k="Put" v={FISCAL_ROUTE_LABEL[f.route]} />
        {f.zki && <Row k="ZKI" v={<span className="font-mono text-xs break-all">{f.zki}</span>} />}
        {f.jir && <Row k="JIR" v={<span className="font-mono text-xs break-all">{f.jir}</span>} />}
        {f.eInvoice.id && <Row k="Id kod posrednika" v={<span className="font-mono text-xs break-all">{f.eInvoice.id}</span>} />}
        {f.fiscalizedAt && <Row k="Vrijeme" v={dateTime(f.fiscalizedAt)} />}
        {f.attempts > 0 && <Row k="Pokušaja" v={f.attempts} />}
      </dl>
      {f.error && f.status !== 'SENT' && <p className="mt-2 rounded-md bg-bad-soft px-2.5 py-1.5 text-xs text-bad-strong">{f.error}</p>}
      {f.route === 'NONE' && !f.zki && !f.eInvoice.id && (
        <p className="mt-2 text-xs text-fg-3">Račun se ne fiskalizira (transakcijski račun bez posrednika ili strani kupac, ili je fiskalizacija isključena).</p>
      )}
      {canEdit && (
        <div className="mt-3 flex flex-wrap gap-2">
          {f.zki && !f.jir && (
            <ActionButton action={refiscalizeInvoice} input={{ invoiceId: f.id }} size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />}>
              Ponovi fiskalizaciju
            </ActionButton>
          )}
          {f.canSendEInvoice && !eSent && (
            <ActionButton
              action={sendEInvoiceAction}
              input={{ invoiceId: f.id }}
              size="sm"
              variant={f.route === 'EINVOICE' ? 'primary' : 'secondary'}
              icon={<Send className="size-3.5" />}
              confirm="eRačun (UBL XML) šalje se posredniku, koji ga dostavlja kupcu i prijavljuje Poreznoj upravi. Nastaviti?"
              confirmLabel="Pošalji"
            >
              Pošalji eRačun
            </ActionButton>
          )}
        </div>
      )}
      {canSeeLog && (
        <Link prefetch={false} href={`/postavke/fiskalizacija?racun=${f.id}`} className="link mt-3 inline-block text-xs">
          Dnevnik slanja →
        </Link>
      )}
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-fg-3">{k}</dt>
      <dd className="min-w-0 text-right">{v}</dd>
    </div>
  );
}
