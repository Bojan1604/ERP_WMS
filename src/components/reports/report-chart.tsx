import type { ReportChart as Spec } from '@/server/queries/reports';
import { BarChart } from '@/components/charts/bar-chart';
import { HBarChart } from '@/components/charts/hbar-chart';
import { Card } from '@/components/ui/misc';
import { amount, integer } from '@/lib/format';

const fmt = (unit?: 'money' | 'int') => (unit === 'int' ? (v: number) => integer(v) : (v: number) => `${amount(v)} €`);

export function ReportChart({ spec, title }: { spec: Spec; title: string }) {
  if (spec.kind === 'hbar') {
    if (!spec.rows.length) return null;
    return (
      <Card title={spec.title ?? title} className="mb-4">
        <HBarChart rows={spec.rows} format={fmt(spec.unit)} />
      </Card>
    );
  }
  if (!spec.data.some((d) => Object.values(d.values).some((v) => v))) return null;
  return (
    <Card title={title} className="mb-4">
      <BarChart data={spec.data} series={spec.series} stacked={spec.stacked ?? true} format={fmt(spec.unit)} height={spec.data.length > 8 ? 260 : 220} width={1100} ariaLabel={title} className="max-sm:hidden" />
      {/* mobitel: uži koordinatni sustav, da oznake osi ostanu čitljive */}
      <BarChart data={spec.data} series={spec.series} stacked={spec.stacked ?? true} format={fmt(spec.unit)} height={260} width={440} ariaLabel={title} className="sm:hidden" />
    </Card>
  );
}
