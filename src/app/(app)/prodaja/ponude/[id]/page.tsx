import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, Printer, Send, Trash2, Undo2, XCircle } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can } from '@/domain/permissions';
import { getCompany } from '@/server/queries/lookups';
import { getQuote, getSalesLookups, stockByModel, type QuoteDetail } from '@/server/queries/sales';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader, Notice } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { ActionButton } from '@/components/ui/action';
import { QuoteEditor, type QuoteEditorValue } from '@/components/sales/quote-editor';
import { QuoteConvert } from '@/components/sales/quote-convert';
import { QuoteDocument, quoteDocData } from '@/components/sales/quote-document';
import { QuoteBadge, quoteStatus } from '@/components/sales/quote-status';
import { date } from '@/lib/format';
import { deleteQuoteAction, setQuoteStatusAction } from '../actions';

export const metadata = { title: 'Ponuda' };

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('sales', 'view');
  const { id } = await params;
  const q = await getQuote(user.companyId, id);
  if (!q) notFound();
  const edit = can(user.perms, 'sales', 'edit');
  const st = quoteStatus(q.status, q.validUntil ? toISO(q.validUntil) : null);
  const locked = !!q.invoiceId;
  const lookups = edit ? await getSalesLookups(user.companyId) : null;

  const status = (s: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED', label: string, icon: React.ReactNode) => (
    <ActionButton action={setQuoteStatusAction} input={{ id: q.id, status: s }} icon={icon} size="md">
      {label}
    </ActionButton>
  );

  return (
    <>
      <div className="no-print">
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              Ponuda {q.number} <QuoteBadge status={st} />
            </span>
          }
          subtitle={`${q.partner.name} · ${date(q.date)}${q.validUntil ? ` · vrijedi do ${date(q.validUntil)}` : ''}`}
          back={
            <Link prefetch={false} href="/prodaja/ponude" className="hover:underline">
              ← Ponude
            </Link>
          }
          actions={
            <>
              <LinkButton href={`/prodaja/ponude/${q.id}/ispis`} icon={<Printer className="size-4" />}>
                Ispis
              </LinkButton>
              {edit && !locked && (
                <>
                  {q.status === 'DRAFT' && status('SENT', 'Označi poslanom', <Send className="size-4" />)}
                  {(q.status === 'DRAFT' || q.status === 'SENT') && status('REJECTED', 'Odbijena', <XCircle className="size-4" />)}
                  {(q.status === 'DRAFT' || q.status === 'SENT') && status('ACCEPTED', 'Prihvaćena', <CheckCircle2 className="size-4" />)}
                  {(q.status === 'ACCEPTED' || q.status === 'REJECTED') && status('DRAFT', 'Vrati u nacrt', <Undo2 className="size-4" />)}
                  <ActionButton
                    action={deleteQuoteAction}
                    input={{ id: q.id }}
                    variant="danger"
                    icon={<Trash2 className="size-4" />}
                    confirmTitle="Brisanje ponude"
                    confirm={`Ponuda ${q.number} bit će trajno obrisana.`}
                    confirmLabel="Obriši"
                  >
                    Obriši
                  </ActionButton>
                  {q.status !== 'REJECTED' && lookups && (
                    <QuoteConvert
                      quoteId={q.id}
                      partnerId={q.partnerId}
                      models={lookups.models}
                      categories={lookups.categories}
                      warehouses={lookups.warehouses}
                      lines={q.lines.map((l) => ({
                        id: l.id,
                        kind: l.kind,
                        description: l.description,
                        qty: num(l.qty),
                        modelId: l.modelId,
                        itemId: l.itemId,
                        serial: l.item?.serial ?? null,
                        itemAvailable: !!l.item && (l.item.state === 'IN_STOCK' || l.item.state === 'RESERVED'),
                      }))}
                    />
                  )}
                </>
              )}
            </>
          }
        />
      </div>
      {locked && q.invoice && (
        <Notice
          tone="ok"
          action={
            <LinkButton href={`/prodaja/racuni/${q.invoice.id}`} size="sm">
              Otvori račun
            </LinkButton>
          }
        >
          Ponuda je pretvorena u račun {q.invoice.number ?? '(nacrt)'} i više se ne mijenja.
        </Notice>
      )}
      {st === 'EXPIRED' && !locked && <Notice tone="warn">Rok valjanosti ponude je istekao — produžite datum „Vrijedi do" ako je ponuda i dalje aktualna.</Notice>}
      {edit && !locked && lookups ? (
        <QuoteEditor
          initial={editorValue(q)}
          lookups={lookups}
          stock={await stockByModel(user.companyId, [...new Set(q.lines.map((l) => l.modelId).filter((x): x is string => !!x))])}
        />
      ) : (
        <QuoteDocument q={quoteDocData(q)} company={await getCompany(user.companyId)} party={q.partner} />
      )}
    </>
  );
}

function editorValue(q: QuoteDetail): QuoteEditorValue {
  return {
    id: q.id,
    partnerId: q.partnerId,
    date: toISO(q.date),
    validUntil: q.validUntil ? toISO(q.validUntil) : '',
    vatRate: num(q.vatRate),
    discountPct: num(q.discountPct),
    discountAmount: num(q.discountAmount),
    hideSerials: q.hideSerials,
    note: q.note ?? '',
    lines: q.lines.map((l) => ({
      key: l.id,
      kind: l.kind,
      itemId: l.itemId,
      modelId: l.modelId,
      serviceId: l.serviceId,
      description: l.description,
      unit: l.unit,
      kpd: '',
      qty: num(l.qty),
      unitPrice: num(l.unitPrice),
      discountPct: num(l.discountPct),
      warrantyMonths: null,
      agreedPrice: false,
      serial: l.item?.serial ?? null,
    })),
  };
}
