import { requireAccess } from '@/server/auth';
import { toError } from '@/server/action';
import { listContracts } from '@/server/queries/contract-list';
import { BILLING_LABEL, CONTRACT_STATUS_LABEL } from '@/domain/billing';
import { MODE_SHORT } from '@/components/rentals/badges';
import { csvOrXlsx } from '@/server/xlsx';
import { today } from '@/domain/dates';
import { seasonLabel } from '@/domain/plan';
import { eur } from '@/lib/format';

/** Izvoz popisa ugovora s istim filtrima kao na ekranu (najviše 5000). */
export async function GET(req: Request) {
  try {
    const user = await requireAccess('rentals', 'view');
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const { rows, summary } = await listContracts(user.companyId, params, { skip: 0, take: 5000 });
    const year = summary.year;
    return await csvOrXlsx(
      req,
      rows,
      [
      { label: 'Ugovor', value: (r) => r.number },
      { label: 'Klijent', value: (r) => r.partner.name },
      { label: 'Status', value: (r) => CONTRACT_STATUS_LABEL[r.status] },
      { label: 'Početak', value: (r) => r.startDate, type: 'date' },
      { label: 'Kraj', value: (r) => r.endDate, type: 'date' },
      { label: 'Naplata', value: (r) => BILLING_LABEL[r.billing] },
      { label: 'Način', value: (r) => MODE_SHORT[r.billingMode] },
      { label: 'Sezona', value: (r) => (r.seasonFrom ? seasonLabel(r.seasonFrom, r.seasonTo) : '') },
      { label: 'Uređaja', value: (r) => r.devices, type: 'int' },
      { label: 'S vlastitim uvjetima', value: (r) => r.custom, type: 'int' },
      { label: 'Mjesečno', value: (r) => r.monthly, type: 'money' },
      { label: 'Rata', value: (r) => (r.installment === null ? 'razno' : r.installment), type: 'money' },
      { label: `Obračun ${year}.`, value: (r) => r.accrual, type: 'money' },
      { label: `Naplata ${year}.`, value: (r) => r.billed, type: 'money' },
      { label: 'Sljedeća naplata', value: (r) => r.nextBilling, type: 'date' },
      { label: 'Rata za izdati', value: (r) => r.pending, type: 'int' },
      { label: 'Dana do isteka', value: (r) => r.endsIn, type: 'int' },
      { label: 'PDF ugovora', value: (r) => (r.pdf ? 'da' : 'ne') },
    ],
      `ugovori-${today()}`,
      'Ugovori',
      { subtitle: `Mjesečno (aktivni) ${eur(summary.monthly)} · obračun ${year}. ${eur(summary.accrual)} · naplata ${year}. ${eur(summary.billed)}`, landscape: true },
    );
  } catch (e) {
    const err = toError(e);
    return new Response(err.ok === false ? err.error : 'Greška', { status: 403 });
  }
}
