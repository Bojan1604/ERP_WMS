import Link from 'next/link';
import { BarChart3, ChevronRight } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { REPORT_AREAS, visibleReports } from '@/server/queries/reports';
import { canSeeCost } from '@/domain/permissions';
import { PageHeader } from '@/components/ui/misc';

export const metadata = { title: 'Izvještaji' };

export default async function ReportsIndex() {
  const user = await pageAccess('reports');
  const REPORTS = visibleReports({ canSeeCost: canSeeCost(user.perms) });
  return (
    <>
      <PageHeader title="Izvještaji" subtitle={`${REPORTS.length} izvještaja · brojke bez PDV-a, bez partnera isključenih iz obračuna`} />
      <div className="columns-1 gap-4 md:columns-2 2xl:columns-3">
        {REPORT_AREAS.map((area) => {
          const list = REPORTS.filter((r) => r.area === area);
          if (!list.length) return null;
          return (
            <section key={area} className="mb-4 break-inside-avoid rounded-lg bg-panel shadow-[var(--shadow-panel)]">
              <h2 className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-md font-semibold">
                <BarChart3 className="size-4 text-fg-3" />
                {area}
              </h2>
              <ul>
                {list.map((r) => (
                  <li key={r.slug} className="border-b border-line/70 last:border-0">
                    <Link prefetch={false} href={`/izvjestaji/${r.slug}`} className="group flex items-center gap-3 px-4 py-2.5 hover:bg-panel-2">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-fg group-hover:text-brand">{r.title}</span>
                        <span className="block text-sm text-fg-3">{r.description}</span>
                      </span>
                      <ChevronRight className="size-4 shrink-0 text-fg-4" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
