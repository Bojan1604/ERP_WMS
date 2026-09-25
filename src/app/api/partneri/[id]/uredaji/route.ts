import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { getPartner, partnerDevices } from '@/server/queries/partners';
import { csvOrXlsx } from '@/server/xlsx';
import { formatDate, toISO } from '@/domain/dates';
import { warrantyEnd } from '@/domain/pricing';
import { num } from '@/domain/money';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('partners', 'view');
  } catch (e) {
    return new Response(e instanceof AuthError ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const { id } = await params;
  const partner = await getPartner(user.companyId, id);
  if (!partner) return new Response('Partner ne postoji.', { status: 404 });
  const { rows } = await partnerDevices(user.companyId, id);
  const slug = partner.name.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40);
  return csvOrXlsx(
    req,
    rows,
    [
    { label: 'Serijski broj', value: (r) => r.serial },
    { label: 'Model', value: (r) => [r.model.brand, r.model.name].filter(Boolean).join(' ') },
    { label: 'Status', value: (r) => r.status.name },
    { label: 'Ugovor', value: (r) => r.contractItem?.contract.number },
    { label: 'Od', value: (r) => (r.issueDate ? formatDate(r.issueDate) : '') },
    { label: 'Jamstvo do', value: (r) => formatDate(warrantyEnd(r.warrantyStart ? toISO(r.warrantyStart) : null, r.warrantyMonths)) },
    { label: 'Prodajna cijena', value: (r) => (r.salePrice === null ? null : num(r.salePrice)) },
  ],
    `uredaji-${slug}`,
    'Uređaji',
  );
}
