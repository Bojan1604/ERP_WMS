import { pageAccess } from '@/server/auth';
import { PageHeader } from '@/components/ui/misc';

export default async function Dashboard() {
  const user = await pageAccess('dashboard');
  return <PageHeader title="Nadzorna ploča" subtitle={user.companyName} />;
}
