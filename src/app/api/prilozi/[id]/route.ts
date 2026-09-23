import { requireAccess } from '@/server/auth';
import { db, transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { toError } from '@/server/action';
import { AuthError } from '@/server/errors';
import { can } from '@/domain/permissions';
import { ATTACHMENT_MIMES as INLINE_MIME } from '@/domain/attachments';
import { isMine } from '@/server/queries/approvals';
import { ATTACHMENT_ENTITIES, deleteAttachment, isAttachmentEntity, readAttachment } from '@/server/services/attachments';

type Ctx = { params: Promise<{ id: string }> };

/** Sadržaj priloga — samo za prijavljenog korisnika iste firme s pravom na modul. */
export async function GET(req: Request, { params }: Ctx) {
  let user;
  try {
    user = await requireAccess('warehouse', 'view');
  } catch (e) {
    return new Response(e instanceof Error ? e.message : 'Greška', { status: e instanceof AuthError ? e.status : 500 });
  }
  const { id } = await params;
  const a = await readAttachment(db, user.companyId, id);
  if (!a || !isAttachmentEntity(a.entity) || !can(user.perms, ATTACHMENT_ENTITIES[a.entity].module, 'view')) {
    return new Response('Prilog ne postoji.', { status: 404 });
  }
  // slike uz zahtjev za zaprimanje: samo tko smije rješavati zahtjeve ili onaj tko ga je poslao
  if (a.entity === 'request' && !can(user.perms, 'warehouse', 'edit')) {
    const r = await db.approvalRequest.findFirst({ where: { id: a.entityId, companyId: user.companyId }, select: { payload: true } });
    if (!r || !isMine(r, user)) return new Response('Prilog ne postoji.', { status: 404 });
  }
  const bytes = a.data as Uint8Array;
  // prikaz u pregledniku samo za vrste koje se provjeravaju pri spremanju; sve ostalo (npr. stari uvezeni zapis) se preuzima
  const known = (INLINE_MIME as readonly string[]).includes(a.mime);
  const inline = known && !new URL(req.url).searchParams.has('preuzmi');
  const name = encodeURIComponent(a.fileName);
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      'Content-Type': known ? a.mime : 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
      // sadržaj priloga se nikad ne mijenja (novi prilog = novi id); privatno — samo preglednik korisnika
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // otvoren u vlastitoj kartici ne smije ništa učitavati ni izvršavati; `sandbox` ga odvaja od aplikacije
      // (Chromiumov čitač PDF-a i dalje radi — provjereno u Chromiumu 141)
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const user = await requireAccess('warehouse', 'view');
    const { id } = await params;
    const res = await transaction(async (tx) => {
      const a = await tx.attachment.findFirst({ where: { id, companyId: user.companyId }, select: { entity: true } });
      if (!a || !isAttachmentEntity(a.entity)) throw new AuthError('Prilog ne postoji.', 403);
      const rule = ATTACHMENT_ENTITIES[a.entity];
      if (!can(user.perms, rule.module, rule.remove)) throw new AuthError('Nemate pravo brisati priloge.', 403);
      const del = await deleteAttachment(tx, user, id);
      await audit(tx, user, { entity: 'attachment', entityId: id, action: 'delete', summary: `Obrisan prilog ${del.fileName}`, diff: { entity: del.entity, entityId: del.entityId } });
      return del;
    });
    return Response.json({ ok: true, data: { id: res.id } });
  } catch (e) {
    return Response.json(toError(e), { status: e instanceof AuthError ? e.status : 400 });
  }
}
