import { requireAdmin } from '@/server/auth';
import { AuthError, DomainError } from '@/server/errors';
import { db } from '@/server/db';
import { openBackup } from '@/server/jobs/backups';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Preuzimanje sigurnosne kopije s poslužitelja (raspakirani JSON — isti oblik kao „Preuzmi kopiju"). Samo administrator, samo kopije svoje firme. */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  try {
    const user = await requireAdmin();
    const { name } = await params;
    const stream = await openBackup(user.companyId, name);
    await db.auditLog.create({
      data: { companyId: user.companyId, userId: user.id, userName: user.name, entity: 'company', entityId: user.companyId, action: 'backup-download', summary: `Preuzeta sigurnosna kopija ${name}` },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name.replace(/\.gz$/, '')}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    if (e instanceof DomainError) return new Response(e.message, { status: 404 });
    console.error('[kopija]', e);
    return new Response('Greška pri čitanju kopije.', { status: 500 });
  }
}
