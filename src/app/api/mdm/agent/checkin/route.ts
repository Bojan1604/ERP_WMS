import { agentHandler, agentJson, authenticateDevice, clientIp, readJson } from '@/server/mdm/agent-auth';
import { checkin } from '@/server/mdm/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Periodično javljanje: telemetrija i događaji → stanje, konfiguracija i naredbe. Protokol §4. */
export const POST = agentHandler(async (req: Request) => {
  const device = await authenticateDevice(req);
  return agentJson(await checkin(device, await readJson(req), clientIp(req)));
});
