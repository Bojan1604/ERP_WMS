import { AgentError, agentHandler, agentJson, authenticateDevice, readBody } from '@/server/mdm/agent-auth';
import { UPLOAD_LIMITS, checkUpload, isUploadKind, saveUpload } from '@/server/mdm/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Snimka zaslona ili zapisnik s uređaja (sirovo tijelo, vrsta se prepoznaje iz bajtova). Protokol §7. */
export const POST = agentHandler(async (req: Request) => {
  const device = await authenticateDevice(req);
  const q = new URL(req.url).searchParams;
  const kind = q.get('kind');
  if (!isUploadKind(kind)) throw new AgentError(400, 'BAD_REQUEST', 'kind mora biti SCREENSHOT ili LOGS.');
  const commandId = await checkUpload(device, kind, q.get('commandId'));
  const body = await readBody(req, UPLOAD_LIMITS[kind]);
  const name = req.headers.get('x-file-name')?.slice(0, 100) ?? null;
  return agentJson(await saveUpload(device, kind, commandId, body, name), 201);
});
