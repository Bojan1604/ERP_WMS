import type { Prisma } from '@prisma/client';
import { Mail } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can } from '@/domain/permissions';
import { readTemplates } from '@/domain/mail';
import { isMailConfigured } from '@/server/mail/transport';
import { Badge, Card, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { MailSettingsForm, MailTemplatesForm, MailTestCard } from '@/components/mail/mail-settings';
import { dateTime } from '@/lib/format';
import { escapeLike } from '@/lib/like';

export const metadata = { title: 'E-pošta' };

type Params = Record<string, string | string[] | undefined>;

const KIND_LABEL: Record<string, string> = {
  invoice: 'Račun',
  quote: 'Ponuda',
  proforma: 'Predračun',
  delivery: 'Otpremnica',
  service: 'Servisni nalog',
  partner: 'Partner',
  'accountant-zip': 'Knjigovođa (ZIP)',
  reminder: 'Opomena',
  test: 'Probna poruka',
};
const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v.trim() : '');

/** Postavke slanja e-pošte (SMTP), predlošci poruka i dnevnik poslanih poruka. */
export default async function MailSettingsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('settings');
  const params = await searchParams;
  const canEdit = can(user.perms, 'settings', 'edit');
  const page = readPage(params, 50);
  const where: Prisma.EmailLogWhereInput = { companyId: user.companyId };
  const status = str(params.status);
  if (status === 'SENT' || status === 'FAILED') where.status = status;
  const kind = str(params.vrsta);
  if (kind && kind in KIND_LABEL) where.kind = kind;
  const q = str(params.q).slice(0, 100);
  if (q) where.OR = [{ to: { contains: escapeLike(q), mode: 'insensitive' } }, { subject: { contains: escapeLike(q), mode: 'insensitive' } }];

  const [c, me, logs, total] = await Promise.all([
    db.company.findUniqueOrThrow({
      where: { id: user.companyId },
      select: { email: true, smtpHost: true, smtpPort: true, smtpSecure: true, smtpUser: true, smtpPassword: true, mailFrom: true, mailReplyTo: true, mailBccSelf: true, mailTemplates: true },
    }),
    db.user.findUnique({ where: { id: user.id }, select: { email: true } }),
    db.emailLog.findMany({ where, orderBy: { at: 'desc' }, skip: page.skip, take: page.take }),
    db.emailLog.count({ where }),
  ]);
  const configured = isMailConfigured(c);

  return (
    <>
      <PageHeader
        title="E-pošta"
        subtitle={configured ? `Poruke se šalju preko ${c.smtpHost} s adrese ${c.mailFrom || c.email}` : 'SMTP nije podešen — dokumenti se šalju iz vlastitog programa za poštu (PDF se preuzme i priloži ručno)'}
        actions={configured ? <Badge tone="ok">podešeno</Badge> : <Badge tone="neutral">nije podešeno</Badge>}
      />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="min-w-0 space-y-4">
          <MailSettingsForm
            canEdit={canEdit}
            value={{
              smtpHost: c.smtpHost ?? '',
              smtpPort: c.smtpPort,
              smtpSecure: c.smtpSecure,
              smtpUser: c.smtpUser ?? '',
              hasPassword: !!c.smtpPassword,
              mailFrom: c.mailFrom ?? '',
              mailReplyTo: c.mailReplyTo ?? '',
              mailBccSelf: c.mailBccSelf,
              companyEmail: c.email ?? '',
            }}
          />
          <MailTemplatesForm canEdit={canEdit} value={readTemplates(c.mailTemplates)} />
        </div>
        <aside className="space-y-4">
          {canEdit && <MailTestCard configured={configured} defaultTo={me?.email ?? ''} />}
          <Card title="Kako radi">
            <ul className="list-disc space-y-1.5 pl-4 text-sm text-fg-2">
              <li>Gumb „Pošalji" na računu, ponudi, predračunu, otpremnici, servisnom nalogu i partneru otvara poruku s tekstom iz predloška i PDF-om u privitku.</li>
              <li>Bez SMTP-a poruka se otvara u vašem programu za poštu, a PDF se preuzme da ga priložite.</li>
              <li>Svaka poslana ili neuspjela poruka upisuje se u dnevnik ispod.</li>
            </ul>
          </Card>
        </aside>
      </div>

      <h2 className="mt-6 mb-2 text-base font-semibold">Poslane poruke</h2>
      <FilterBar>
        <SearchFilter placeholder="Primatelj ili naslov…" />
        <SelectFilter
          name="status"
          placeholder="Sva stanja"
          options={[
            { value: 'SENT', label: 'Poslano' },
            { value: 'FAILED', label: 'Neuspjelo' },
          ]}
        />
        <SelectFilter name="vrsta" placeholder="Sve vrste" options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
      </FilterBar>
      <TableWrap>
        {logs.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Vrijeme</th>
                <th>Vrsta</th>
                <th>Primatelj</th>
                <th className="w-full">Naslov</th>
                <th>Poslao</th>
                <th>Stanje</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="whitespace-nowrap text-fg-2 tnum">{dateTime(l.at)}</td>
                  <td className="whitespace-nowrap">{KIND_LABEL[l.kind] ?? l.kind}</td>
                  <td className="break-all">
                    {l.to}
                    {l.cc && <span className="block text-xs text-fg-3">CC: {l.cc}</span>}
                  </td>
                  <td>
                    {l.subject}
                    {l.error && <span className="block text-xs text-bad-strong">{l.error}</span>}
                  </td>
                  <td className="whitespace-nowrap text-fg-2">{l.sentBy ?? '—'}</td>
                  <td>{l.status === 'SENT' ? <Badge tone="ok">poslano</Badge> : <Badge tone="bad">neuspjelo</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon={<Mail className="size-5" />} title="Nema poslanih poruka" description={total === 0 && !q && !status && !kind ? 'Ovdje će se pojaviti svaka poslana poruka.' : 'Promijenite filtre.'} />
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/postavke/posta" />
    </>
  );
}
