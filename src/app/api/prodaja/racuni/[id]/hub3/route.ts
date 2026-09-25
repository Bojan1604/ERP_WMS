// podpaket „node" nosi tipove; glavni ulaz ih u TS-u s moduleResolution bundler ne izlaže
import bwipjs from 'bwip-js/node';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { hub3Text } from '@/domain/hub3';
import { num } from '@/domain/money';

/** HUB-3 2D barkod (PDF417) za plaćanje otvorenog iznosa računa, kao SVG. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('sales', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const inv = await db.invoice.findFirst({
    where: { id, companyId: user.companyId, status: 'ISSUED' },
    select: {
      number: true,
      openAmount: true,
      paymentRef: true,
      company: { select: { name: true, address: true, zip: true, city: true, iban: true, currency: true, paymentModel: true } },
      partner: { select: { name: true, address: true, zip: true, city: true } },
    },
  });
  if (!inv || !inv.company.iban) return new Response('Nema podataka za barkod.', { status: 404 });
  const text = hub3Text({
    amount: num(inv.openAmount),
    currency: inv.company.currency,
    payer: { name: inv.partner.name, address: inv.partner.address ?? '', zip: inv.partner.zip ?? '', city: inv.partner.city ?? '' },
    payee: { name: inv.company.name, address: inv.company.address ?? '', zip: inv.company.zip ?? '', city: inv.company.city ?? '' },
    iban: inv.company.iban,
    model: inv.company.paymentModel || 'HR00',
    reference: inv.paymentRef ?? '',
    purpose: 'OTHR',
    description: `Racun ${inv.number ?? ''}`,
  });
  // columns/eclevel su opcije simbologije PDF417 koje tipovi bwip-js ne navode
  const opts = { bcid: 'pdf417', text, columns: 9, eclevel: 4, scale: 2 };
  const svg = bwipjs.toSVG(opts);
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, no-store' } });
}
