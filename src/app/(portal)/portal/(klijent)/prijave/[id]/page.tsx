import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FileText } from 'lucide-react';
import { portalPage } from '@/server/portal/auth';
import { portalOrder } from '@/server/portal/queries';
import { Badge, Card, Detail } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { SERVICE_STATUS, isOpenService, type ServiceStatusCode } from '@/components/service/labels';
import { publicTimeline } from '@/domain/portal';
import { isImageMime } from '@/domain/attachments';
import { date, dateTime } from '@/lib/format';
import { cn } from '@/lib/cn';

export const metadata = { title: 'Prijava kvara' };

const modelName = (m: { brand: string | null; name: string } | null | undefined) => (m ? [m.brand, m.name].filter(Boolean).join(' ') : '');

/** Tijek jednog naloga: statusi, poruka servisa, zamjenski uređaj, fotografije, nalog za dostavu. */
export default async function PortalOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await portalPage();
  const { id } = await params;
  const o = await portalOrder(user, id);
  if (!o) notFound();
  const open = isOpenService(o.status);
  const steps = publicTimeline(o.timeline, { at: o.createdAt.toISOString(), status: o.status });
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <Link prefetch={false} href="/portal/prijave" className="text-sm text-fg-3 hover:underline">
            ← Moje prijave
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl">
            <span className="font-mono">{o.number}</span>
            <Badge tone={open ? 'warn' : 'ok'}>{SERVICE_STATUS[o.status as ServiceStatusCode].label}</Badge>
          </h1>
          <p className="text-sm text-fg-3">
            {modelName(o.item?.model)} · <span className="font-mono">{o.item?.serial ?? o.serial}</span>
          </p>
        </div>
        {open && (
          <LinkButton href={`/portal/prijave/${o.id}/dostava`} icon={<FileText className="size-4" />}>
            Nalog za dostavu
          </LinkButton>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Prijava">
          <dl>
            <Detail label="Prijavljeno">{date(o.reportedAt)}</Detail>
            {o.receivedAt && <Detail label="Zaprimljeno">{date(o.receivedAt)}</Detail>}
            {o.closedAt && <Detail label="Zatvoreno">{date(o.closedAt)}</Detail>}
            <Detail label="Jamstvo">{o.underWarranty ? 'u jamstvu' : 'izvan jamstva'}</Detail>
            {o.contact && <Detail label="Kontakt">{o.contact}</Detail>}
          </dl>
          <p className="mt-3 text-sm font-medium text-fg-2">Prijavljeni kvar</p>
          <p className="whitespace-pre-line">{o.issue}</p>
          {o.solution && (
            <>
              <p className="mt-3 text-sm font-medium text-fg-2">Rješenje</p>
              <p className="whitespace-pre-line">{o.solution}</p>
            </>
          )}
          {o.publicNote && (
            <div className="mt-3 rounded-md bg-info-soft px-3 py-2 text-info">
              <p className="text-xs font-semibold uppercase tracking-wide">Poruka servisa</p>
              <p className="whitespace-pre-line">{o.publicNote}</p>
            </div>
          )}
        </Card>

        <Card title="Tijek">
          <ol className="relative space-y-4 border-l border-line pl-5">
            {steps.map((s, i) => (
              <li key={i} className="relative">
                <span className={cn('absolute -left-[26px] top-1 size-3 rounded-full ring-4 ring-panel', isOpenService(s.status) ? 'bg-warn' : 'bg-ok')} />
                <p className="font-medium">{SERVICE_STATUS[s.status as ServiceStatusCode]?.label ?? s.status}</p>
                <p className="text-xs text-fg-3">{dateTime(s.at)}</p>
              </li>
            ))}
          </ol>
          {o.replacement && (
            <div className="mt-4 rounded-md bg-ok-soft px-3 py-2">
              <p className="text-sm font-medium text-ok">Poslan zamjenski uređaj: {modelName(o.replacement.model)}</p>
              <p className="mt-1 font-mono text-lg font-semibold break-all">{o.replacement.serial}</p>
              {o.replacement.issueDate && <p className="text-xs text-fg-3">{date(o.replacement.issueDate)}</p>}
            </div>
          )}
        </Card>
      </div>

      {o.photos.length > 0 && (
        <Card title={`Fotografije (${o.photos.length})`} className="mt-3">
          <div className="flex flex-wrap gap-2">
            {o.photos.map((p) =>
              isImageMime(p.mime) ? (
                <a key={p.id} href={`/portal/api/prilozi/${p.id}`} target="_blank" rel="noreferrer" title={p.fileName}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/portal/api/prilozi/${p.id}`} alt={p.fileName} loading="lazy" className="size-24 rounded-md border border-line object-cover" />
                </a>
              ) : (
                <a key={p.id} href={`/portal/api/prilozi/${p.id}`} target="_blank" rel="noreferrer" className="flex size-24 flex-col items-center justify-center gap-1 rounded-md border border-line p-1 text-center text-xs text-fg-2">
                  <FileText className="size-6 text-bad" />
                  <span className="line-clamp-2 break-all">{p.fileName}</span>
                </a>
              ),
            )}
          </div>
        </Card>
      )}
    </>
  );
}
