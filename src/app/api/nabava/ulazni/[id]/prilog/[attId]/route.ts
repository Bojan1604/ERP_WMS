import { requireAccess } from '@/server/auth';
import { db } from '@/server/db';
import { AuthError } from '@/server/errors';
import { canSeeCost } from '@/domain/permissions';

type Ctx = { params: Promise<{ id: string; attId: string }> };

/**
 * Prilog ulaznog računa (izvorni XML eRačuna, PDF dobavljača) — samo za korisnika
 * iste firme s pravom na nabavu (račun za robu i uz pravo na nabavne cijene). PDF se prikazuje u pregledniku, sve ostalo se preuzima.
 */
export async function GET(req: Request, { params }: Ctx) {
  let user;
  try {
    user = await requireAccess('purchasing', 'view');
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const { id, attId } = await params;
  const a = await db.attachment.findFirst({
    where: { id: attId, companyId: user.companyId, entity: 'supplierInvoice', entityId: id },
    select: { fileName: true, mime: true, data: true },
  });
  if (!a) return new Response('Prilog ne postoji.', { status: 404 });
  // račun za robu otkriva nabavnu vrijednost — bez prava na nabavne cijene ni njegovi dokumenti (kao na stranici računa)
  if (!canSeeCost(user.perms)) {
    const goods = await db.supplierInvoice.count({ where: { id, companyId: user.companyId, goodsInvoice: true } });
    if (goods) return new Response('Nemate pravo na nabavne cijene.', { status: 403 });
  }
  const bytes = a.data as Uint8Array;
  const pdf = a.mime === 'application/pdf';
  const inline = pdf && !new URL(req.url).searchParams.has('preuzmi');
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': pdf ? 'application/pdf' : a.mime === 'application/xml' ? 'application/xml; charset=utf-8' : 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}
