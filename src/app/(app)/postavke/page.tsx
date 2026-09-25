import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { PREFIX } from '@/server/numbering';
import { SERIES_LABEL, documentCounters } from '@/server/services/settings';
import { formatDocNumber, formatInvoiceNumber } from '@/domain/invoice';
import { today } from '@/domain/dates';
import { CompanyDocsForm } from '@/components/settings/company-docs-form';
import { CountersCard } from '@/components/settings/counters-card';
import { getCompany } from '@/server/queries/lookups';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { PageHeader } from '@/components/ui/misc';
import { CompanyForm } from '@/components/settings/company-form';
import { CompanyColorsCard } from '@/components/settings/company-colors';
import { runAutoIssueAction, saveCompanyAction, saveCompanyColorsAction, saveCompanyDocsAction, setCounterAction } from './actions';

type Params = Record<string, string | string[] | undefined>;
const SERIES = ['INVOICE', 'QUOTE', 'PROFORMA', 'CONTRACT', 'ORDER', 'RECEIPT', 'SERVICE', 'TRANSFER', 'SUPPLIER_INVOICE', 'STOCKTAKE'] as const;

export const metadata = { title: 'Postavke firme' };

export default async function CompanySettingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('settings');
  const sp = await searchParams;
  const now = Number(today().slice(0, 4));
  const wanted = Number(sp.brojevi);
  const year = Number.isInteger(wanted) && wanted >= now - 5 && wanted <= now + 1 ? wanted : now;
  const [c, counters] = await Promise.all([getCompany(user.companyId), documentCounters(db, user.companyId, year)]);
  const canEdit = can(user.perms, 'settings', 'edit');
  const counterRows = SERIES.map((series) => {
    const last = counters.counters.get(series) ?? 0;
    const floor = series === 'INVOICE' ? counters.maxInvoiceSeq : 0;
    const next = Math.max(last, floor) + 1;
    return {
      series,
      label: SERIES_LABEL[series][0].toUpperCase() + SERIES_LABEL[series].slice(1),
      last,
      floor,
      example: series === 'INVOICE' ? formatInvoiceNumber(next, c.invoicePremises, c.invoiceDevice, c.invoiceSeparator) : formatDocNumber(PREFIX[series], year, next),
    };
  });
  return (
    <>
      <PageHeader title="Firma i postavke" subtitle="Podaci za dokumente, porez, rokovi, cijene i numeracija računa" />
      <CompanyForm
        canEdit={canEdit}
        save={saveCompanyAction}
        value={{
          name: c.name,
          oib: c.oib,
          vatId: c.vatId,
          address: c.address,
          zip: c.zip,
          city: c.city,
          country: c.country,
          iban: c.iban,
          bank: c.bank,
          email: c.email,
          accountantEmail: c.accountantEmail,
          phone: c.phone,
          web: c.web,
          logo: c.logo,
          currency: c.currency,
          vatRegistered: c.vatRegistered,
          vatRate: num(c.vatRate),
          overdueDays: c.overdueDays,
          paymentTermDays: c.paymentTermDays,
          quoteValidDays: c.quoteValidDays,
          defaultMarginPct: num(c.defaultMarginPct),
          defaultWarrantyMonths: c.defaultWarrantyMonths,
          rentFallbackPct: num(c.rentFallbackPct),
          invoicePremises: c.invoicePremises,
          invoiceDevice: c.invoiceDevice,
          invoiceSeparator: c.invoiceSeparator,
          invoiceFooter: c.invoiceFooter,
          statusChangeNeedsApproval: c.statusChangeNeedsApproval,
        }}
      />
      <div className="mt-4" id="boje">
        <CompanyColorsCard canEdit={canEdit} save={saveCompanyColorsAction} value={{ brandColor: c.brandColor, menuColor: c.menuColor }} />
      </div>
      <h2 className="mt-6 mb-3 text-md font-semibold">Dokumenti, porez i eRačun</h2>
      <CompanyDocsForm
        canEdit={canEdit}
        save={saveCompanyDocsAction}
        runAutoIssue={runAutoIssueAction}
        canRunAutoIssue={can(user.perms, 'sales', 'edit')}
        value={{
          swift: c.swift, proformaTitle: c.proformaTitle, eInvoicePaymentMeans: c.eInvoicePaymentMeans, paymentModel: c.paymentModel,
          operatorName: c.operatorName, operatorOib: c.operatorOib, vatTextEuGoods: c.vatTextEuGoods, vatTextEuService: c.vatTextEuService,
          vatTextThirdGoods: c.vatTextThirdGoods, vatTextThirdService: c.vatTextThirdService, legalFooter: c.legalFooter, autoIssueRent: c.autoIssueRent,
          vatOnPayment: c.vatOnPayment, kpdRent: c.kpdRent, kpdSale: c.kpdSale, kpdService: c.kpdService, eInvoiceAttachPdf: c.eInvoiceAttachPdf,
          eReportingEnabled: c.eReportingEnabled,
        }}
      />
      <div className="mt-4">
        <CountersCard rows={counterRows} year={year} years={[now - 1, now, now + 1]} save={setCounterAction} canEdit={canEdit} />
      </div>
    </>
  );
}
