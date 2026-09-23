// podpaket „node" nosi tipove; glavni ulaz ih u TS-u s moduleResolution bundler ne izlaže
import bwipjs from 'bwip-js/node';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { fiscalQrUrl } from '@/domain/fiscal';
import { num } from '@/domain/money';

/** QR kod za provjeru fiskaliziranog računa (porezna.gov.hr/rn), kao SVG. */
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
    select: { jir: true, zki: true, issuedAt: true, grandTotal: true },
  });
  const url = inv?.issuedAt ? fiscalQrUrl({ jir: inv.jir, zki: inv.zki, issuedAt: inv.issuedAt, total: num(inv.grandTotal) }) : null;
  if (!url) return new Response('Račun nije fiskaliziran.', { status: 404 });
  const svg = bwipjs.toSVG({ bcid: 'qrcode', text: url, scale: 2, eclevel: 'M' } as Parameters<typeof bwipjs.toSVG>[0]);
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, no-store' } });
}
