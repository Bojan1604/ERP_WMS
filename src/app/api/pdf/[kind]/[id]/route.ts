import { requireUser } from '@/server/auth';
import { AuthError, DomainError } from '@/server/errors';
import { can, canSeeCost, isExternalRole } from '@/domain/permissions';
import { isPdfKind, PDF_KIND_MODULE } from '@/domain/documents';
import { pdfResponse, renderDocumentPdf } from '@/server/pdf';

type Ctx = { params: Promise<{ kind: string; id: string }> };

/**
 * PDF dokumenta: /api/pdf/invoice/<id> (pregled u pregledniku ili iframeu),
 * `?preuzmi` = preuzimanje. Vrsta mora biti na popisu PDF_KINDS, korisnik mora
 * imati pravo pregleda modula te vrste, a zapis se traži samo u njegovoj firmi.
 * Nabavne cijene (primka) samo uz pravo `costs`.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { kind, id } = await params;
  if (!isPdfKind(kind)) return new Response('Nepoznata vrsta dokumenta.', { status: 404 });
  let user;
  try {
    user = await requireUser();
    if (isExternalRole(user.role) || !can(user.perms, PDF_KIND_MODULE[kind], 'view')) throw new AuthError('Nemate pravo pristupa.', 403);
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  try {
    const doc = await renderDocumentPdf(kind, id, user.companyId, { showCost: canSeeCost(user.perms) });
    return pdfResponse(doc.buffer, doc.fileName, !new URL(req.url).searchParams.has('preuzmi'));
  } catch (e) {
    if (e instanceof DomainError) return new Response(e.message, { status: 404 });
    console.error('[pdf]', e);
    return new Response('PDF se ne može izraditi.', { status: 500 });
  }
}
