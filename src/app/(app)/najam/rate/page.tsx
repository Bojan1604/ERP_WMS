import { CalendarCheck2 } from 'lucide-react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can } from '@/domain/permissions';
import { companyPending } from '@/server/queries/rentals';
import { Card, Empty, PageHeader } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { PendingTable } from '@/components/rentals/pending-table';
import { r2 } from '@/domain/money';
import { eur, integer } from '@/lib/format';

export const metadata = { title: 'Rate za izdati' };

export default async function PendingPage() {
  const user = await pageAccess('rentals', 'view');
  const rows = await companyPending(user.companyId);
  const total = r2(rows.reduce((a, r) => a + r.amount, 0));

  if (!rows.length) {
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
        subtitle={`${integer(rows.length)} rata · ${integer(new Set(rows.map((r) => r.contractId)).size)} ugovora · ukupno ${eur(total)} neto`}
      />
      <p className="mb-3 max-w-3xl text-sm text-fg-3">
        Računi za najam ne izdaju se sami. Označite rate i izdajte ih odjednom, ili otvorite nacrt („Pregledaj“) za izmjenu prije izdavanja.
        Rata koja je fakturirana izvan programa miče se gumbom „Ne izdaji — već izdano“. Prikazane su rate do 24 mjeseca unatrag.
      </p>
      <PendingTable rows={rows} canIssue={can(user.perms, 'sales', 'edit')} canEdit={can(user.perms, 'rentals', 'edit')} />
    </>
  );
}
