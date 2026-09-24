import { requireAccess } from '@/server/auth';
import { AuthError } from '@/server/errors';
import { db } from '@/server/db';
import { deviceWhere, getMdmScope } from '@/server/mdm/scope';

/**
 * Najnovije snimke/zapisnici uređaja i naredba koja još čeka — za stranicu
 * „Zaslon" koja osvježava prikaz dok čeka novu snimku.
 *   GET /api/mdm/uploads?device=<id>&kind=SCREENSHOT|LOGS
 */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireAccess('mdm', 'view');
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : 'Greška' }, { status: e instanceof AuthError ? e.status : 500 });
  }
  const scope = await getMdmScope(user);
  const url = new URL(req.url);
  const deviceId = url.searchParams.get('device') ?? '';
  const kind = url.searchParams.get('kind') === 'LOGS' ? 'LOGS' : 'SCREENSHOT';
  const device = await db.mdmDevice.findFirst({ where: { id: deviceId, ...deviceWhere(scope) }, select: { id: true, lastSeenAt: true } });
  if (!device) return Response.json({ error: 'Uređaj nije dostupan.' }, { status: 404 });
  const [uploads, pending] = await Promise.all([
    db.mdmUpload.findMany({
      where: { deviceId, kind },
      orderBy: { at: 'desc' },
      take: 12,
      select: { id: true, at: true, file: { select: { name: true, size: true } } },
    }),
    db.mdmCommand.findFirst({
      where: { deviceId, type: kind === 'LOGS' ? 'UPLOAD_LOGS' : 'SCREENSHOT', status: { in: ['PENDING', 'SENT'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, createdAt: true },
    }),
  ]);
  return Response.json(
    {
      lastSeenAt: device.lastSeenAt,
      pending,
      uploads: uploads.map((u) => ({ id: u.id, at: u.at, name: u.file.name, size: u.file.size })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
}
