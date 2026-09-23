import { requireAdmin } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { exportCompanyStream } from '@/server/import/backup';
import { today } from '@/domain/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Sigurnosna kopija cijele firme (JSON, šalje se kao tok). */
export async function GET() {
  let user;
  try {
    user = await requireAdmin();
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 500;
    return new Response(e instanceof Error ? e.message : 'Greška', { status });
  }
  const slug = user.companyName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'firma';
  await db.auditLog.create({
    data: { companyId: user.companyId, userId: user.id, userName: user.name, entity: 'import', action: 'export', summary: 'Preuzeta sigurnosna kopija (JSON)' },
  });
  const stream = await exportCompanyStream(user.companyId);
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="sigurnosna-kopija-${slug}-${today()}.json"`,
      'Cache-Control': 'no-store',
    },
  });
}
