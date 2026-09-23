import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { approvalRequests } from '@/server/queries/warehouse';
import { can } from '@/domain/permissions';
import { Badge, Card, COLOR_TONE, Empty, PageHeader } from '@/components/ui/misc';
import { ApprovalButtons } from '@/components/warehouse/approval-buttons';
import { dateTime } from '@/lib/format';

type Req = Awaited<ReturnType<typeof approvalRequests>>['pending'][number];

export default async function ApprovalsPage() {
  const user = await pageAccess('warehouse', 'view');
  const { pending, resolved } = await approvalRequests(user.companyId);
  const canEdit = can(user.perms, 'warehouse', 'edit');
  return (
    <>
      <PageHeader title="Odobrenja" subtitle="Zahtjevi za promjenu statusa uređaja koje šalju korisnici s operativnom razinom" />
      <h2 className="mb-2 text-md font-semibold">Na čekanju ({pending.length})</h2>
      {pending.length ? (
        <div className="space-y-3">
          {pending.map((r) => (
            <RequestCard key={r.id} r={r} actions={canEdit ? <ApprovalButtons id={r.id} count={r.items.length} onContract={r.items.filter((i) => i.contractItem).length} target={r.target?.name ?? '—'} targetKind={r.target?.kind ?? ''} /> : null} />
          ))}
        </div>
      ) : (
        <Card>
          <Empty icon={<ShieldCheck className="size-5" />} title="Nema zahtjeva na čekanju" />
        </Card>
      )}

      {resolved.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-md font-semibold">Nedavno riješeni</h2>
          <div className="space-y-3">
            {resolved.map((r) => (
              <RequestCard key={r.id} r={r} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function RequestCard({ r, actions }: { r: Req; actions?: React.ReactNode }) {
  return (
    <Card padded>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-base">
            <b>{r.requestedBy}</b> traži promjenu statusa za <b>{r.items.length}</b> {r.items.length === 1 ? 'uređaj' : 'uređaja'} u{' '}
            {r.target ? <Badge tone={COLOR_TONE[r.target.color] ?? 'neutral'}>{r.target.name}</Badge> : <span className="text-fg-3">obrisan status</span>}
          </p>
          <p className="text-xs text-fg-3">
            {dateTime(r.createdAt)}
            {r.missing > 0 && ` · ${r.missing} uređaja više ne postoji`}
          </p>
          {r.note && <p className="text-sm text-fg-2">Napomena: {r.note}</p>}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {r.items.slice(0, 60).map((i) => (
              <Link prefetch={false} key={i.id} href={`/skladiste/${i.id}`} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-line" title={`Sada: ${i.status.name}`}>
                {i.serial}
                {i.dupNote ? ` (${i.dupNote})` : ''}
              </Link>
            ))}
            {r.items.length > 60 && <span className="text-xs text-fg-3">… i još {r.items.length - 60}</span>}
          </div>
          {r.status !== 'PENDING' && (
            <p className="pt-1 text-sm">
              <Badge tone={r.status === 'APPROVED' ? 'ok' : 'bad'}>{r.status === 'APPROVED' ? 'Odobreno' : 'Odbijeno'}</Badge>{' '}
              <span className="text-fg-3">
                {r.resolvedBy} · {dateTime(r.resolvedAt)}
              </span>
              {r.resolveNote && <span className="text-fg-2"> — {r.resolveNote}</span>}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
    </Card>
  );
}
