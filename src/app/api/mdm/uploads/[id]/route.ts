import { Readable } from 'node:stream';
import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { deviceWhere, getMdmScope } from '@/server/mdm/scope';
import { fileSize, openStream } from '@/server/mdm/storage';

/** Slike koje preglednik smije prikazati u stranici; sve ostalo se preuzima. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * Snimka zaslona ili zapisnik s uređaja — samo za prijavljenog korisnika čiji
 * opseg uključuje uređaj. Nikad se ne sprema u međuspremnik.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireAccess('mdm', 'view');
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const scope = await getMdmScope(user);
  const { id } = await params;
  const up = await db.mdmUpload.findFirst({
    where: { id, device: deviceWhere(scope) },
    select: { kind: true, at: true, file: { select: { name: true, mime: true, storageKey: true, companyId: true } } },
  });
  if (!up || up.file.companyId !== scope.companyId) return new Response('Datoteka ne postoji.', { status: 404 });

  let size: number;
  try {
    size = await fileSize(up.file.storageKey);
  } catch {
    return new Response('Datoteka više nije na poslužitelju.', { status: 410 });
  }
  const inline = INLINE.has(up.file.mime) && !new URL(req.url).searchParams.has('preuzmi');
  const body = Readable.toWeb(openStream(up.file.storageKey)) as unknown as ReadableStream;
  return new Response(body, {
    headers: {
      'Content-Type': inline ? up.file.mime : up.file.mime.startsWith('text/') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(up.file.name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; sandbox",
    },
  });
}
