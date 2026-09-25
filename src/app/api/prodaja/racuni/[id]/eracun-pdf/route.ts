import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { providerPdf } from '@/server/fiscal/einvoice-ops';

/** PDF (vizualizacija) eRačuna kod posrednika — preuzimanje. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('sales', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const r = await providerPdf(id, user);
  if (!r.ok) return new Response(r.message, { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(new Uint8Array(r.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${r.fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}
