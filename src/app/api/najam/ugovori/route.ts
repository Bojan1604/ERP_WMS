import { requireAccess } from '@/server/auth';
import { toError } from '@/server/action';
import { listContracts } from '@/server/queries/rentals';
import { BILLING_LABEL, CONTRACT_STATUS_LABEL } from '@/domain/billing';
import { MODE_SHORT } from '@/components/rentals/badges';
import { csvOrXlsx } from '@/server/xlsx';
import { today } from '@/domain/dates';

/** Izvoz popisa ugovora s istim filtrima kao na ekranu (najviše 5000). */
export async function GET(req: Request) {
  try {
    const user = await requireAccess('rentals', 'view');
    const params = Object.fromEntries(new URL(req.url).searchParams);
    const { rows } = await listContracts(user.companyId, params, { skip: 0, take: 5000 });
    return await csvOrXlsx(
      req,
      rows,
      [
      { label: 'Ugovor', value: (r) => r.number },
      { label: 'Klijent', value: (r) => r.partner.name },
      { label: 'Status', value: (r) => CONTRACT_STATUS_LABEL[r.status] },
      { label: 'Početak', value: (r) => r.startDate },
      { label: 'Kraj', value: (r) => r.endDate },
      { label: 'Naplata', value: (r) => BILLING_LABEL[r.billing] },
      { label: 'Način', value: (r) => MODE_SHORT[r.billingMode] },
      { label: 'Sezona', value: (r) => (r.seasonFrom ? `${r.seasonFrom}-${r.seasonTo}` : '') },
      { label: 'Uređaja', value: (r) => r.devices },
      { label: 'Mjesečno', value: (r) => r.monthly },
      { label: 'Sljedeća naplata', value: (r) => r.nextBilling },
      { label: 'Rata za izdati', value: (r) => r.pending },
    ],
      `ugovori-${today()}`,
      'Ugovori',
    );
  } catch (e) {
    const err = toError(e);
    return new Response(err.ok === false ? err.error : 'Greška', { status: 403 });
  }
}
