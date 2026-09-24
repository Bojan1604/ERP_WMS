import { agentHandler, agentJson, clientIp, readJson } from '@/server/mdm/agent-auth';
import { registerDevice } from '@/server/mdm/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Prvo javljanje agenta (bez autentikacije). Protokol: docs/mdm-agent-protocol.md §3. */
export const POST = agentHandler(async (req: Request) => {
  const ip = clientIp(req);
  return agentJson(await registerDevice(await readJson(req), ip));
});
