import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getCompany, getLookups, modelLabel } from '@/server/queries/lookups';
import { receiveRequestForForm } from '@/server/services/receive-requests';
import { listAttachments } from '@/server/services/attachments';
import { canSeeCost } from '@/domain/permissions';
import { num } from '@/domain/money';
import { Notice, PageHeader } from '@/components/ui/misc';
import { ReceiveReview } from '@/components/warehouse/receive-review';
import { dateTime } from '@/lib/format';

/**
 * Provjera zahtjeva za zaprimanje po retku: slika naljepnice uz svaki kod,
 * model po retku, ispravak serijskog broja, preskakanje reda.
 */
export default async function ReceiveReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('warehouse', 'edit');
  const { id } = await params;
  const req = await receiveRequestForForm(db, user, id);
  const back = (
    <Link prefetch={false} href="/skladiste/odobrenja" className="hover:text-fg">
      ← Odobrenja
    </Link>
  );
  if (!req) {
    return (
      <>
        <PageHeader back={back} title="Zaprimanje po zahtjevu" />
        <Notice tone="warn">Zahtjev za zaprimanje ne postoji ili je već riješen.</Notice>
      </>
    );
  }
  const [lookups, company, returning, existing, files] = await Promise.all([
    getLookups(user.companyId),
    getCompany(user.companyId),
    req.returning.length
      ? db.item.findMany({
          where: { companyId: user.companyId, id: { in: req.returning } },
          select: { id: true, serial: true, status: { select: { name: true } }, partner: { select: { name: true } }, model: { select: { brand: true, name: true } } },
        })
      : [],
    // kodovi koji su u međuvremenu zaprimljeni (primka bi ih odbila)
    req.serials.length ? db.item.findMany({ where: { companyId: user.companyId, serial: { in: req.serials } }, select: { serial: true } }) : [],
    listAttachments(db, user.companyId, 'request', [req.id]),
  ]);
  const meta = new Map(files.map((f) => [f.id, f]));
  const photoFor = (code: string | null, itemId: string | null) => {
    const p = req.photos.find((x) => (itemId ? x.itemId === itemId : x.code === code));
    const f = p ? meta.get(p.id) : undefined;
    return f ? { id: f.id, fileName: f.fileName, mime: f.mime, size: f.size } : null;
  };
  const taken = new Set(existing.map((e) => e.serial));

  return (
    <>
      <PageHeader
        back={back}
        title="Zaprimanje po zahtjevu"
        subtitle={`${req.requestedBy} · ${dateTime(req.createdAt)} · ${req.serials.length} novih${req.returning.length ? `, ${req.returning.length} za povrat` : ''}`}
      />
      {req.note && <Notice tone="info">Napomena skladištara: {req.note}</Notice>}
      <ReceiveReview
        id={req.id}
        rows={req.serials.map((code) => ({ code, photo: photoFor(code, null), exists: taken.has(code) }))}
        returning={returning.map((i) => ({
          id: i.id,
          serial: i.serial,
          status: i.status.name,
          partner: i.partner?.name ?? null,
          model: modelLabel(i.model),
          photo: photoFor(null, i.id),
        }))}
        general={req.photos.filter((p) => !p.code && !p.itemId).flatMap((p) => {
          const f = meta.get(p.id);
          return f ? [{ id: f.id, fileName: f.fileName, mime: f.mime, size: f.size }] : [];
        })}
        models={lookups.models.map((m) => ({ value: m.id, label: modelLabel(m) }))}
        warehouses={lookups.warehouses.map((w) => ({ value: w.id, label: w.name }))}
        warehouseId={lookups.warehouses.some((w) => w.id === req.warehouseId) ? req.warehouseId : (lookups.warehouses[0]?.id ?? '')}
        canSeeCost={canSeeCost(user.perms)}
        company={{ vatRate: num(company.vatRate), country: company.country }}
      />
    </>
  );
}
