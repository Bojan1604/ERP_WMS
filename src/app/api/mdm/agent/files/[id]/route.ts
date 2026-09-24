import { AgentError, agentHandler, authenticateDevice } from '@/server/mdm/agent-auth';
import { fileForDevice, fileResponse } from '@/server/mdm/agent';
import { fileSize, openStream } from '@/server/mdm/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Aplikacija/datoteka dodijeljena uređaju (konfiguracija ili isporučena naredba); podržava Range. Protokol §8. */
const handler = agentHandler(async (req: Request, { params }: Ctx) => {
  const device = await authenticateDevice(req);
  const { id } = await params;
  const f = await fileForDevice(device, id);
  const size = await fileSize(f.storageKey).catch(() => null);
  if (size === null) throw new AgentError(404, 'NOT_FOUND', 'Datoteka nedostaje u pohrani.');
  return fileResponse(req, { size, sha256: f.sha256, mime: f.mime, name: f.name, open: (r) => openStream(f.storageKey, r) });
});

export const GET = handler;
export const HEAD = handler;
