import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { getReceipt } from '@/server/queries/purchasing';
import { can, canSeeCost } from '@/domain/permissions';
import { db } from '@/server/db';
import { listAttachments } from '@/server/services/attachments';
import { Attachments } from '@/components/ui/attachments';
import { num } from '@/domain/money';
import { Badge, Notice } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { PrintButton } from '@/components/ui/print-button';
import { DocTable, DocTotals, DocumentShell, docDate } from '@/components/doc/document';
import { RECEIPT_STATUS } from '@/components/purchasing/labels';
import { amount, dateTime, eur } from '@/lib/format';
import { bookReceiptExpenseAction, cancelReceiptAction } from '../actions';
import { countLabel, plural } from '@/domain/plural';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'view');
  const { id } = await params;
  const [data, company, files] = await Promise.all([getReceipt(user.companyId, id), getCompany(user.companyId), listAttachments(db, user.companyId, 'receipt', [id])]);
  if (!data) notFound();
  const { receipt, groups, count, blocked } = data;
  const canEdit = can(user.perms, 'purchasing', 'edit');
  const costs = canSeeCost(user.perms);
  // ulazni računi povezani s primkom izravno ili preko narudžbenice
  const invoices = [...receipt.supplierInvoices, ...(receipt.order?.supplierInvoices ?? [])].filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i);
  const invoiceOwn = invoices.find((s) => s.expense && s.goodsInvoice);
  const cancelled = receipt.status === 'CANCELLED';
  const st = RECEIPT_STATUS[receipt.status];

  const meta: Array<[string, string]> = [
    ['Datum', docDate(receipt.date)],
    ['Skladište', receipt.warehouse.name],
    ...(receipt.order ? ([['Narudžbenica', receipt.order.number]] as Array<[string, string]>) : []),
    ...(receipt.supplierDocNumber ? ([['Dokument dobavljača', receipt.supplierDocNumber]] as Array<[string, string]>) : []),
  ];

  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link prefetch={false} href="/nabava/primke" className="text-sm text-fg-3 hover:text-fg">
            ← Primke
          </Link>
          <Badge tone={st.tone}>{st.label}</Badge>
          {receipt.order && (
            <Link prefetch={false} href={`/nabava/narudzbenice/${receipt.order.id}`} className="link text-sm">
              Narudžbenica {receipt.order.number}
            </Link>
          )}
          {invoices.map((s) => (
            <Link key={s.id} prefetch={false} href={`/nabava/ulazni/${s.id}`} className="link text-sm">
              Ulazni račun {s.internalNo} ({s.number})
            </Link>
          ))}
          {costs && receipt.expense && (
            <span className="text-sm text-fg-3">
              Trošak: {eur(num(receipt.expense.netAmount))} + PDV {eur(num(receipt.expense.vatAmount))}
            </span>
          )}
          {costs && !receipt.expense && !cancelled && (
            <span className="text-sm text-fg-3">{invoiceOwn
                ? `Trošak nabave primke nije knjižen — robu trenutno nosi ulazni račun ${invoiceOwn.internalNo}; knjiženjem primke račun knjiži samo razliku iznad primki.`
                : 'Trošak nabave nije knjižen.'}</span>
          )}
        </div>
        <div className="flex gap-2">
          {canEdit && !cancelled && receipt.supplierId && (
            <Link prefetch={false} href={`/nabava/ulazni/novi?primka=${id}`} className="link self-center text-sm">
              + Ulazni račun
            </Link>
          )}
          {canEdit && costs && !cancelled && !receipt.expense && num(receipt.total) > 0 && (
            <ActionButton action={bookReceiptExpenseAction} input={{ id }} confirm={`Knjižiti trošak nabave ${eur(num(receipt.total))} (primka ${receipt.number})?`} confirmLabel="Knjiži trošak">
              Knjiži trošak
            </ActionButton>
          )}
          {canEdit && !cancelled && (
            <ActionButton
              action={cancelReceiptAction}
              input={{ id, reason: null }}
              variant="danger"
              disabled={blocked.length > 0}
              title={blocked.length ? 'Neki uređaji s primke više nisu slobodni na skladištu' : undefined}
              confirmTitle={`Storno primke ${receipt.number}`}
              confirm={
                <>
                  Brišu se svi uređaji s primke ({count} kom) i knjiženi trošak, a zaprimljene količine na narudžbenici se vraćaju. Primka ostaje u
                  popisu kao stornirana.
                </>
              }
              confirmLabel="Storniraj"
            >
              Storniraj primku
            </ActionButton>
          )}
          <PrintButton />
        </div>
      </div>

      {!cancelled && blocked.length > 0 && (
        <Notice tone="info">
          Primka se ne može stornirati: {countLabel(blocked.length, 'uređaj', 'uređaja', 'uređaja')} više {plural(blocked.length, 'nije slobodan', 'nisu slobodna', 'nije slobodno')} na skladištu ili je na računu/ugovoru ({blocked.slice(0, 10).join(', ')}
          {blocked.length > 10 ? '…' : ''}).
        </Notice>
      )}

      <DocumentShell
        company={company}
        title={cancelled ? 'Primka — stornirana' : 'Primka'}
        number={receipt.number}
        meta={meta}
        party={receipt.supplier}
        partyLabel="Dobavljač"
        signatures={['Robu predao', 'Robu zaprimio']}
        footer={<p>Upisao: {receipt.createdBy ?? '—'} · {dateTime(receipt.createdAt)}</p>}
      >
        {groups.length ? (
          <DocTable
            head={['R. br.', 'Artikl', 'Serijski brojevi', 'Kol.', ...(costs ? ['Nabavna', 'Iznos'] : [])]}
            align={['left', 'left', 'left', 'right', 'right', 'right']}
            rows={groups.map((g, i) => [
              `${i + 1}.`,
              <span key="m">
                <b>{g.model}</b>
                {g.code && <span className="block text-black/60">{g.code}</span>}
              </span>,
              <span key="s" className="font-mono text-[10.5px] leading-snug break-words">
                {g.serials.join(', ')}
              </span>,
              `${g.qty} kom`,
              ...(costs ? [amount(g.unitCost), amount(g.total)] : []),
            ])}
          />
        ) : (
          <p className="text-black/60">Na primci nema uređaja{cancelled ? ' — obrisani su stornom.' : '.'}</p>
        )}
        <DocTotals
          rows={[
            ['Količina', `${count} kom`],
            ...(costs ? ([['Ukupno nabavna vrijednost (EUR)', amount(num(receipt.total)), true]] as Array<[string, string, boolean]>) : []),
          ]}
        />
        {receipt.note && <p className="mt-6 whitespace-pre-line text-[11px]">{receipt.note}</p>}
      </DocumentShell>
      <div className="no-print mx-auto mt-4 max-w-[210mm] rounded-lg bg-panel p-4 shadow-[var(--shadow-panel)]">
        <p className="mb-2 text-sm font-medium text-fg-2">Prilozi (otpremnica, sken)</p>
        <Attachments entity="receipt" id={id} canEdit={canEdit} initial={files} />
      </div>
    </>
  );
}
