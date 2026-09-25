import { z } from 'zod';
import { requireAccess } from '@/server/auth';
import { AuthError, DomainError } from '@/server/errors';
import { buildAccountantZip } from '@/server/queries/accountant-export';
import { accountantAccess } from '@/server/queries/accountant';
import { today } from '@/domain/dates';

const body = z.object({ keys: z.array(z.string().max(80)).min(1).max(5000) });

/**
 * ZIP označenih dokumenata za knjigovođu. POST { keys: ["out:<id>", "in:<id>", …] }
 * (popis može biti dug, pa ne ide u URL). Greška se vraća kao običan tekst.
 */
export async function POST(req: Request) {
  try {
    const user = await requireAccess('reports', 'view');
    // samo JSON iz aplikacije (obrazac s tuđe stranice ne može poslati application/json bez CORS-a)
    if (!req.headers.get('content-type')?.includes('application/json')) return new Response('Očekuje se JSON.', { status: 415 });
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return new Response('Neispravan popis dokumenata.', { status: 400 });
    const { buffer, xmlCount, attCount, rows } = await buildAccountantZip(user.companyId, parsed.data.keys, undefined, accountantAccess(user.perms));
    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Length': String(buffer.length),
        'Content-Disposition': `attachment; filename="knjigovodja-${today()}.zip"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // sažetak za poruku u sučelju
        'X-Zip-Summary': `${rows.length};${xmlCount};${attCount}`,
      },
    });
  } catch (e) {
    if (e instanceof AuthError) return new Response(e.message, { status: e.status });
    if (e instanceof DomainError) return new Response(e.message, { status: 422 });
    console.error('[knjigovodja/zip]', e);
    return new Response('Arhivu nije moguće izraditi. Pokušajte ponovno.', { status: 500 });
  }
}
