import Link from 'next/link';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can, resolvePermissions, type Level } from '@/domain/permissions';
import { certWarnings, fiscalReadiness, type CertSummary } from '@/domain/fiscal';
import { Badge, Card, PageHeader, TableWrap } from '@/components/ui/misc';
import { CertCard, FiscalSettingsForm, FiscalTools } from '@/components/settings/fiscal-settings';
import { dateTime } from '@/lib/format';

export const metadata = { title: 'Fiskalizacija' };

const KIND_LABEL: Record<string, string> = { FISCAL: 'CIS', EINVOICE: 'eRačun', PAYMENT_REPORT: 'Naplata', INBOUND: 'Ulazni eRačun' };

export default async function FiscalSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await pageAccess('settings');
  const sp = await searchParams;
  const invoiceFilter = sp.racun || null;
  const canEdit = can(user.perms, 'settings', 'edit');

  const [c, users, logs, pending] = await Promise.all([
    db.company.findUniqueOrThrow({
      where: { id: user.companyId },
      select: {
        oib: true,
        fiscalEnabled: true,
        fiscalEnv: true,
        fiscalSequenceMode: true,
        eInvoiceProvider: true,
        invoicePremises: true,
        invoiceDevice: true,
        fiscalCertInfo: true,
        eInvoiceApiKey: true,
        fiscalCertPassword: true,
        operatorOib: true,
        operatorName: true,
      },
    }),
    db.user.findMany({ where: { companyId: user.companyId, active: true }, select: { name: true, oib: true, role: true, permissions: true }, orderBy: { name: 'asc' } }),
    db.fiscalLog.findMany({
      where: { companyId: user.companyId, ...(invoiceFilter ? { invoiceId: invoiceFilter } : {}) },
      orderBy: { at: 'desc' },
      take: 50,
    }),
    db.invoice.count({ where: { companyId: user.companyId, status: 'ISSUED', fiscalStatus: { in: ['PENDING', 'FAILED'] } } }),
  ]);
  const invoiceIds = [...new Set(logs.map((l) => l.invoiceId).filter((x): x is string => !!x))];
  const numbers = new Map(
    (invoiceIds.length ? await db.invoice.findMany({ where: { id: { in: invoiceIds }, companyId: user.companyId }, select: { id: true, number: true } }) : []).map((i) => [i.id, i.number]),
  );

  const cert = c.fiscalCertPassword ? (c.fiscalCertInfo as unknown as CertSummary | null) : null;
  // operateri: aktivni korisnici koji smiju izdavati račune
  const operators = users.filter((u) => can(resolvePermissions(u.role, u.permissions as Record<string, Level>), 'sales', 'edit'));
  const readiness = fiscalReadiness({
    company: {
      oib: c.oib,
      fiscalEnabled: c.fiscalEnabled,
      fiscalEnv: c.fiscalEnv,
      invoicePremises: c.invoicePremises,
      invoiceDevice: c.invoiceDevice,
      eInvoiceProvider: c.eInvoiceProvider,
      hasApiKey: !!c.eInvoiceApiKey,
      cert,
      operatorOib: c.operatorOib,
      operatorName: c.operatorName,
    },
    operators,
  });

  return (
    <>
      <PageHeader
        title="Fiskalizacija i eRačun"
        subtitle={`CIS (gotovina, kartice, krajnji kupci) · eRačun preko posrednika (poslovni subjekti) · okruženje ${c.fiscalEnv}${c.fiscalEnabled ? '' : ' · isključeno'}`}
        actions={canEdit ? <FiscalTools pending={pending} /> : null}
      />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-4">
          <FiscalSettingsForm
            canEdit={canEdit}
            value={{
              fiscalEnabled: c.fiscalEnabled,
              fiscalEnv: c.fiscalEnv === 'PROD' ? 'PROD' : 'TEST',
              fiscalSequenceMode: c.fiscalSequenceMode === 'N' ? 'N' : 'P',
              eInvoiceProvider: (['none', 'demo', 'eposlovanje', 'moj-eracun'].includes(c.eInvoiceProvider) ? c.eInvoiceProvider : 'none') as 'none',
              hasApiKey: !!c.eInvoiceApiKey,
              hasCert: !!cert,
            }}
          />
          <CertCard cert={cert} warnings={certWarnings(cert, c.oib)} canEdit={canEdit} />
        </div>
        <Card title="Spremnost za produkciju" padded={false}>
          <ul>
            {readiness.map((r) => (
              <li key={r.key} className="flex gap-2.5 border-b border-line/70 px-4 py-2.5 last:border-0">
                {r.ok && !r.warn ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
                ) : r.ok || r.warn ? (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-bad-strong" />
                )}
                <div className="min-w-0">
                  <p className="text-base font-medium">{r.label}</p>
                  {r.hint && <p className="text-xs break-words text-fg-3">{r.hint}</p>}
                </div>
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-4 py-2.5 text-xs text-fg-3">
            OIB firme i oznake prostora/uređaja: <Link prefetch={false} href="/postavke" className="link">Postavke → Firma</Link> · OIB operatera:{' '}
            <Link prefetch={false} href="/postavke/korisnici" className="link">Korisnici</Link>
          </p>
        </Card>
      </div>

      <h2 className="mt-6 mb-2 flex items-center gap-2 text-md font-semibold">
        Dnevnik slanja {invoiceFilter ? `— račun ${numbers.get(invoiceFilter) ?? ''}` : '(zadnjih 50)'}
        {invoiceFilter && (
          <Link prefetch={false} href="/postavke/fiskalizacija" className="link text-sm font-normal">
            prikaži sve
          </Link>
        )}
      </h2>
      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>Vrijeme</th>
              <th>Vrsta</th>
              <th>Račun</th>
              <th>Ishod</th>
              <th>Poruka / sadržaj</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-fg-3">
                  Nema zapisa.
                </td>
              </tr>
            )}
            {logs.map((l) => {
              const demo = /\[DEMO/.test(l.request ?? '') || /"demo":true/.test(l.response ?? '');
              return (
                <tr key={l.id}>
                  <td className="whitespace-nowrap">{dateTime(l.at)}</td>
                  <td className="whitespace-nowrap">
                    {KIND_LABEL[l.kind] ?? l.kind}
                    {demo && (
                      <Badge tone="info" className="ml-1.5">
                        demo
                      </Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {l.invoiceId ? (
                      <Link prefetch={false} href={`/prodaja/racuni/${l.invoiceId}`} className="link">
                        {numbers.get(l.invoiceId) ?? '—'}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    <Badge tone={l.ok ? 'ok' : 'bad'}>{l.ok ? 'uspjeh' : 'greška'}</Badge>
                  </td>
                  <td className="max-w-[40rem] text-sm">
                    {l.error && <p className="text-bad-strong">{l.error}</p>}
                    {(l.request || l.response) && (
                      <details>
                        <summary className="cursor-pointer text-fg-3">zahtjev i odgovor</summary>
                        {l.request && <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap break-all">{l.request}</pre>}
                        {l.response && <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap break-all">{l.response}</pre>}
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
    </>
  );
}
