import { Readable } from 'node:stream';
import { requireAccess } from '@/server/auth';
import { db } from '@/server/db';
import { AuthError } from '@/server/errors';
import { getMdmScope } from '@/server/mdm/scope';
import { findLibraryFile } from '@/server/mdm/files';
import { fileSize, openStream } from '@/server/mdm/storage';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Preuzimanje datoteke iz MDM knjižnice (paket, datoteka, dokument) za
 * prijavljenog korisnika u čijem je opsegu. `?prikaz` otvara PDF u pregledniku.
 * (Agenti uređaja preuzimaju kroz /api/mdm/agent/files/[id].)
 */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const user = await requireAccess('mdm', 'view');
    const scope = await getMdmScope(user);
    const { id } = await params;
    const f = await findLibraryFile(db, scope, id);
    const size = await fileSize(f.storageKey).catch(() => null);
    if (size === null) return new Response('Datoteka nije pronađena na disku.', { status: 404 });
    const inline = f.mime === 'application/pdf' && new URL(req.url).searchParams.has('prikaz');
    const stream = Readable.toWeb(openStream(f.storageKey)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        'Content-Type': inline ? 'application/pdf' : 'application/octet-stream',
        'Content-Length': String(size),
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'X-Checksum-Sha256': f.sha256,
      },
    });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
}
