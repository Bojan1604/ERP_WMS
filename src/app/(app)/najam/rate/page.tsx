import { CalendarCheck2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can } from '@/domain/permissions';
import { pendingPage } from '@/server/queries/rentals';
import { Card, Empty, PageHeader, TableWrap } from '@/components/ui/misc';
import { FilterBar, SearchFilter } from '@/components/ui/filters';
import { Pagination, readPage } from '@/components/ui/pagination';
import { LinkButton } from '@/components/ui/button';
import { PendingTable } from '@/components/rentals/pending-table';
import { eur, integer } from '@/lib/format';

export const metadata = { title: 'Rate za izdati' };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function PendingPage({ searchParams }: { searchParams: SP }) {
  const user = await pageAccess('rentals', 'view');
  const params = await searchParams;
  const q = typeof params.q === 'string' ? params.q.trim() : '';
  // straničenje po ugovorima: sve rate jednog ugovora su na istoj stranici
  const page = readPage(params, 50);
  const data = await pendingPage(user.companyId, { q, skip: page.skip, take: page.take });

  if (!data.unfiltered) {
    const [active, paused, excluded] = await Promise.all([
      db.contract.count({ where: { companyId: user.companyId, status: 'ACTIVE', partner: { excluded: false } } }),
      db.contract.count({ where: { companyId: user.companyId, status: 'PAUSED' } }),
      db.contract.count({ where: { companyId: user.companyId, status: 'ACTIVE', partner: { excluded: true } } }),
    ]);
    const why = [
      active ? `Svih ${integer(active)} aktivnih ugovora ima izdane sve dospjele rate.` : 'Nema aktivnih ugovora.',
      'Rata se pojavljuje na dan računa: kod naplate unaprijed u mjesecu razdoblja, kod naplate unatrag prvi dan naplate sljedećeg mjeseca.',
      paused ? `Pauzirani ugovori (${integer(paused)}) ne stvaraju rate.` : '',
      excluded ? `Ugovori isključenih partnera (${integer(excluded)}) ovdje se ne prikazuju.` : '',
    ].filter(Boolean);
    return (
      <>
        <PageHeader title="Rate za izdati" />
        <Card>
          <Empty
            icon={<CalendarCheck2 className="size-5" />}
            title="Nema rata koje čekaju izdavanje"
            description={why.join(' ')}
            action={
              <LinkButton href="/najam/ugovori" size="sm">
                Ugovori
              </LinkButton>
            }
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Rate za izdati"
        subtitle={`${integer(data.count)} rata · ${integer(data.contracts)} ugovora · ukupno ${eur(data.amount)} neto`}
      />
      <p className="mb-3 max-w-3xl text-sm text-fg-3">
        Računi za najam ne izdaju se sami. Označite rate i izdajte ih odjednom, ili otvorite nacrt („Pregledaj“) za izmjenu prije izdavanja.
        Rata koja je fakturirana izvan programa miče se gumbom „Ne izdaji — već izdano“. Prikazane su rate do 24 mjeseca unatrag, po 50 ugovora na stranici (sve rate ugovora na istoj stranici).
      </p>
      <FilterBar>
        <SearchFilter placeholder="Ugovor ili klijent…" />
      </FilterBar>
      {data.rows.length ? (
        <PendingTable key={`${page.page}|${q}`} rows={data.rows} canIssue={can(user.perms, 'sales', 'edit')} canEdit={can(user.perms, 'rentals', 'edit')} />
      ) : (
        <TableWrap>
          <Empty icon={<CalendarCheck2 className="size-5" />} title="Nema rata za pretragu" description="Nijedan ugovor ni klijent s ratama za izdati ne odgovara pretrazi." />
        </TableWrap>
      )}
      <Pagination page={page.page} pageSize={page.pageSize} total={data.contracts} params={params} basePath="/najam/rate" />
    </>
  );
}
