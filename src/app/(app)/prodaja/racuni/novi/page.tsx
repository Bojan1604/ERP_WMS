import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { getSalesLookups, hideDeviceCost, searchDevices } from '@/server/queries/sales';
import { can, canSeeCost } from '@/domain/permissions';
import { PageHeader, Notice } from '@/components/ui/misc';
import { InvoiceEditor } from '@/components/sales/invoice-editor';
import { newInvoiceValue } from '@/components/sales/editor-init';

export const metadata = { title: 'Novi račun' };

/**
 * Novi račun. Iz skladišta („Izašlo iz skladišta") dolazi s
 * ?items=id1,id2&partner=ID — uređaji su odmah na računu po cijeni za kupca;
 * uz &vrsta=najam kao račun za najam (mjesečna cijena, odabir ugovora).
 */
export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await pageAccess('sales', 'edit');
  const sp = await searchParams;
  const lookups = await getSalesLookups(user.companyId, [typeof sp.partner === 'string' ? sp.partner : null]);
  const partnerId = typeof sp.partner === 'string' && lookups.partners.some((p) => p.id === sp.partner) ? sp.partner : null;
  const wanted = typeof sp.items === 'string' ? [...new Set(sp.items.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 500) : [];
  const rent = sp.vrsta === 'najam';
  const devices = hideDeviceCost(wanted.length ? await searchDevices(user.companyId, { itemIds: wanted, partnerId }) : [], canSeeCost(user.perms));
  const missing = wanted.length - devices.length;

  return (
    <>
      <PageHeader
        title={rent ? 'Novi račun za najam' : 'Novi račun'}
        back={
          <Link prefetch={false} href="/prodaja/racuni" className="hover:underline">
            ← Računi
          </Link>
        }
      />
      {missing > 0 && (
        <Notice tone="warn">
          {missing === 1 ? 'Jedan odabrani uređaj nije raspoloživ' : `${missing} odabranih uređaja nije raspoloživo`} za prodaju (nije na skladištu ili je na
          ugovoru) i nije dodan na račun.
        </Notice>
      )}
      <InvoiceEditor
        initial={newInvoiceValue(lookups, partnerId, devices, rent ? 'RENT' : 'SALE')}
        lookups={lookups}
        showCost={canSeeCost(user.perms)}
        canCreateService={can(user.perms, 'sales', 'edit')}
      />
    </>
  );
}
