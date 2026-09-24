import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { db } from '../db';
import { AGENT_PROTOCOL } from '@/domain/mdm';

/**
 * Autentikacija i HTTP pomoćnici za API agenta (/api/mdm/agent/*).
 * Agent se predstavlja zaglavljem `Authorization: Device <token>`; u bazi je
 * samo sha256 tokena (MdmDevice.tokenHash, jedinstveni indeks). Protokol:
 * docs/mdm-agent-protocol.md.
 */

// ---------------------------------------------------------------- tokeni

/** Novi tajni ključ uređaja: 32 nasumična bajta, base64url (43 znaka). */
export const newDeviceToken = () => randomBytes(32).toString('base64url');

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** Nasumičan sažetak koji ne odgovara nijednom tokenu (poništavanje ključa pri odjavi). */
export const deadTokenHash = () => hashToken(`retired:${randomBytes(32).toString('hex')}`);

export function parseDeviceAuth(header: string | null): string | null {
  const m = /^Device\s+([A-Za-z0-9_-]{20,200})\s*$/.exec(header ?? '');
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- greške i odgovori

export class AgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-MDM-Protocol': String(AGENT_PROTOCOL) };

export function agentJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function agentErrorResponse(e: unknown): Response {
  if (e instanceof AgentError) return agentJson({ error: e.message, code: e.code, ...e.extra }, e.status, e.headers);
  if (e instanceof ZodError) {
    const i = e.issues[0];
    return agentJson({ error: `Neispravan zahtjev: ${i ? `${i.path.join('.') || 'tijelo'} — ${i.message}` : ''}`, code: 'BAD_REQUEST' }, 400);
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') return agentJson({ error: 'Ne postoji.', code: 'NOT_FOUND' }, 404);
  console.error('[mdm-agent]', e);
  return agentJson({ error: 'Greška poslužitelja.', code: 'SERVER_ERROR' }, 500);
}

/** Omotač rukovatelja: sve greške postaju JSON odgovor protokola. */
export function agentHandler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return agentErrorResponse(e);
    }
  };
}

/** JSON tijelo s ograničenjem veličine (zadano 2 MiB). */
export async function readJson(req: Request, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new AgentError(400, 'BAD_REQUEST', 'Tijelo zahtjeva nije ispravan JSON.');
  }
}

/** Čita tijelo zahtjeva u memoriju, prekida čim prijeđe `maxBytes` (ne vjeruje Content-Lengthu). */
export async function readBody(req: Request, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new AgentError(413, 'TOO_LARGE', `Tijelo je veće od ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, size);
}

/** Javna adresa klijenta: prvi X-Forwarded-For (proxy ga mora prepisivati), inače X-Real-IP. */
export function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  const ip = (xff ? xff.split(',')[0] : req.headers.get('x-real-ip'))?.trim();
  if (!ip) return null;
  return ip.replace(/^::ffff:/, '').slice(0, 64) || null;
}

// ---------------------------------------------------------------- ograničenje učestalosti

/** Jednostavan brojač u memoriji procesa (fiksni prozor po ključu). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Vraća 0 kad je dopušteno, inače broj sekundi do novog prozora. */
  take(key: string, now = Date.now()): number {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return 0;
    }
    if (h.n >= this.limit) return Math.max(1, Math.ceil((h.reset - now) / 1000));
    h.n++;
    return 0;
  }

  reset() {
    this.hits.clear();
  }
}

// ---------------------------------------------------------------- uređaj iz tokena

/** Stupci potrebni za javljanje — bez velikih JSON polja (telemetry, overrides). */
export const AUTH_SELECT = {
  id: true,
  companyId: true,
  orgId: true,
  siteId: true,
  profileId: true,
  platform: true,
  status: true,
  name: true,
  enrollCode: true,
  maintenancePin: true,
  configVersion: true,
  appliedConfigVersion: true,
  lastSeenAt: true,
  batteryLevel: true,
  charging: true,
  storageFreeMb: true,
  storageTotalMb: true,
  agentVersion: true,
  osVersion: true,
  uptimeSec: true,
} satisfies Prisma.MdmDeviceSelect;

export type AgentDevice = Prisma.MdmDeviceGetPayload<{ select: typeof AUTH_SELECT }>;

/**
 * Uređaj iz zaglavlja `Authorization: Device <token>`.
 * Nepoznat token → 401; odjavljen uređaj → 410 { status: 'RETIRED' } (agent se gasi).
 */
export async function authenticateDevice(req: Request): Promise<AgentDevice> {
  const token = parseDeviceAuth(req.headers.get('authorization'));
  if (!token) throw new AgentError(401, 'UNAUTHORIZED', 'Nedostaje ključ uređaja (Authorization: Device <token>).');
  const device = await db.mdmDevice.findUnique({ where: { tokenHash: hashToken(token) }, select: AUTH_SELECT });
  if (!device) throw new AgentError(401, 'UNAUTHORIZED', 'Nepoznat ključ uređaja.');
  if (device.status === 'RETIRED') throw new AgentError(410, 'RETIRED', 'Uređaj je odjavljen.', { status: 'RETIRED' });
  return device;
}
