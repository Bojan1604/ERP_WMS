import { redirect } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { PageHeader } from '@/components/ui/misc';
import { ImportWizard } from '@/components/import/import-wizard';
import { estimateBackupBytes } from '@/server/import/backup';
import { MAX_UPLOAD_BYTES } from '@/server/import/upload';

export const metadata = { title: 'Uvoz i izvoz podataka' };

export default async function ImportPage() {
  const user = await pageAccess('settings', 'edit');
  if (user.role !== 'ADMIN') redirect('/zabranjeno?modul=settings');
  const [items, invoices, partners, backupBytes] = await Promise.all([
    db.item.count({ where: { companyId: user.companyId } }),
    db.invoice.count({ where: { companyId: user.companyId } }),
    db.partner.count({ where: { companyId: user.companyId } }),
    estimateBackupBytes(user.companyId),
  ]);
  return (
    <>
      <PageHeader
        title="Uvoz i izvoz podataka"
        subtitle="Prijenos baze iz stare verzije programa (JSON), sigurnosna kopija ove firme i vraćanje iz nje"
      />
      <ImportWizard company={{ name: user.companyName, items, invoices, partners, backupBytes }} maxUploadBytes={MAX_UPLOAD_BYTES} userEmail={user.email} />
    </>
  );
}
