import { transaction } from '@/server/db';
import { toError } from '@/server/action';
import { AuthError } from '@/server/errors';
import { requirePortalUser } from '@/server/portal/auth';
import { reportFault } from '@/server/portal/report';
import { portalReportLimit } from '@/server/portal/limits';
import { PORTAL_MAX_PHOTOS } from '@/domain/portal';
import { ATTACHMENT_MAX_BYTES } from '@/domain/attachments';
import { z } from 'zod';

const schema = z.object({
  itemId: z.string().min(1, 'Odaberite uređaj.').max(64),
  issue: z.string().trim().min(1, 'Opišite kvar.').max(4000, 'Opis kvara je predug (najviše 4000 znakova).'),
  contact: z.string().trim().max(200, 'Kontakt je predug.').optional(),
});

/**
 * Prijava kvara s portala (multipart: itemId, issue, contact, do 4 × `photo`).
 * Nalog i fotografije (prilozi servisnog naloga) nastaju u jednoj transakciji.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePortalUser();
    if (portalReportLimit.blocked(user.id)) return Response.json({ ok: false, error: 'Previše prijava u kratkom vremenu. Pokušajte kasnije ili nas nazovite.' }, { status: 429 });
    const form = await req.formData();
    const input = schema.parse({ itemId: form.get('itemId') ?? '', issue: form.get('issue') ?? '', contact: form.get('contact') ?? undefined });
    const files = form.getAll('photo').filter((f): f is File => typeof f === 'object' && f !== null && 'arrayBuffer' in f && f.size > 0);
    if (files.length > PORTAL_MAX_PHOTOS) return Response.json({ ok: false, error: `Najviše ${PORTAL_MAX_PHOTOS} fotografije.` }, { status: 400 });
    // veličina se provjerava prije čitanja sadržaja
    const big = files.find((f) => f.size > ATTACHMENT_MAX_BYTES);
    if (big) return Response.json({ ok: false, error: `Slika „${big.name}" je veća od ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.` }, { status: 413 });
    const photos = await Promise.all(files.map(async (f) => ({ fileName: f.name || null, data: new Uint8Array(await f.arrayBuffer()) })));
    const order = await transaction((tx) => reportFault(tx, user, { itemId: input.itemId, issue: input.issue, contact: input.contact ?? null }, photos));
    portalReportLimit.fail(user.id);
    return Response.json({ ok: true, data: { id: order.id, number: order.number } });
  } catch (e) {
    const err = toError(e);
    return Response.json(err, { status: e instanceof AuthError ? e.status : err.error.startsWith('Došlo je do neočekivane') ? 500 : 400 });
  }
}
