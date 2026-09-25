import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pageAccess } from '@/server/auth';
import { getCompany, getLookups, modelLabel } from '@/server/queries/lookups';
import { getPartner, partnerCounts, partnerPrices } from '@/server/queries/partners';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { Badge, PageHeader } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { PartnerForm } from '@/components/partners/partner-form';
import { PriceEditor } from '@/components/partners/price-editor';
import { ContractsTab, DevicesTab, InvoicesTab, LedgerTab } from '@/components/partners/tabs';
import { countryName } from '@/components/partners/countries';
import { eur } from '@/lib/format';
import { SendEmailButton } from '@/components/ui/send-email-button';
import { ClientSheetButton } from '@/components/partners/client-sheet-link';
import { deletePartnerAction, deletePriceAction, lookupPartnerAction, savePartnerAction, savePriceAction } from '../actions';

type Params = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const user = await pageAccess('partners');
  const p = await getPartner(user.companyId, (await params).id);
  return { title: p?.name ?? 'Partner' };
}

export default async function PartnerPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const user = await pageAccess('partners');
  const { id } = await params;
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : '';
  const [partner, company, counts] = await Promise.all([getPartner(user.companyId, id), getCompany(user.companyId), partnerCounts(user.companyId, id)]);
  if (!partner) notFound();
  const canEdit = can(user.perms, 'partners', 'edit');
  // računi, kartica i otvoreni iznos pripadaju prodaji, ugovori najmu
  const canSales = can(user.perms, 'sales');
  const canRentals = can(user.perms, 'rentals');
  const base = `/partneri/${id}`;

  return (
    <>
      <PageHeader
        back={
          <Link prefetch={false} href="/partneri" className="hover:underline">
            ← Partneri
          </Link>
        }
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            {partner.name}
            {partner.excluded && <Badge>isključen iz obračuna</Badge>}
          </span>
        }
        subtitle={[
          partner.oib && `OIB ${partner.oib}`,
          [partner.city, partner.country !== 'HR' ? countryName(partner.country) : null].filter(Boolean).join(', '),
          [partner.isCustomer && 'kupac', partner.isSupplier && 'dobavljač'].filter(Boolean).join(' i '),
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            {counts.devices > 0 && <ClientSheetButton partnerId={id} />}
            {canEdit && <SendEmailButton kind="partner" id={id} defaultTo={partner.email} defaultSubject={company.name} label="Pošalji e-mail" />}
            {canSales && counts.open > 0 ? (
              <div className="rounded-lg bg-bad-soft px-3 py-1.5 text-right">
                <p className="text-xs text-bad-strong">Otvoreno ({counts.openCount})</p>
                <p className="font-semibold text-bad-strong tnum">{eur(counts.open)}</p>
              </div>
            ) : null}
            {canSales && counts.overpaid > 0 ? (
              <div className="rounded-lg bg-warn-soft px-3 py-1.5 text-right" title="Preplata — kupac je platio više od iznosa računa">
                <p className="text-xs text-warn">Za povrat kupcu ({counts.overpaidCount})</p>
                <p className="font-semibold text-warn tnum">{eur(counts.overpaid)}</p>
              </div>
            ) : null}
          </>
        }
      />
      <Tabs
        param="tab"
        tabs={[
          { href: base, label: 'Podaci' },
          ...(canSales ? [{ href: `${base}?tab=racuni`, label: 'Računi', count: counts.invoices }] : []),
          { href: `${base}?tab=uredaji`, label: 'Uređaji', count: counts.devices },
          ...(canRentals ? [{ href: `${base}?tab=ugovori`, label: 'Ugovori', count: counts.contracts }] : []),
          { href: `${base}?tab=cjenik`, label: 'Cjenik', count: counts.prices },
          ...(canSales ? [{ href: `${base}?tab=kartica`, label: 'Kartica' }] : []),
          // portal za klijente (korisnici, prijave kvara) — zasebna stranica
          ...(partner.isCustomer ? [{ href: `${base}/portal?tab=portal`, label: 'Portal' }] : []),
        ]}
      />
      {tab === 'racuni' && canSales ? (
        <InvoicesTab companyId={user.companyId} partnerId={id} params={sp} overdueDays={company.overdueDays} />
      ) : tab === 'uredaji' ? (
        <DevicesTab companyId={user.companyId} partnerId={id} params={sp} />
      ) : tab === 'ugovori' && canRentals ? (
        <ContractsTab companyId={user.companyId} partnerId={id} />
      ) : tab === 'cjenik' ? (
        <PricesTab companyId={user.companyId} partnerId={id} canEdit={canEdit} />
      ) : tab === 'kartica' && canSales ? (
        <LedgerTab companyId={user.companyId} partnerId={id} params={sp} />
      ) : (
        <PartnerForm
          value={{
            id: partner.id,
            name: partner.name,
            oib: partner.oib,
            vatId: partner.vatId,
            address: partner.address,
            zip: partner.zip,
            city: partner.city,
            country: partner.country,
            email: partner.email,
            phone: partner.phone,
            iban: partner.iban,
            contactPerson: partner.contactPerson,
            isCustomer: partner.isCustomer,
            isSupplier: partner.isSupplier,
            excluded: partner.excluded,
            paymentTermDays: partner.paymentTermDays,
            note: partner.note,
            endpointId: partner.endpointId,
            vatCategoryOverride: partner.vatCategoryOverride,
            branchCode: partner.branchCode,
            branchName: partner.branchName,
          }}
          company={{ vatRegistered: company.vatRegistered, vatRate: num(company.vatRate), country: company.country, paymentTermDays: company.paymentTermDays }}
          save={savePartnerAction}
          lookup={lookupPartnerAction}
          remove={deletePartnerAction}
          canEdit={canEdit}
        />
      )}
    </>
  );
}

async function PricesTab({ companyId, partnerId, canEdit }: { companyId: string; partnerId: string; canEdit: boolean }) {
  const [rows, lookups] = await Promise.all([partnerPrices(companyId, partnerId), getLookups(companyId)]);
  return (
    <PriceEditor
      partnerId={partnerId}
      canEdit={canEdit}
      save={savePriceAction}
      remove={deletePriceAction}
      models={lookups.models.map((m) => ({ value: m.id, label: modelLabel(m), hint: m.salePrice ? eur(num(m.salePrice)) : undefined }))}
      rows={rows.map((r) => ({
        id: r.id,
        modelId: r.modelId,
        model: modelLabel(r.model),
        salePrice: r.salePrice === null ? null : num(r.salePrice),
        rentPrice: r.rentPrice === null ? null : num(r.rentPrice),
        listSale: r.model.salePrice === null ? null : num(r.model.salePrice),
        listRent: r.model.rentPrice === null ? null : num(r.model.rentPrice),
      }))}
    />
  );
}
