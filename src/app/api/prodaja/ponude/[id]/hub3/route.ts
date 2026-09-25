// podpaket „node" nosi tipove; glavni ulaz ih u TS-u s moduleResolution bundler ne izlaže
import bwipjs from 'bwip-js/node';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { hub3Text } from '@/domain/hub3';
import { quoteDocTitle } from '@/domain/documents';
import { num } from '@/domain/money';
import { proformaReference } from '@/domain/sales-lines';

/** HUB-3 2D barkod (PDF417) za plaćanje predračuna (ukupni iznos), kao SVG. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('sales', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const q = await db.quote.findFirst({
    where: { id, companyId: user.companyId, kind: 'PROFORMA' },
    select: {
      kind: true,
      title: true,
      number: true,
      grandTotal: true,
      company: { select: { name: true, address: true, zip: true, city: true, iban: true, currency: true, paymentModel: true, proformaTitle: true } },
      partner: { select: { name: true, address: true, zip: true, city: true } },
    },
  });
  if (!q || !q.company.iban || num(q.grandTotal) <= 0) return new Response('Nema podataka za barkod.', { status: 404 });
  const text = hub3Text({
    amount: num(q.grandTotal),
    currency: q.company.currency,
    payer: { name: q.partner.name, address: q.partner.address ?? '', zip: q.partner.zip ?? '', city: q.partner.city ?? '' },
    payee: { name: q.company.name, address: q.company.address ?? '', zip: q.company.zip ?? '', city: q.company.city ?? '' },
    iban: q.company.iban,
    model: q.company.paymentModel || 'HR00',
    reference: proformaReference(q.number),
    purpose: 'OTHR',
    // HUB-3 bez dijakritika
    description: `${quoteDocTitle(q, q.company)} ${q.number}`.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D'),
  });
  // columns/eclevel su opcije simbologije PDF417 koje tipovi bwip-js ne navode
  const opts = { bcid: 'pdf417', text, columns: 9, eclevel: 4, scale: 2 };
  const svg = bwipjs.toSVG(opts);
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, no-store' } });
}
