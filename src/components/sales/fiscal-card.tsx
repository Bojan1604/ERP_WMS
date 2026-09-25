'use client';

import Link from 'next/link';
import { Download, FileCheck2, Globe2, RefreshCw, Send, ShieldCheck, Stamp, Undo2, UserSearch } from 'lucide-react';
import { ActionButton } from '@/components/ui/action';
import { Badge, Card } from '@/components/ui/misc';
import { buttonClass } from '@/components/ui/button';
import { dateTime } from '@/lib/format';
import { FISCAL_ROUTE_LABEL, FISCAL_STATUS_LABEL, FISCAL_STATUS_TONE, PAYMENT_METHOD_LABEL, type FiscalRoute, type FiscalStatusCode, type PaymentMethodCode } from '@/domain/fiscal';
import { EINVOICE_STATUS_LABEL, EINVOICE_STATUS_TONE, type EInvoiceStatusCode } from '@/domain/sales-lines';
import {
  amsCheckAction,
  fiscalizeIrAction,
  refiscalizeInvoice,
  refreshEInvoiceAction,
  reportTypeIAction,
  resetEInvoiceAction,
  sendEInvoiceAction,
  validateEInvoiceAction,
} from '@/app/(app)/prodaja/racuni/actions';

export interface FiscalCardData {
  id: string;
  number: string | null;
  kind: 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE';
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
  eInvoice: { id: string | null; status: string | null; provider: string | null; sentAt: string | null; statusText?: string | null; checkedAt?: string | null; reportType?: 'IR' | 'I' | null };
  /** Preslika stanja za popise (Invoice.eInvoiceStatus). */
  eInvoiceStatus: EInvoiceStatusCode | null;
  /** Može li se račun poslati kao eRačun (domaći poslovni subjekt). */
  canSendEInvoice: boolean;
  /** Strani kupac (eIzvještavanje tip I). */
  foreign: boolean;
  /** Posrednik je odabran u postavkama. */
  providerSet: boolean;
  /** Storno / odobrenje uz eRačun koji je već kod posrednika, a ovaj dokument nije poslan. */
  refSent: boolean;
}

