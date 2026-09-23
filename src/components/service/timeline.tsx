import { Badge } from '@/components/ui/misc';
import { dateTime } from '@/lib/format';
import { SERVICE_STATUS, type TimelineEntry } from './labels';

/** Tijek naloga — svaka promjena statusa i radnja nad uređajem, najnovije gore. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (!entries.length) return <p className="text-sm text-fg-3">Nema zapisa.</p>;
  return (
    <ol className="relative ml-1.5 border-l border-line-strong">
      {[...entries].reverse().map((e, i) => {
        const st = SERVICE_STATUS[e.status] ?? { label: e.status, tone: 'neutral' as const };
        return (
          <li key={`${e.at}-${i}`} className="mb-3 ml-4 last:mb-0">
            <span className="absolute -left-[5px] mt-1.5 size-2.5 rounded-full border-2 border-panel bg-brand" />
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="text-xs text-fg-3">
                {dateTime(e.at)} · {e.by}
              </span>
            </div>
            {e.note && <p className="mt-0.5 text-sm text-fg-2">{e.note}</p>}
          </li>
        );
      })}
    </ol>
  );
}
