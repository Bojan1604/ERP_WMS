import type { Prisma } from '@prisma/client';
import { History } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { addDays, fromISO } from '@/domain/dates';
import { Badge, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { DateFilter, FilterBar, SearchFilter, SelectFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { dateTime } from '@/lib/format';

export const metadata = { title: 'Dnevnik promjena' };

type Params = Record<string, string | string[] | undefined>;

const ENTITY_LABEL: Record<string, string> = {
  company: 'Firma', user: 'Korisnik', partner: 'Partner', item: 'Uređaj', invoice: 'Račun', quote: 'Ponuda', contract: 'Ugovor',
  receipt: 'Primka', order: 'Narudžbenica', transfer: 'Međuskladišnica', service: 'Servis / usluga', serviceOrder: 'Servisni nalog',
  expense: 'Trošak', supplierInvoice: 'Ulazni račun', warehouse: 'Skladište', category: 'Kategorija', model: 'Model',
  status: 'Status', expenseCategory: 'Kategorija troška', request: 'Odobrenje', accountant: 'Knjigovođa',
  job: 'Automatski posao', import: 'Uvoz i kopije', approvalRequest: 'Odobrenje',
};
const ACTION_LABEL: Record<string, string> = {
  create: 'novo', update: 'izmjena', delete: 'brisanje', issue: 'izdavanje', storno: 'storno', payment: 'uplata',
  'payment-delete': 'brisanje uplate', unpaid: 'neplaćeno', price: 'cijena', 'price-delete': 'brisanje cijene', logout: 'odjava',
  terminate: 'raskid', add: 'dodavanje', remove: 'uklanjanje', items: 'uređaji', approve: 'odobreno', reject: 'odbijeno',
  'rent-apply': 'najam na uređaje', 'rent-override': 'ručni najam', status: 'status', transfer: 'premještanje', pause: 'pauza naplate', resume: 'naplata vraćena',
  sent: 'poslano knjigovođi', unsent: 'nije poslano knjigovođi',
  fetch: 'preuzimanje eRačuna', receive: 'zaprimljen eRačun', accept: 'prihvaćeno', paid: 'plaćeno',
  '2fa-on': '2FA uključena', '2fa-off': '2FA isključena', '2fa-reset': '2FA poništena', '2fa-codes': 'rezervni kodovi', '2fa-backup': 'prijava rezervnim kodom',
  password: 'lozinka', switch: 'promjena firme', 'company-grant': 'pristup firmi', 'company-revoke': 'oduzet pristup firmi',
  counter: 'numeracija', 'auto-issue': 'automatsko izdavanje', backup: 'sigurnosna kopija', 'backup-delete': 'brisanje kopije', 'backup-download': 'preuzeta kopija',
  'wipe-transactions': 'brisanje prometa', 'wipe-all': 'brisanje svih podataka', 'log-clean': 'čišćenje dnevnika', 'integrity-fix': 'popravak dosljednosti', reset: 'vraćeno na zadano',
};
const ACTION_TONE: Record<string, 'ok' | 'bad' | 'info' | 'neutral' | 'warn'> = {
  create: 'ok', delete: 'bad', update: 'info', issue: 'ok', storno: 'warn', accept: 'ok', reject: 'bad', 'wipe-transactions': 'bad', 'wipe-all': 'bad', 'log-clean': 'warn', '2fa-reset': 'warn',
};
const isoDay = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export default async function AuditLogPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('log');
  const params = await searchParams;
  const page = readPage(params, 100);
  const where: Prisma.AuditLogWhereInput = { companyId: user.companyId };
  if (typeof params.entitet === 'string' && params.entitet) where.entity = params.entitet;
  if (typeof params.korisnik === 'string' && params.korisnik) where.userId = params.korisnik;
  if (typeof params.q === 'string' && params.q.trim()) where.summary = { contains: params.q.trim(), mode: 'insensitive' };
  const from = isoDay(params.od);
  const to = isoDay(params.do);
  if (from || to) where.at = { ...(from ? { gte: fromISO(from) } : {}), ...(to ? { lt: fromISO(addDays(to, 1)) } : {}) };

  const [rows, total, entities, users] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: { at: 'desc' }, skip: page.skip, take: page.take }),
    db.auditLog.count({ where }),
    db.auditLog.groupBy({ by: ['entity'], where: { companyId: user.companyId }, orderBy: { entity: 'asc' } }),
    db.user.findMany({ where: { companyId: user.companyId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);

  return (
    <>
      <PageHeader title="Dnevnik promjena" subtitle="Tko je što promijenio i kada" />
      <FilterBar>
        <SearchFilter placeholder="Traži u opisu…" />
        <SelectFilter name="entitet" placeholder="Sve vrste" options={entities.map((e) => ({ value: e.entity, label: ENTITY_LABEL[e.entity] ?? e.entity }))} />
        <SelectFilter name="korisnik" placeholder="Svi korisnici" options={users.map((u) => ({ value: u.id, label: u.name }))} />
        <DateFilter name="od" label="Od" />
        <DateFilter name="do" label="Do" />
      </FilterBar>
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Vrijeme</th>
                <th>Korisnik</th>
                <th>Vrsta</th>
                <th>Radnja</th>
                <th className="w-full">Opis</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hasDiff = r.diff && typeof r.diff === 'object' && Object.keys(r.diff as object).length > 0;
                return (
                  <tr key={r.id} className="align-top">
                    <td className="whitespace-nowrap text-fg-2 tnum">{dateTime(r.at)}</td>
                    <td className="whitespace-nowrap">{r.userName ?? '—'}</td>
                    <td className="whitespace-nowrap text-fg-2">{ENTITY_LABEL[r.entity] ?? r.entity}</td>
                    <td>
                      <Badge tone={ACTION_TONE[r.action] ?? 'neutral'} title={r.action}>
                        {ACTION_LABEL[r.action] ?? r.action}
                      </Badge>
                    </td>
                    <td>
                      {hasDiff ? (
                        <details className="group">
                          <summary className="cursor-pointer list-none marker:hidden">
                            {r.summary} <span className="text-xs text-brand group-open:hidden">· promjene</span>
                          </summary>
                          <pre className="mt-1.5 max-h-80 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-fg-2">{JSON.stringify(r.diff, null, 2)}</pre>
                        </details>
                      ) : (
                        r.summary
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty icon={<History className="size-5" />} title="Nema zapisa" description="Promijenite filtre." />
        )}
      </TableWrap>
      <Pagination page={page.page} pageSize={page.pageSize} total={total} params={params} basePath="/postavke/dnevnik" />
    </>
  );
}
