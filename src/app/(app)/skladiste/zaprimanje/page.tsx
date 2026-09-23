import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { getLookups, modelLabel } from '@/server/queries/lookups';
import { PageHeader } from '@/components/ui/misc';
import { ReceiveForm } from '@/components/warehouse/receive-form';

export default async function ReceivePage() {
  const user = await pageAccess('warehouse', 'edit');
  const lookups = await getLookups(user.companyId);
  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/skladiste" className="hover:text-fg">
            ← Skladište
          </Link>
        }
        title="Zaprimanje robe"
        subtitle="Skupni unos uređaja istog modela — nastaje primka i trošak nabave"
      />
      <ReceiveForm
        models={lookups.models.map((m) => ({ value: m.id, label: modelLabel(m) }))}
        warehouses={lookups.warehouses.map((w) => ({ value: w.id, label: w.name }))}
      />
    </>
  );
}
