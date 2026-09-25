import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { clientSheet, readSheetParams } from '@/server/queries/client-sheet';
import { csvOrXlsx } from '@/server/xlsx';
import { BILLING_LABEL } from '@/domain/billing';
import { today } from '@/domain/dates';
import { eur } from '@/lib/format';

/** Popis uređaja kod klijenta (C3) — isti pogled kao stranica: CSV, Excel ili PDF. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const sp = new URL(req.url).searchParams;
  const { view, contractId } = readSheetParams(sp);
  let user;
  try {
    user = await requireAccess(contractId ? 'rentals' : 'partners', 'view');
  } catch (e) {
    return new Response(e instanceof AuthError ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const { id } = await params;
  const sheet = await clientSheet(user.companyId, id, { view, contractId });
  if (!sheet) return new Response('Partner ili ugovor ne postoji.', { status: 404 });
  const slug = sheet.partner.name.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
  const terms = sheet.contracts
    .map((c) => `${c.number}: ${BILLING_LABEL[c.billing].toLowerCase()}, ${eur(c.monthly)} mjesečno`)
    .join(' · ');
  return csvOrXlsx(
    req,
    sheet.rows,
    [
      { label: 'Serijski broj', value: (r) => r.serial },
      { label: 'Kategorija', value: (r) => r.category },
      { label: 'Model', value: (r) => r.model },
      { label: 'Status', value: (r) => r.status.name },
      { label: 'Kod klijenta od', value: (r) => r.since, type: 'date' },
      { label: 'Ugovor', value: (r) => r.contract },
      { label: 'Mjesečni najam', value: (r) => r.monthly, type: 'money' },
      { label: 'Prodajna cijena', value: (r) => (r.monthly === null ? r.price : null), type: 'money' },
      { label: 'Jamstvo do', value: (r) => r.warrantyEnd, type: 'date' },
    ],
    `uredaji-${sheet.contract ? sheet.contract.number.replace(/[^\w-]+/g, '-') : slug}-${today()}`,
    'Uređaji',
    {
      subtitle: [
        sheet.partner.name,
        sheet.contract ? `ugovor ${sheet.contract.number}` : null,
        `${sheet.rows.length} uređaja`,
        sheet.monthly ? `mjesečno ${eur(sheet.monthly)}` : null,
        terms || null,
      ]
        .filter(Boolean)
        .join(' · '),
    },
  );
}
