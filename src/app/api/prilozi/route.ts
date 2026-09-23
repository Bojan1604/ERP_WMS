import { requireAccess } from '@/server/auth';
import { transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { toError } from '@/server/action';
import { AuthError } from '@/server/errors';
import { can } from '@/domain/permissions';
import { ATTACHMENT_MAX_BYTES } from '@/domain/attachments';
import { itemEvents } from '@/server/services/items';
import { addAttachments, ATTACHMENT_ENTITIES, isAttachmentEntity } from '@/server/services/attachments';

/**
 * Prijenos priloga: multipart s poljima `entity`, `entityId` i jednom ili više
 * datoteka `file`. Slike se prije slanja smanjuju u pregledniku.
 */
export async function POST(req: Request) {
  try {
    const user = await requireAccess('warehouse', 'view');
    const form = await req.formData();
    const entity = String(form.get('entity') ?? '');
    const entityId = String(form.get('entityId') ?? '');
    if (!isAttachmentEntity(entity) || !entityId) return Response.json({ ok: false, error: 'Neispravan zapis.' }, { status: 400 });
    const rule = ATTACHMENT_ENTITIES[entity];
    if (!can(user.perms, rule.module, rule.add)) throw new AuthError('Nemate pravo dodavati priloge.', 403);

    const files = form.getAll('file').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f);
    if (!files.length) return Response.json({ ok: false, error: 'Niste odabrali datoteku.' }, { status: 400 });
    // veličina se provjerava prije čitanja sadržaja
    const big = files.find((f) => f.size > ATTACHMENT_MAX_BYTES);
    if (big) return Response.json({ ok: false, error: `Datoteka „${big.name}" je veća od ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    const data = await Promise.all(files.map(async (f) => ({ fileName: f.name || null, data: new Uint8Array(await f.arrayBuffer()) })));

    const saved = await transaction(async (tx) => {
      const rows = await addAttachments(tx, user, entity, entityId, data);
      if (entity === 'item') await itemEvents(tx, user, [entityId], { type: 'ATTACHMENT', message: `Dodan prilog: ${rows.map((r) => r.fileName).join(', ')}` });
      await audit(tx, user, {
        entity: 'attachment',
        entityId: rows[0]?.id,
        action: 'create',
        summary: `Prilog (${rows.length}) uz ${entity === 'item' ? 'uređaj' : 'zahtjev'}: ${rows.map((r) => r.fileName).join(', ')}`,
        diff: { entity, entityId },
      });
      return rows;
    });
    return Response.json({ ok: true, data: saved });
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 400;
    const err = toError(e);
    return Response.json(err, { status: err.error.startsWith('Došlo je do neočekivane') ? 500 : status });
  }
}
