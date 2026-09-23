import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { myPendingCount, unseenRejections } from '@/server/queries/approvals';
import { can } from '@/domain/permissions';
import { Notice, PageHeader } from '@/components/ui/misc';
import { ScanStation } from '@/components/warehouse/scan-station';
import { AckButton } from '@/components/warehouse/approval-buttons';
import { dateTime } from '@/lib/format';

export default async function ScanPage() {
  const user = await pageAccess('warehouse', 'view');
  const canEdit = can(user.perms, 'warehouse', 'edit');
  const me = { id: user.id, name: user.name };
  const [lookups, company, rejected, pending] = await Promise.all([
    getLookups(user.companyId),
    db.company.findUniqueOrThrow({ where: { id: user.companyId }, select: { statusChangeNeedsApproval: true } }),
    // skladištar vidi odbijene zahtjeve dok ih ne potvrdi
    canEdit ? [] : unseenRejections(user.companyId, me),
    canEdit ? 0 : myPendingCount(user.companyId, me),
  ]);
  const perms = { canEdit, canOps: can(user.perms, 'warehouse', 'ops'), needsApproval: company.statusChangeNeedsApproval };
  const options = {
    statuses: lookups.statuses.map((s) => ({ id: s.id, name: s.name, kind: s.kind, color: s.color })),
    warehouses: lookups.warehouses.map((w) => ({ value: w.id, label: w.name })),
    models: lookups.models.map((m) => ({ value: m.id, label: modelLabel(m) })),
  };
  return (
    <>
      <PageHeader title="Skeniranje" subtitle={<span className="max-sm:hidden">Kamera, ručni čitač ili upis serijskog broja — uređaj i radnje na jednom mjestu</span>} />
      {rejected.map((r) => (
        <div key={r.id} data-rejected-request={r.id}>
          <Notice tone="bad" action={<AckButton id={r.id} />}>
            Odbijen zahtjev {r.kind === 'RECEIVE' ? 'za zaprimanje' : 'za promjenu statusa'} ({r.count} kom) — {r.resolvedBy}, {dateTime(r.resolvedAt)}
            {r.resolveNote && (
              <>
                : <b>{r.resolveNote}</b>
              </>
            )}
          </Notice>
        </div>
      ))}
      {pending > 0 && (
        <p className="mb-3 text-sm text-fg-3">
          Vaši zahtjevi na čekanju odobrenja: <b className="text-fg">{pending}</b> ·{' '}
          <Link prefetch={false} href="/skladiste/odobrenja" className="link">
            Moji zahtjevi
          </Link>
        </p>
      )}
      <ScanStation perms={perms} options={options} />
    </>
  );
}
