import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { getMdmScope } from '@/server/mdm/scope';
import { orgOptions } from '@/server/queries/mdm';
import { PageHeader } from '@/components/ui/misc';
import { NewProfileForm } from '@/components/mdm/profile-form';
import { createProfileAction } from '../actions';

export const metadata = { title: 'Nova konfiguracija — MDM' };

export default async function NewProfilePage() {
  const user = await pageAccess('mdm', 'edit');
  const scope = await getMdmScope(user);
  const orgs = await orgOptions(scope, { activeOnly: true });
  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/mdm/profili" className="hover:underline">
            ← Konfiguracije
          </Link>
        }
        title="Nova konfiguracija"
        subtitle="Aplikacije, zaključani način, Wi-Fi i sustav uređujete nakon stvaranja."
      />
      <NewProfileForm action={createProfileAction} allowShared={scope.owner} orgs={orgs.map((o) => ({ value: o.id, label: o.label }))} />
    </>
  );
}
