import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CheckCircle2, Printer, Send, Trash2, Undo2, XCircle } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { can, canSeeCost } from '@/domain/permissions';
import { getCompany } from '@/server/queries/lookups';
import { getQuote, getSalesLookups, stockByModel, type QuoteDetail } from '@/server/queries/sales';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { PageHeader, Notice } from '@/components/ui/misc';
import { MoreMenu } from '@/components/ui/more-menu';
import { LinkButton } from '@/components/ui/button';
import { PdfButton } from '@/components/ui/pdf-button';
import { SendEmailButton } from '@/components/ui/send-email-button';
import { ActionButton } from '@/components/ui/action';
import { QuoteEditor, type QuoteEditorValue } from '@/components/sales/quote-editor';
import { QuoteConvert, type ConvertLine } from '@/components/sales/quote-convert';
import { QuoteDocument, quoteDocData } from '@/components/sales/quote-document';
import { QuoteBadge, quoteStatus } from '@/components/sales/quote-status';
import { date } from '@/lib/format';
import { quoteDocTitle } from '@/domain/documents';
import { deleteQuoteAction, setQuoteStatusAction } from '../actions';

export const metadata = { title: 'Ponuda' };

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('sales', 'view');
  const { id } = await params;
  const q = await getQuote(user.companyId, id);
  if (!q) notFound();
  const edit = can(user.perms, 'sales', 'edit');
  const st = quoteStatus(q.status, q.validUntil ? toISO(q.validUntil) : null);
  // pretvorena u račun ili ugovor — više se ne mijenja
  const locked = !!q.invoiceId || !!q.contractId;
  const [lookups, company] = await Promise.all([edit ? getSalesLookups(user.companyId) : null, getCompany(user.companyId)]);
  const proforma = q.kind === 'PROFORMA';
  const kindLabel = quoteDocTitle(q, company);
  const showCost = canSeeCost(user.perms);

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
              {kindLabel} {q.number} <QuoteBadge status={st} />
            </span>
          }
          subtitle={`${q.partner.name} · ${date(q.date)}${q.validUntil ? ` · vrijedi do ${date(q.validUntil)}` : ''}`}
          back={
            <Link prefetch={false} href={proforma ? '/prodaja/ponude?vrsta=PROFORMA' : '/prodaja/ponude'} className="hover:underline">
              ← {proforma ? 'Predračuni' : 'Ponude'}
            </Link>
          }
          actions={
            <>
              <LinkButton href={`/prodaja/ponude/${q.id}/ispis`} icon={<Printer className="size-4" />}>
                Ispis
              </LinkButton>
              <PdfButton kind={q.kind === 'PROFORMA' ? 'proforma' : 'quote'} id={q.id} send={edit} />
              {edit && <SendEmailButton kind={q.kind === 'PROFORMA' ? 'proforma' : 'quote'} id={q.id} />}
              {edit && !q.invoiceId && q.contractId && q.status !== 'REJECTED' && lookups && (
                <QuoteConvert
                  quoteId={q.id}
                  partnerId={q.partnerId}
                  models={lookups.models}
                  categories={lookups.categories}
                  warehouses={lookups.warehouses}
                  hasContract
                  showCost={showCost}
                  lines={convertLines(q)}
                />
              )}
              {edit && !locked && (
                <>
                  {/* na mobitelu promjene statusa i brisanje su iza gumba „Više" */}
                  <MoreMenu>
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
                      confirm={`${kindLabel} ${q.number} bit će trajno obrisan(a).`}
                      confirmLabel="Obriši"
                    >
                      Obriši
                    </ActionButton>
                  </MoreMenu>
                  {q.status !== 'REJECTED' && lookups && (
                    <QuoteConvert
                      quoteId={q.id}
                      partnerId={q.partnerId}
                      models={lookups.models}
                      categories={lookups.categories}
                      warehouses={lookups.warehouses}
                      canContract={can(user.perms, 'rentals', 'edit')}
                      showCost={showCost}
                      lines={convertLines(q)}
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
          {kindLabel} je pretvoren(a) u račun {q.invoice.number ?? '(nacrt)'} i više se ne mijenja.
        </Notice>
      )}
      {q.contract && (
        <Notice
          tone="ok"
          action={
            <LinkButton href={`/najam/ugovori/${q.contract.id}`} size="sm">
              Otvori ugovor
            </LinkButton>
          }
        >
          Stavke najma su na ugovoru {q.contract.number}.{!q.invoiceId && ' Račun (prodaja i prva rata najma) izradite gumbom „Pretvori u račun".'}
        </Notice>
      )}
      {st === 'EXPIRED' && !locked && <Notice tone="warn">Rok valjanosti ponude je istekao — produžite datum „Vrijedi do" ako je ponuda i dalje aktualna.</Notice>}
      {edit && !locked && lookups ? (
        <QuoteEditor
          initial={editorValue(q)}
          lookups={lookups}
          showCost={showCost}
          canCreateService={edit}
          stock={await stockByModel(user.companyId, [...new Set(q.lines.map((l) => l.modelId).filter((x): x is string => !!x))])}
        />
      ) : (
        <QuoteDocument q={quoteDocData(q)} company={company} party={q.partner} title={kindLabel} />
      )}
    </>
  );
}

function convertLines(q: QuoteDetail): ConvertLine[] {
  return q.lines.map((l) => ({
    id: l.id,
    kind: l.kind,
    description: l.description,
    qty: num(l.qty),
    modelId: l.modelId,
    itemId: l.itemId,
    serial: l.item?.serial ?? null,
    rent: l.lineType === 'RENT',
    // najam po ugovoru iz ponude: uređaj je već na tom ugovoru
    itemAvailable:
      !!l.item &&
      ((l.item.state === 'IN_STOCK' || l.item.state === 'RESERVED') && !l.item.contractItem
        ? true
        : l.lineType === 'RENT' && !!q.contractId && l.item.contractItem?.contractId === q.contractId),
  }));
}

function editorValue(q: QuoteDetail): QuoteEditorValue {
  return {
    id: q.id,
    kind: q.kind,
    title: q.title ?? '',
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
      lineType: l.lineType === 'RENT' ? 'RENT' : null,
      monthly: l.monthly === null ? null : num(l.monthly),
      serial: l.item?.serial ?? null,
    })),
  };
}
