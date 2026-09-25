import { requireUser } from '@/server/auth';
import { db, transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { toError } from '@/server/action';
import { AuthError } from '@/server/errors';
import { isExternalRole } from '@/domain/permissions';
import { itemEvents } from '@/server/services/items';
import { addAttachments, ATTACHMENT_ENTITIES, attachmentsHideCost, canAttachment, isAttachmentEntity, listAttachments } from '@/server/services/attachments';

/**
 * Popis priloga zapisa (bez sadržaja): `?entity=contract&entityId=…`.
 * Pravo pregleda po vrsti zapisa (ATTACHMENT_ENTITIES), zapis mora biti u firmi korisnika.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser();
    if (isExternalRole(user.role)) throw new AuthError('Nemate pravo pristupa.', 403);
    const sp = new URL(req.url).searchParams;
    const entity = sp.get('entity') ?? '';
    const entityId = sp.get('entityId') ?? '';
    if (!isAttachmentEntity(entity) || !entityId || entity === 'request') return Response.json({ ok: false, error: 'Neispravan zapis.' }, { status: 400 });
    if (!canAttachment(user.perms, entity, 'view')) throw new AuthError('Nemate pravo pristupa.', 403);
    if (await attachmentsHideCost(db, user.companyId, user.perms, entity, entityId)) return Response.json({ ok: true, data: [] });
    const rows = await listAttachments(db, user.companyId, entity, [entityId]);
    return Response.json({ ok: true, data: rows });
  } catch (e) {
    const err = toError(e);
    return Response.json(err, { status: e instanceof AuthError ? e.status : 400 });
  }
}

/** Najveće tijelo zahtjeva: najveći dopušteni skup datoteka bilo koje vrste zapisa + zaglavlja multiparta. */
const MAX_BODY_BYTES = Math.max(...Object.values(ATTACHMENT_ENTITIES).map((r) => r.maxBytes * r.max)) + 256 * 1024;

/**
 * Prijenos priloga: multipart s poljima `entity`, `entityId` i jednom ili više
 * datoteka `file`. Slike se prije slanja smanjuju u pregledniku.
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser();
    if (isExternalRole(user.role)) throw new AuthError('Nemate pravo dodavati priloge.', 403);
    // veličina tijela se provjerava prije čitanja (formData() bi cijeli zahtjev učitao u memoriju)
    const length = Number(req.headers.get('content-length'));
    if (!Number.isFinite(length) || length <= 0) return Response.json({ ok: false, error: 'Nedostaje veličina zahtjeva.' }, { status: 411 });
    if (length > MAX_BODY_BYTES) return Response.json({ ok: false, error: 'Prilozi su preveliki za jedan prijenos.' }, { status: 413 });
    const form = await req.formData();
    const entity = String(form.get('entity') ?? '');
    const entityId = String(form.get('entityId') ?? '');
    if (!isAttachmentEntity(entity) || !entityId) return Response.json({ ok: false, error: 'Neispravan zapis.' }, { status: 400 });
    const rule = ATTACHMENT_ENTITIES[entity];
    if (!canAttachment(user.perms, entity, 'add')) throw new AuthError('Nemate pravo dodavati priloge.', 403);

    const files = form.getAll('file').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f);
    if (!files.length) return Response.json({ ok: false, error: 'Niste odabrali datoteku.' }, { status: 400 });
    if (files.length > rule.max) return Response.json({ ok: false, error: `Najviše ${rule.max} priloga odjednom.` }, { status: 413 });
    // veličina se provjerava prije čitanja sadržaja
    const big = files.find((f) => f.size > rule.maxBytes);
    if (big) return Response.json({ ok: false, error: `Datoteka „${big.name}" je veća od ${rule.maxBytes / 1024 / 1024} MB.` }, { status: 413 });
    const data = await Promise.all(files.map(async (f) => ({ fileName: f.name || null, data: new Uint8Array(await f.arrayBuffer()) })));

    const saved = await transaction(async (tx) => {
      const rows = await addAttachments(tx, user, entity, entityId, data);
      if (entity === 'item') await itemEvents(tx, user, [entityId], { type: 'ATTACHMENT', message: `Dodan prilog: ${rows.map((r) => r.fileName).join(', ')}` });
      await audit(tx, user, {
        entity: 'attachment',
        entityId: rows[0]?.id,
        action: 'create',
        summary: `Prilog (${rows.length}) uz ${rule.label}: ${rows.map((r) => r.fileName).join(', ')}`,
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
