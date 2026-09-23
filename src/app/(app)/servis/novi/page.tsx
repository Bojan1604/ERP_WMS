import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { today } from '@/domain/dates';
import { PageHeader } from '@/components/ui/misc';
import { NewServiceForm, type DeviceInfo } from '@/components/service/new-service-form';
import { createServiceAction, deviceInfoAction, searchDevicesAction } from '../actions';

type Params = Record<string, string | string[] | undefined>;

export default async function NewServicePage({ searchParams }: { searchParams: Promise<Params> }) {
  await pageAccess('service', 'edit');
  const sp = await searchParams;
  // ?item=<id> — otvaranje naloga s kartice uređaja
  let initial: DeviceInfo | null = null;
  if (typeof sp.item === 'string' && sp.item) {
    const r = await deviceInfoAction({ id: sp.item });
    if (r.ok && r.data) initial = r.data;
  }
  return (
    <>
      <PageHeader
        title="Novi servisni nalog"
        back={
          <Link prefetch={false} href="/servis" className="hover:text-fg">
            ← Servis
          </Link>
        }
      />
      <NewServiceForm search={searchDevicesAction} info={deviceInfoAction} action={createServiceAction} today={today()} initial={initial} />
    </>
  );
}
