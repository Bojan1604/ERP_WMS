import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileCode2, Trash2, Truck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getCompany } from '@/server/queries/lookups';
import { getInvoice, getSalesLookups, type InvoiceDetail } from '@/server/queries/sales';
import { INVOICE_KIND_LABEL, paymentState, type ChargeInput } from '@/domain/invoice';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader, Card, Badge } from '@/components/ui/misc';
import { buttonClass, LinkButton } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { PrintButton } from '@/components/ui/print-button';
import { InvoiceEditor, type InvoiceEditorValue } from '@/components/sales/invoice-editor';
import { InvoiceDocument, toDocData } from '@/components/sales/invoice-document';
import { CorrectionButtons, PaymentsCard, type PanelInvoice } from '@/components/sales/invoice-panel';
import { KIND_SHORT, PayBadge, TYPE_LABEL } from '@/components/sales/list-bits';
import { date, eur } from '@/lib/format';
import { FiscalCard, type FiscalCardData } from '@/components/sales/fiscal-card';
import { isDomesticBusiness } from '@/domain/fiscal';
import { readMeta } from '@/server/fiscal/issue';
import { deleteInvoiceDraft } from '../actions';

export const metadata = { title: 'Račun' };

const back = (
  <Link prefetch={false} href="/prodaja/racuni" className="hover:underline">
    ← Računi
  </Link>
);

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('sales', 'view');
  const { id } = await params;
  const inv = await getInvoice(user.companyId, id);
  if (!inv) notFound();
  const edit = can(user.perms, 'sales', 'edit');

  if (inv.status === 'DRAFT' && edit) {
    const lookups = await getSalesLookups(user.companyId);
    return (
      <>
        <PageHeader
          title={`Nacrt — ${INVOICE_KIND_LABEL[inv.kind].toLowerCase()}`}
          subtitle={`${TYPE_LABEL[inv.type]} · ${inv.partner.name}${inv.createdBy ? ` · izradio ${inv.createdBy}` : ''}`}
          back={back}
          actions={
            <ActionButton
              action={deleteInvoiceDraft}
              input={{ id: inv.id }}
              variant="danger"
              icon={<Trash2 className="size-4" />}
              confirmTitle="Brisanje nacrta"
              confirm="Nacrt računa bit će trajno obrisan. Uređaji s nacrta ostaju na skladištu."
              confirmLabel="Obriši nacrt"
            >
              Obriši nacrt
            </ActionButton>
          }
        />
        <InvoiceEditor initial={editorValue(inv)} lookups={lookups} />
      </>
    );
  }

  const company = await getCompany(user.companyId);
  const st = paymentState(
    {
      status: inv.status,
      kind: inv.kind,
      stornoed: inv.stornoed,
      date: toISO(inv.date),
      dueDate: inv.dueDate ? toISO(inv.dueDate) : null,
      total: num(inv.grandTotal),
      paid: num(inv.paidTotal),
      open: num(inv.openAmount),
      lastPaymentDate: inv.paidDate ? toISO(inv.paidDate) : null,
    },
    company.overdueDays,
  );
  const panel: PanelInvoice = {
    id: inv.id,
    number: inv.number,
    kind: inv.kind,
    stornoed: inv.stornoed,
    grandTotal: num(inv.grandTotal),
    netTotal: num(inv.netTotal),
    paidTotal: num(inv.paidTotal),
    creditedTotal: num(inv.creditedTotal),
    openAmount: num(inv.openAmount),
    vatRate: num(inv.vatRate),
    payments: inv.payments.map((p) => ({ id: p.id, date: toISO(p.date), amount: num(p.amount), method: p.method, note: p.note, createdBy: p.createdBy })),
  };
  const meta = readMeta(inv.eInvoice);
  const fiscal: FiscalCardData = {
    id: inv.id,
    route: meta.route ?? (inv.zki ? 'CIS' : 'NONE'),
    paymentMethod: inv.paymentMethod,
    status: inv.fiscalStatus,
    zki: inv.zki,
    jir: inv.jir,
    fiscalizedAt: inv.fiscalizedAt ? inv.fiscalizedAt.toISOString() : null,
    error: inv.fiscalError,
    attempts: inv.fiscalAttempts,
    demo: !!meta.cis?.demo || meta.provider === 'demo',
    eInvoice: { id: meta.id ?? null, status: meta.status ?? null, provider: meta.provider ?? null, sentAt: meta.sentAt ?? null },
    canSendEInvoice: !inv.zki && isDomesticBusiness(inv.partner),
  };
  const devices = inv.lines.filter((l) => l.item);
  const receivable = inv.kind === 'INVOICE' || inv.kind === 'ADVANCE';

  return (
    <>
      <div className="no-print">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {INVOICE_KIND_LABEL[inv.kind]} {inv.number}
            <PayBadge state={st} />
          </span>
        }
        subtitle={`${TYPE_LABEL[inv.type]} · ${inv.partner.name} · ${date(inv.date)}`}
        back={back}
        actions={
          <>
            <PrintButton />
            {devices.length > 0 && (
              <LinkButton href={`/prodaja/racuni/${inv.id}/otpremnica`} icon={<Truck className="size-4" />}>
                Otpremnica
              </LinkButton>
            )}
            <a href={`/api/prodaja/racuni/${inv.id}/xml`} download className={buttonClass('secondary', 'md')}>
              <FileCode2 className="size-4" />
              eRačun XML
            </a>
          </>
        }
      />
      </div>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 overflow-x-auto">
          <InvoiceDocument inv={toDocData(inv)} company={company} party={inv.partner} />
        </div>
        <aside className="no-print space-y-4">
          {receivable && (
            <Card title="Stanje" className="text-base">
              <div className="flex items-center justify-between">
                <PayBadge state={st} />
                {!inv.stornoed && (
                  <span className="text-sm text-fg-3">
                    {st.key === 'paid' ? `plaćeno za ${st.days} dana` : `${st.days} dana od izdavanja`}
                  </span>
                )}
              </div>
              {inv.dueDate && <p className="mt-2 text-sm text-fg-3">Dospijeće: {date(inv.dueDate)}</p>}
            </Card>
          )}
          {receivable && <PaymentsCard inv={panel} canEdit={edit} />}
          <FiscalCard f={fiscal} canEdit={edit} canSeeLog={can(user.perms, 'settings', 'view')} />
          <LinksCard inv={inv} />
          {devices.length > 0 && (
            <Card title={`Uređaji (${devices.length})`} padded={false}>
              <ul className="max-h-72 overflow-y-auto scroll-slim">
                {devices.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 border-b border-line/70 px-4 py-1.5 last:border-0">
                    <Link prefetch={false} href={`/skladiste/${l.item!.id}`} className="link font-mono text-sm">
                      {l.item!.serial}
                    </Link>
                    <span className="truncate text-xs text-fg-3">{l.description}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {edit && receivable && !inv.stornoed && (
            <Card title="Ispravak">
              <p className="mb-2 text-sm text-fg-3">Izdani račun se ne mijenja — ispravlja se stornom ili knjižnim odobrenjem.</p>
              <CorrectionButtons inv={panel} />
            </Card>
          )}
        </aside>
      </div>
    </>
  );
}

function LinksCard({ inv }: { inv: InvoiceDetail }) {
  const items: React.ReactNode[] = [];
  if (inv.refInvoice)
    items.push(
      <li key="ref">
        Odnosi se na:{' '}
        <Link prefetch={false} href={`/prodaja/racuni/${inv.refInvoice.id}`} className="link">
          {KIND_SHORT[inv.refInvoice.kind]} {inv.refInvoice.number}
        </Link>
      </li>,
    );
  for (const c of inv.corrections)
    items.push(
      <li key={c.id} className="flex justify-between gap-2">
        <Link prefetch={false} href={`/prodaja/racuni/${c.id}`} className="link">
          {KIND_SHORT[c.kind]} {c.number}
        </Link>
        <span className="tnum text-fg-3">
          {date(c.date)} · {eur(num(c.grandTotal))}
        </span>
      </li>,
    );
  if (inv.contract)
    items.push(
      <li key="contract">
        Ugovor:{' '}
        <Link prefetch={false} href={`/najam/ugovori/${inv.contract.id}`} className="link">
          {inv.contract.number}
        </Link>
        {inv.period && <span className="text-fg-3"> · {inv.period}</span>}
      </li>,
    );
  if (inv.quote)
    items.push(
      <li key="quote">
        Ponuda:{' '}
        <Link prefetch={false} href={`/prodaja/ponude/${inv.quote.id}`} className="link">
          {inv.quote.number}
        </Link>
      </li>,
    );
  items.push(
    <li key="partner">
      Partner:{' '}
      <Link prefetch={false} href={`/partneri/${inv.partner.id}`} className="link">
        {inv.partner.name}
      </Link>
      {inv.partner.excluded && (
        <Badge tone="neutral" className="ml-1">
          isključen
        </Badge>
      )}
    </li>,
  );
  if (inv.stornoed) items.unshift(<li key="st" className="font-medium text-bad-strong">Račun je storniran i ne ulazi u naplatu.</li>);
  return (
    <Card title="Veze">
      <ul className="space-y-1.5 text-base">{items}</ul>
      {inv.issuedBy && <p className="mt-3 text-xs text-fg-3">Izdao {inv.issuedBy}</p>}
    </Card>
  );
}

function editorValue(inv: InvoiceDetail): InvoiceEditorValue {
  return {
    id: inv.id,
    type: inv.type,
    kind: inv.kind === 'ADVANCE' ? 'ADVANCE' : 'INVOICE',
    partnerId: inv.partnerId,
    date: toISO(inv.date),
    dueDate: inv.dueDate ? toISO(inv.dueDate) : '',
    deliveryDate: inv.deliveryDate ? toISO(inv.deliveryDate) : '',
    vatRate: num(inv.vatRate),
    taxCategory: inv.taxCategory,
    taxExemptReason: inv.taxExemptReason ?? '',
    discountPct: num(inv.discountPct),
    discountAmount: num(inv.discountAmount),
    advanceAmount: num(inv.advanceAmount),
    charges: (Array.isArray(inv.charges) ? (inv.charges as unknown as ChargeInput[]) : []).map((c) => ({
      kind: c.kind,
      label: c.label ?? '',
      amount: c.amount ?? null,
      pct: c.pct ?? null,
    })),
    paymentMethod: inv.paymentMethod,
    description: inv.description ?? '',
    note: inv.note ?? '',
    lines: inv.lines.map((l) => ({
      key: l.id,
      kind: l.kind,
      itemId: l.itemId,
      modelId: l.modelId,
      serviceId: l.serviceId,
      description: l.description,
      unit: l.unit,
      kpd: l.kpd ?? '',
      qty: num(l.qty),
      unitPrice: num(l.unitPrice),
      discountPct: num(l.discountPct),
      warrantyMonths: l.warrantyMonths,
      agreedPrice: l.agreedPrice,
      monthly: l.monthly === null ? null : num(l.monthly),
      months: l.months,
      serial: l.item?.serial ?? null,
      cost: l.kind === 'DEVICE' ? num(l.cost) : null,
    })),
  };
}
