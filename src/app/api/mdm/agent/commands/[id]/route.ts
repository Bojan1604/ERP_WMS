import { agentHandler, agentJson, authenticateDevice, readJson } from '@/server/mdm/agent-auth';
import { commandResult } from '@/server/mdm/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Rezultat naredbe (samo uređaj kojem je isporučena). Protokol §5.3. */
export const POST = agentHandler(async (req: Request, { params }: Ctx) => {
  const device = await authenticateDevice(req);
  const { id } = await params;
  return agentJson(await commandResult(device, id, await readJson(req, 256 * 1024)));
});
