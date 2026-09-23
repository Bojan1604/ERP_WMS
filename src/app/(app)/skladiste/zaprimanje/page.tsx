import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { receiveRequestForForm } from '@/server/services/receive-requests';
import { listAttachments } from '@/server/services/attachments';
import { Notice, PageHeader } from '@/components/ui/misc';
import { ReceiveForm, type ReceiveRequestInfo } from '@/components/warehouse/receive-form';
import { MAX_RECEIVE, parseSerials } from '@/domain/warehouse';

type Params = Record<string, string | string[] | undefined>;

export default async function ReceivePage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'edit');
  const sp = await searchParams;
  // ?serijski=A,B,C — predaja iz skeniranja (veći popisi idu kroz sessionStorage)
  let initialSerials = typeof sp.serijski === 'string' ? parseSerials(sp.serijski).serials.slice(0, MAX_RECEIVE) : [];
  // ?zahtjev=<id> — „Provjeri i zaprimi" sa stranice Odobrenja
  const requestId = typeof sp.zahtjev === 'string' ? sp.zahtjev : null;
  const [lookups, req] = await Promise.all([getLookups(user.companyId), requestId ? receiveRequestForForm(db, user, requestId) : null]);

  let request: ReceiveRequestInfo | null = null;
  if (req) {
    const [items, files] = await Promise.all([
      req.returning.length
        ? db.item.findMany({ where: { companyId: user.companyId, id: { in: req.returning } }, select: { id: true, serial: true, status: { select: { name: true } } } })
        : [],
      listAttachments(db, user.companyId, 'request', [req.id]),
    ]);
    const meta = new Map(files.map((f) => [f.id, f]));
    initialSerials = req.serials;
    request = {
      id: req.id,
      requestedBy: req.requestedBy,
      createdAt: req.createdAt.toISOString(),
      warehouseId: req.warehouseId,
      note: req.note,
      returning: items.map((i) => ({ id: i.id, serial: i.serial, status: i.status.name })),
      photos: req.photos.flatMap((p) => {
        const f = meta.get(p.id);
        return f ? [{ id: p.id, code: p.code ?? items.find((i) => i.id === p.itemId)?.serial ?? null, mime: f.mime, fileName: f.fileName, size: f.size }] : [];
      }),
    };
  }

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href={request ? '/skladiste/odobrenja' : '/skladiste'} className="hover:text-fg">
            ← {request ? 'Odobrenja' : 'Skladište'}
          </Link>
        }
        title="Zaprimanje robe"
        subtitle="Skupni unos uređaja istog modela — nastaje primka i trošak nabave"
      />
      {requestId && !req && <Notice tone="warn">Zahtjev za zaprimanje ne postoji ili je već riješen.</Notice>}
      <ReceiveForm
        // novi zahtjev = svjež obrazac
        key={request?.id ?? 'form'}
        models={lookups.models.map((m) => ({ value: m.id, label: modelLabel(m) }))}
        warehouses={lookups.warehouses.map((w) => ({ value: w.id, label: w.name }))}
        initialSerials={initialSerials}
        request={request}
      />
    </>
  );
}