/** Fiskalizacija i eRačun računa: stanje, ZKI/JIR, slanje i radnje kod posrednika. */
export function FiscalCard({ f, canEdit, canSeeLog }: { f: FiscalCardData; canEdit: boolean; canSeeLog: boolean }) {
  const atProvider = !!f.eInvoice.id && f.eInvoice.status === 'SENT';
  const reported = !!f.eInvoice.reportType;
  const unsentCorrection = f.refSent && !atProvider && (f.kind === 'STORNO' || f.kind === 'CREDIT_NOTE');
  const sendLabel = f.kind === 'STORNO' ? 'Pošalji storno' : f.kind === 'CREDIT_NOTE' ? 'Pošalji odobrenje' : f.kind === 'ADVANCE' ? 'Pošalji račun za predujam' : 'Pošalji eRačun';
  return (
    <Card
      title="Fiskalizacija i eRačun"
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
        {f.eInvoiceStatus && <Row k="eRačun" v={<Badge tone={EINVOICE_STATUS_TONE[f.eInvoiceStatus]}>{EINVOICE_STATUS_LABEL[f.eInvoiceStatus]}</Badge>} />}
        {f.eInvoice.statusText && <Row k="Stanje kod posrednika" v={f.eInvoice.statusText} />}
        {f.eInvoice.checkedAt && <Row k="Provjereno" v={dateTime(f.eInvoice.checkedAt)} />}
        {f.zki && <Row k="ZKI" v={<span className="font-mono text-xs break-all">{f.zki}</span>} />}
        {f.jir && <Row k="JIR" v={<span className="font-mono text-xs break-all">{f.jir}</span>} />}
        {f.eInvoice.id && <Row k="Id kod posrednika" v={<span className="font-mono text-xs break-all">{f.eInvoice.id}</span>} />}
        {f.fiscalizedAt && <Row k="Vrijeme" v={dateTime(f.fiscalizedAt)} />}
        {f.attempts > 0 && <Row k="Pokušaja" v={f.attempts} />}
      </dl>
      {f.error && f.status !== 'SENT' && <p className="mt-2 rounded-md bg-bad-soft px-2.5 py-1.5 text-xs text-bad-strong">{f.error}</p>}
      {unsentCorrection && (
        <p className="mt-2 rounded-md bg-warn-soft px-2.5 py-1.5 text-xs text-warn">
          Izvorni račun je poslan posredniku, a ovaj dokument još nije — dok ne stigne posredniku, izvorni račun kod Porezne uprave vrijedi u punom iznosu.
        </p>
      )}
      {f.route === 'NONE' && !f.zki && !f.eInvoice.id && (
        <p className="mt-2 text-xs text-fg-3">
          {f.foreign
            ? 'Strani kupac — račun ne ide kao eRačun; po potrebi se prijavljuje u eIzvještavanje (tip I).'
            : 'Račun se ne fiskalizira (transakcijski račun bez posrednika ili je fiskalizacija isključena).'}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {canEdit && f.zki && !f.jir && (
          <ActionButton action={refiscalizeInvoice} input={{ invoiceId: f.id }} size="sm" variant="primary" icon={<RefreshCw className="size-3.5" />}>
            Ponovi fiskalizaciju
          </ActionButton>
        )}
        {canEdit && f.providerSet && !f.zki && (f.canSendEInvoice || f.foreign) && !atProvider && (
          <ActionButton action={validateEInvoiceAction} input={{ invoiceId: f.id }} size="sm" icon={<FileCheck2 className="size-3.5" />}>
            Provjeri eRačun
          </ActionButton>
        )}
        {canEdit && f.canSendEInvoice && !atProvider && (
          <ActionButton
            action={sendEInvoiceAction}
            input={{ invoiceId: f.id }}
            size="sm"
            variant={f.route === 'EINVOICE' || unsentCorrection ? 'primary' : 'secondary'}
            icon={<Send className="size-3.5" />}
            confirm="eRačun (UBL XML) šalje se posredniku, koji ga dostavlja kupcu i prijavljuje Poreznoj upravi. Ovo se ne može povući — greška se ispravlja samo stornom. Nastaviti?"
            confirmLabel="Pošalji"
          >
            {sendLabel}
          </ActionButton>
        )}
        {canEdit && f.providerSet && f.canSendEInvoice && !atProvider && (
          <ActionButton
            action={fiscalizeIrAction}
            input={{ invoiceId: f.id }}
            size="sm"
            icon={<Stamp className="size-3.5" />}
            confirmTitle="Fiskalizacija bez slanja (IR)"
            confirm="Tip IR: podaci računa idu Poreznoj upravi, a kupcu račun dostavljate sami (PDF, e-pošta). Koristi se kad kupac nije u AMS adresaru."
            confirmLabel="Fiskaliziraj"
          >
            Fiskaliziraj bez slanja (IR)
          </ActionButton>
        )}
        {canEdit && f.providerSet && f.foreign && !atProvider && (
          <ActionButton
            action={reportTypeIAction}
            input={{ invoiceId: f.id }}
            size="sm"
            icon={<Globe2 className="size-3.5" />}
            confirmTitle="eIzvještavanje (tip I)"
            confirm="Kupac je izvan Hrvatske pa račun ne ide kao eRačun; ovim se podaci računa prijavljuju Poreznoj upravi. Je li prijava obvezna za strane kupce potvrdite s knjigovođom."
            confirmLabel="Prijavi"
          >
            Prijavi u eIzvještavanje (tip I)
          </ActionButton>
        )}
        {f.providerSet && f.canSendEInvoice && !atProvider && (
          <ActionButton action={amsCheckAction} input={{ invoiceId: f.id }} size="sm" variant="ghost" icon={<UserSearch className="size-3.5" />}>
            Je li kupac u AMS-u?
          </ActionButton>
        )}
        {canEdit && atProvider && !reported && (
          <ActionButton action={refreshEInvoiceAction} input={{ invoiceId: f.id }} size="sm" icon={<RefreshCw className="size-3.5" />}>
            Osvježi status
          </ActionButton>
        )}
        {atProvider && (
          <a href={`/api/prodaja/racuni/${f.id}/eracun-pdf`} className={buttonClass('secondary', 'sm')}>
            <Download className="size-3.5" />
            PDF posrednika
          </a>
        )}
        {canEdit && (atProvider || !!f.eInvoiceStatus) && (
          <ActionButton
            action={resetEInvoiceAction}
            input={{ invoiceId: f.id }}
            size="sm"
            variant="ghost"
            icon={<Undo2 className="size-3.5" />}
            confirmTitle="Poništiti trag slanja?"
            confirm="Program zaboravlja da je dokument poslan; kod posrednika dokument ostaje kakav jest. Koristite samo ako je trag upisan greškom (npr. test)."
            confirmLabel="Poništi"
          >
            Poništi trag slanja
          </ActionButton>
        )}
      </div>
      {!f.providerSet && (f.canSendEInvoice || f.foreign) && !f.zki && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-fg-3">
          <ShieldCheck className="size-3.5" /> Posrednik za eRačun nije odabran (Postavke → Fiskalizacija) — moguć je samo izvoz XML-a.
        </p>
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
