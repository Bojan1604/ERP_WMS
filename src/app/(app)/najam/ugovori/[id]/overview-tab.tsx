import type { Contract } from '@prisma/client';
import { Card, Detail, Empty, Stat } from '@/components/ui/misc';
import { ContractForm } from '@/components/rentals/contract-form';
import { PendingTable } from '@/components/rentals/pending-table';
import { billingText } from '@/components/rentals/badges';
import { contractAccrual, contractMonthly, nextBillingDate, type ContractDevice } from '@/domain/billing';
import { toISO, today } from '@/domain/dates';
import { r2 } from '@/domain/money';
import { toTerms } from '@/server/services/rentals';
import type { PendingRow } from '@/server/queries/rentals';
import { date, dateTime, eur, integer } from '@/lib/format';

export function OverviewTab({
  contract: c,
  devices,
  pending,
  canEdit,
  canIssue,
  canSkip,
}: {
  contract: Contract;
  devices: ContractDevice[];
  pending: PendingRow[];
  canEdit: boolean;
  canIssue: boolean;
  canSkip: boolean;
}) {
  const terms = toTerms(c);
  const now = today();
  const next = nextBillingDate(terms, devices, now);
  const year = Number(now.slice(0, 4));
  const accrualYear = r2(contractAccrual(terms, devices, year).reduce((a, b) => a + b, 0));
  const pendingTotal = r2(pending.reduce((a, p) => a + p.amount, 0));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Mjesečno" value={eur(contractMonthly(devices))} hint={`${integer(devices.length)} uređaja`} />
        <Stat label="Sljedeća naplata" value={next ? date(next) : '—'} hint={billingText(c.billing, c.billingMode)} />
        <Stat label={`Obračun ${year}.`} value={eur(accrualYear)} hint="zbroj mjesečnih iznosa u godini" />
        <Stat label="Rate za izdati" value={integer(pending.length)} hint={pending.length ? eur(pendingTotal) : 'sve je izdano'} tone={pending.length ? 'warn' : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card title="Uvjeti ugovora">
          <ContractForm
            mode="edit"
            contractId={c.id}
            readOnly={!canEdit}
            initial={{
              startDate: toISO(c.startDate),
              endDate: c.endDate ? toISO(c.endDate) : null,
              firstBillingDate: c.firstBillingDate ? toISO(c.firstBillingDate) : null,
              billingDay: c.billingDay,
              billing: c.billing,
              billingMode: c.billingMode,
              seasonFrom: c.seasonFrom,
              seasonTo: c.seasonTo,
              note: c.note,
            }}
          />
          {!canEdit && <p className="mt-3 text-sm text-fg-3">Uvjeti se mogu mijenjati samo dok je ugovor aktivan ili pauziran.</p>}
        </Card>
        <Card title="Podaci">
          <dl>
            <Detail label="Broj">{c.number}</Detail>
            <Detail label="Otvorio">{c.createdBy ?? '—'}</Detail>
            <Detail label="Otvoren">{dateTime(c.createdAt)}</Detail>
            {c.terminatedAt && <Detail label="Raskinut">{date(c.terminatedAt)}</Detail>}
            <Detail label="Izmijenjen">{dateTime(c.updatedAt)}</Detail>
          </dl>
        </Card>
      </div>

      <Card title="Rate za izdati" padded={!pending.length}>
        {pending.length ? (
          <PendingTable rows={pending} showContract={false} canIssue={canIssue} canEdit={canSkip} />
        ) : (
          <Empty
            title="Nema rata za izdati"
            description={
              c.status !== 'ACTIVE'
                ? 'Rate se traže samo dok je ugovor aktivan.'
                : !devices.length
                  ? 'Na ugovoru nema uređaja.'
                  : `Sve dospjele rate su izdane. Sljedeća rata dospijeva ${next ? date(next) : "—"}`
            }
          />
        )}
      </Card>
    </div>
  );
}
