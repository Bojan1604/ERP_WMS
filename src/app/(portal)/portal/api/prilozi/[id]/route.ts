import { getPortalUser } from '@/server/portal/auth';
import { portalAttachment } from '@/server/portal/queries';
import { ATTACHMENT_MIMES } from '@/domain/attachments';

/** Fotografija/prilog servisnog naloga — samo za klijenta čiji je nalog. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getPortalUser();
  if (!user) return new Response('Niste prijavljeni.', { status: 401 });
  const { id } = await params;
  const a = await portalAttachment(user, id);
  if (!a) return new Response('Prilog ne postoji.', { status: 404 });
  const bytes = a.data as Uint8Array;
  const known = (ATTACHMENT_MIMES as readonly string[]).includes(a.mime);
  const inline = known && !new URL(req.url).searchParams.has('preuzmi');
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': known ? a.mime : 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}
