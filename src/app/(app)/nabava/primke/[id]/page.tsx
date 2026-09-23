import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany } from '@/server/queries/lookups';
import { getReceipt } from '@/server/queries/purchasing';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { Badge, Notice } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { PrintButton } from '@/components/ui/print-button';
import { DocTable, DocTotals, DocumentShell, docDate } from '@/components/doc/document';
import { RECEIPT_STATUS } from '@/components/purchasing/labels';
import { amount, dateTime, eur } from '@/lib/format';
import { cancelReceiptAction } from '../actions';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('purchasing', 'view');
  const { id } = await params;
  const [data, company] = await Promise.all([getReceipt(user.companyId, id), getCompany(user.companyId)]);
  if (!data) notFound();
  const { receipt, groups, count, blocked } = data;
  const canEdit = can(user.perms, 'purchasing', 'edit');
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
          {receipt.expense && (
            <span className="text-sm text-fg-3">
              Trošak: {eur(num(receipt.expense.netAmount))} + PDV {eur(num(receipt.expense.vatAmount))}
            </span>
          )}
        </div>
        <div className="flex gap-2">
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
          Primka se ne može stornirati: {blocked.length} uređaja više nije slobodno na skladištu ili je na računu/ugovoru ({blocked.slice(0, 10).join(', ')}
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
            head={['R. br.', 'Artikl', 'Serijski brojevi', 'Kol.', 'Nabavna', 'Iznos']}
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
              amount(g.unitCost),
              amount(g.total),
            ])}
          />
        ) : (
          <p className="text-black/60">Na primci nema uređaja{cancelled ? ' — obrisani su stornom.' : '.'}</p>
        )}
        <DocTotals
          rows={[
            ['Količina', `${count} kom`],
            ['Ukupno nabavna vrijednost (EUR)', amount(num(receipt.total)), true],
          ]}
        />
        {receipt.note && <p className="mt-6 whitespace-pre-line text-[11px]">{receipt.note}</p>}
      </DocumentShell>
    </>
  );
}
