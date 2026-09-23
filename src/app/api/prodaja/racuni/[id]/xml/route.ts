import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { invoiceUbl } from '@/server/fiscal/ubl-source';

/** eRačun (UBL 2.1, HR CIUS-2025) za izdani račun — preuzimanje XML datoteke. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('sales', 'view');
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const r = await invoiceUbl(user.companyId, id);
  if (!r) return new Response('Račun ne postoji.', { status: 404 });
  if (!r.xml) return new Response('eRačun se izrađuje samo za izdani račun.', { status: 409 });
  return new Response(r.xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${r.fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
