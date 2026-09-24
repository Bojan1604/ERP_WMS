import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { AgentError, agentHandler, agentJson } from '@/server/mdm/agent-auth';
import { ARTIFACTS, AGENT_PATH, artifactFile, fileResponse, isArtifact, publicUrl, renderInstallScript } from '@/server/mdm/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ artifact: string }> };

/**
 * Instalacije agenta (javno, bez tajni): android, windows, windows-install (?token=) i info (JSON).
 * Datoteke iz $MDM_AGENT_DIR ili agents/dist/. Protokol §11.
 */
const handler = agentHandler(async (req: Request, { params }: Ctx) => {
  const { artifact } = await params;
  if (artifact === 'info') {
    const base = publicUrl(req);
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(ARTIFACTS) as Array<keyof typeof ARTIFACTS>) {
      const f = await artifactFile(name);
      out[name] = f
        ? { available: true, size: f.size, sha256: f.sha256, sha256Base64Url: Buffer.from(f.sha256, 'hex').toString('base64url'), url: `${base}${AGENT_PATH}/download/${name}` }
        : { available: false, url: `${base}${AGENT_PATH}/download/${name}` };
    }
    return agentJson(out);
  }
  if (!isArtifact(artifact)) throw new AgentError(404, 'NOT_FOUND', 'Nepoznata datoteka agenta (android, windows, windows-install, info).');
  const f = await artifactFile(artifact);
  if (!f) throw new AgentError(404, 'NOT_FOUND', `Agent još nije izgrađen: nedostaje ${ARTIFACTS[artifact].rel} (agents/dist ili MDM_AGENT_DIR).`);
  if (f.template) {
    const q = new URL(req.url).searchParams;
    const buf = await renderInstallScript(f.file, publicUrl(req), q.get('token'));
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const open = (r?: { start: number; end: number }) => Readable.from([r ? buf.subarray(r.start, r.end + 1) : buf]);
    return fileResponse(req, { size: buf.length, sha256, mime: f.mime, name: f.name, open }, { 'Cache-Control': 'no-store' });
  }
  return fileResponse(req, { size: f.size, sha256: f.sha256, mime: f.mime, name: f.name, open: (r) => createReadStream(f.file, r) });
});

export const GET = handler;
export const HEAD = handler;
