import { requireAdmin } from '@/server/auth';
import { AuthError, DomainError } from '@/server/errors';
import { appendPart } from '@/server/import/upload';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Dio datoteke za uvoz: ?id=<32 hex>&dio=<redni broj od 0>, tijelo = bajtovi (≤ 8 MB). */
export async function POST(req: Request) {
  try {
    const user = await requireAdmin();
    const sp = new URL(req.url).searchParams;
    const part = Number(sp.get('dio'));
    if (!Number.isInteger(part) || part < 0) return Response.json({ error: 'Neispravan dio datoteke.' }, { status: 400 });
    const size = await appendPart(user.id, sp.get('id') ?? '', part, new Uint8Array(await req.arrayBuffer()));
    return Response.json({ ok: true, size });
  } catch (e) {
    if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
    if (e instanceof DomainError) return Response.json({ error: e.message }, { status: 400 });
    console.error('[uvoz/dio]', e);
    return Response.json({ error: 'Slanje datoteke nije uspjelo.' }, { status: 500 });
  }
}
