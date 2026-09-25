import Link from 'next/link';
import { Camera, Inbox, ShieldCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { approvalRequests, type ApprovalRow } from '@/server/queries/approvals';
import { getLookups } from '@/server/queries/lookups';
import { can } from '@/domain/permissions';
import { Badge, Card, COLOR_TONE, Empty, PageHeader } from '@/components/ui/misc';
import { AckButton, ApprovalButtons, ReceiveApprovalButtons, RejectButton } from '@/components/warehouse/approval-buttons';
import { AttachmentGallery } from '@/components/warehouse/attachments';
import { dateTime } from '@/lib/format';
import { countLabel, plural } from '@/domain/plural';

type Option = { value: string; label: string };

export default async function ApprovalsPage() {
  const user = await pageAccess('warehouse', 'view');
  const canEdit = can(user.perms, 'warehouse', 'edit');
  // administrator vidi sve zahtjeve firme, skladištar samo svoje (ishod i razlog odbijanja)
  const [{ pending, resolved }, lookups] = await Promise.all([
    approvalRequests(user.companyId, canEdit ? {} : { mine: { id: user.id, name: user.name } }),
    canEdit ? getLookups(user.companyId) : null,
  ]);
  const warehouses: Option[] = lookups?.warehouses.map((w) => ({ value: w.id, label: w.name })) ?? [];
  const actions = (r: ApprovalRow) => {
    if (!canEdit) return null;
    if (r.kind === 'RECEIVE') {
      return <ReceiveApprovalButtons id={r.id} serials={r.serials.length} returning={r.items.length} warehouseId={r.warehouse?.id ?? null} warehouses={warehouses} />;
    }
    // vlastiti zahtjev odobrava drugi korisnik (services/warehouse resolveApproval) — ostaje samo odbijanje (povlačenje)
    if (r.requesterId ? r.requesterId === user.id : r.requestedBy === user.name) {
      return (
        <div className="flex flex-col items-end gap-1">
          <RejectButton id={r.id} />
          <span className="text-xs text-fg-3">Vlastiti zahtjev odobrava drugi korisnik.</span>
        </div>
      );
    }
    return <ApprovalButtons id={r.id} count={r.items.length} onContract={r.items.filter((i) => i.contractItem).length} target={r.target?.name ?? '—'} targetKind={r.target?.kind ?? ''} />;
  };

  return (
    <>
      <PageHeader
        title="Odobrenja"
        subtitle={canEdit ? 'Zahtjevi za promjenu statusa i zaprimanje robe koje šalju korisnici s operativnom razinom' : 'Moji zahtjevi za promjenu statusa i zaprimanje robe'}
      />
      <h2 className="mb-2 text-md font-semibold">
        {canEdit ? 'Na čekanju' : 'Moji zahtjevi na čekanju'} ({pending.length})
      </h2>
      {pending.length ? (
        <div className="space-y-3">
          {pending.map((r) => (
            <RequestCard key={r.id} r={r} actions={actions(r)} />
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon={<ShieldCheck className="size-5" />} title="Nema zahtjeva na čekanju" />
        </Card>
      )}

      {resolved.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-md font-semibold">{canEdit ? 'Nedavno riješeni' : 'Moji riješeni zahtjevi'}</h2>
          <div className="space-y-3">
            {resolved.map((r) => (
              <RequestCard key={r.id} r={r} actions={!canEdit && r.status === 'REJECTED' && !r.ack ? <AckButton id={r.id} /> : null} />
            ))}
          </div>
        </>
      )}
    </>
  );
}


function RequestCard({ r, actions }: { r: ApprovalRow; actions?: React.ReactNode }) {
  return (
    <Card padded>
      <div className="flex flex-wrap items-start justify-between gap-3" data-request={r.id} data-kind={r.kind}>
        <div className="min-w-0 flex-1 space-y-1">
          {r.kind === 'RECEIVE' ? (
            <p className="text-base">
              <Badge tone="warn">
                <Inbox className="size-3" /> Zaprimanje
              </Badge>{' '}
              <b>{r.requestedBy}</b> šalje na zaprimanje
              {r.serials.length > 0 && (
                <>
                  {' '}
                  <b>{r.serials.length}</b> {plural(r.serials.length, 'novi uređaj', 'nova uređaja', 'novih uređaja')}
                </>
              )}
              {r.serials.length > 0 && r.items.length > 0 && ' i'}
              {r.items.length > 0 && (
                <>
                  {' '}
                  <b>{r.items.length}</b> za povrat na skladište
                </>
              )}
              {r.warehouse && <> → {r.warehouse.name}</>}
            </p>
          ) : (
            <p className="text-base">
              <b>{r.requestedBy}</b> traži promjenu statusa za <b>{r.items.length}</b> {r.items.length === 1 ? 'uređaj' : 'uređaja'} u{' '}
              {r.target ? <Badge tone={COLOR_TONE[r.target.color] ?? 'neutral'}>{r.target.name}</Badge> : <span className="text-fg-3">obrisan status</span>}
            </p>
          )}
          <p className="text-xs text-fg-3">
            {dateTime(r.createdAt)}
            {r.missing > 0 && ` · ${countLabel(r.missing, 'uređaj', 'uređaja', 'uređaja')} više ne ${plural(r.missing, 'postoji', 'postoje', 'postoji')}`}
            {r.kind === 'RECEIVE' && r.photos.length > 0 && ` · slika: ${r.photos.length}`}
          </p>
          {r.note && <p className="text-sm text-fg-2">Napomena: {r.note}</p>}
          {r.kind === 'RECEIVE' && r.serials.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1" data-serials>
              {r.serials.slice(0, 80).map((s) => {
                const photo = r.photos.some((p) => p.code === s);
                return (
                  <span key={s} className="inline-flex items-center gap-1 rounded bg-warn-soft px-1.5 py-0.5 font-mono text-xs text-warn" title={photo ? 'Ima sliku naljepnice' : 'Novi serijski broj'}>
                    {s}
                    {photo && <Camera className="size-3" />}
                  </span>
                );
              })}
              {r.serials.length > 80 && <span className="text-xs text-fg-3">… i još {r.serials.length - 80}</span>}
            </div>
          )}
          {r.items.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {r.items.slice(0, 60).map((i) => (
                <Link prefetch={false} key={i.id} href={`/skladiste/${i.id}`} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-line" title={`Sada: ${i.status.name}`}>
                  {i.serial}
                  {i.dupNote ? ` (${i.dupNote})` : ''}
                  {r.kind === 'RECEIVE' && <span className="font-sans text-fg-3"> · {i.status.name}</span>}
                </Link>
              ))}
              {r.items.length > 60 && <span className="text-xs text-fg-3">… i još {r.items.length - 60}</span>}
            </div>
          )}
          {r.kind === 'RECEIVE' && r.photos.length > 0 && (
            <AttachmentGallery
              className="pt-2"
              items={r.photos.map((p) => {
                const serial = p.code ?? r.items.find((i) => i.id === p.itemId)?.serial ?? null;
                return { ...p, label: serial, caption: serial ? `Serijski: ${serial}` : 'Općenita slika' };
              })}
            />
          )}
          {r.status !== 'PENDING' && (
            <p className="pt-1 text-sm">
              <Badge tone={r.status === 'APPROVED' ? 'ok' : 'bad'}>{r.status === 'APPROVED' ? 'Odobreno' : 'Odbijeno'}</Badge>{' '}
              <span className="text-fg-3">
                {r.resolvedBy} · {dateTime(r.resolvedAt)}
              </span>
              {r.resolveNote && <span className={r.status === 'REJECTED' ? 'text-bad-strong' : 'text-fg-2'}> — {r.resolveNote}</span>}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap gap-2 max-sm:w-full">{actions}</div>}
      </div>
    </Card>
  );
}
