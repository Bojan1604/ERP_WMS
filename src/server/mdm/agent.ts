import 'server-only';
import { createHash, randomInt } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db, transaction, type Tx } from '../db';
import {
  AGENT_PROTOCOL,
  CHECKIN_SEC,
  COMMANDS,
  ONLINE_GRACE_SEC,
  enrollCode,
  type AgentCheckinResponse,
  type AgentCommand,
  type AgentRegisterResponse,
  type CommandType,
  type EffectiveConfig,
} from '@/domain/mdm';
import { buildEffectiveConfig } from './config';
import { expireCommands } from './commands';
import { removeFile, saveBuffer } from './storage';
import { AgentError, RateLimiter, deadTokenHash, hashToken, newDeviceToken, type AgentDevice } from './agent-auth';
import { orgTree, retireDuplicates } from './retire';

/**
 * Poslužiteljska strana protokola agenta v1 (docs/mdm-agent-protocol.md):
 * registracija, javljanje (telemetrija, događaji, konfiguracija, naredbe),
 * rezultati naredbi, slanje snimki/zapisnika i preuzimanje datoteka.
 *
 * Javljanje je najčešći poziv (tisuće uređaja svakih 60 s): bez transakcije,
 * bez velikih JSON polja osim kad trebaju, naredbe se preuzimaju jednim
 * atomskim UPDATE … RETURNING.
 */

export const AGENT_PATH = '/api/mdm/agent';
export const filePath = (fileId: string) => `${AGENT_PATH}/files/${fileId}`;

/** Poslana naredba bez rezultata nakon ovoliko minuta šalje se ponovno (agent se možda srušio). U SQL-u claimCommands kao literal. */
export const REDELIVER_MIN = 10;
export const MAX_COMMANDS_PER_CHECKIN = 20;
export const MAX_EVENTS = 50;
export const MAX_APPS = 2000;
export const KEEP_UPLOADS = 20;
export const UPLOAD_LIMITS = { SCREENSHOT: 10 * 1024 * 1024, LOGS: 50 * 1024 * 1024 } as const;
export type UploadKind = keyof typeof UPLOAD_LIMITS;

const LOW_BATTERY = 15;
const LOW_STORAGE = 0.1;
const INT_MAX = 2_147_483_647;

// ---------------------------------------------------------------- validacija ulaza

/** Tekst: skraćen, prazan → null; neispravna vrijednost se zanemaruje (undefined). */
const str = (max: number) =>
  z
    .string()
    .transform((s) => s.trim().slice(0, max) || null)
    .nullable()
    .optional()
    .catch(undefined);

/** Cijeli broj ograničen na [min, max]; neispravna vrijednost se zanemaruje. */
const int = (min: number, max: number) =>
  z
    .number()
    .finite()
    .transform((n) => Math.round(Math.min(max, Math.max(min, n))))
    .nullable()
    .optional()
    .catch(undefined);

const AppEntry = z.object({
  packageName: z.string().trim().min(1).max(200),
  name: z.string().max(200).optional().catch(undefined),
  version: z.string().max(100).optional().catch(undefined),
  versionCode: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
});

export const TelemetrySchema = z
  .object({
    serial: str(100),
    manufacturer: str(100),
    model: str(100),
    osVersion: str(100),
    agentVersion: str(50),
    imei: str(40),
    macAddress: str(40),
    ipAddress: str(64),
    wifiSsid: str(64),
    wifiSignal: int(-150, 0),
    batteryLevel: int(0, 100),
    charging: z.boolean().nullable().optional().catch(undefined),
    storageFreeMb: int(0, INT_MAX),
    storageTotalMb: int(0, INT_MAX),
    ramTotalMb: int(0, INT_MAX),
    uptimeSec: int(0, INT_MAX),
    apps: z
      .array(z.unknown())
      .transform((list) => {
        const out: z.infer<typeof AppEntry>[] = [];
        for (const a of list) {
          if (out.length >= MAX_APPS) break;
          const p = AppEntry.safeParse(a);
          if (p.success) out.push(Object.fromEntries(Object.entries(p.data).filter(([, v]) => v !== undefined)) as z.infer<typeof AppEntry>);
        }
        return out;
      })
      .optional()
      .catch(undefined),
    extra: z
      .record(z.unknown())
      .refine((o) => JSON.stringify(o).length <= 16 * 1024)
      .optional()
      .catch(undefined),
  })
  .catch({});

const EventSchema = z.object({
  at: z.string().max(40).optional().catch(undefined),
  level: z.enum(['info', 'warn', 'error']).catch('info'),
  type: z.string().trim().min(1).transform((s) => s.slice(0, 64)),
  message: z.string().transform((s) => s.slice(0, 1000)),
});

export const CheckinSchema = z.object({
  telemetry: TelemetrySchema.default({}),
  appliedConfigVersion: z.number().int().min(0).max(INT_MAX).optional().catch(undefined),
  events: z
    .array(z.unknown())
    .transform((list) => list.slice(0, MAX_EVENTS).flatMap((e) => (EventSchema.safeParse(e).data ? [EventSchema.parse(e)] : [])))
    .optional()
    .catch(undefined),
});

const optText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((s) => s?.trim().slice(0, max) || null);

export const RegisterSchema = z.object({
  protocol: z.number().int(),
  platform: z.enum(['ANDROID', 'WINDOWS']),
  enrollToken: z.string().trim().max(200).nullish(),
  hardwareId: z.string().trim().min(1).max(200),
  serial: optText(100),
  manufacturer: optText(100),
  model: optText(100),
  osVersion: optText(100),
  agentVersion: optText(50),
  name: optText(80),
});

export const CommandResultSchema = z.object({
  ok: z.boolean(),
  error: z
    .string()
    .nullish()
    .transform((s) => s?.slice(0, 2000) || null),
  result: z
    .record(z.unknown())
    .nullish()
    .refine((r) => !r || JSON.stringify(r).length <= 64 * 1024, 'Rezultat je veći od 64 KiB.'),
});

// ---------------------------------------------------------------- registracija

/** 20 registracija po IP-u u 10 minuta — sprječava „skupljanje" kodova za upis. */
export const registerLimiter = new RateLimiter(20, 10 * 60_000);

let defaultCompany: { id: string; at: number } | null = null;

/** Firma za uređaje bez ključa upisa: MDM_DEFAULT_COMPANY_ID, inače najstarija firma. */
async function defaultCompanyId(tx: Tx): Promise<string> {
  const env = process.env.MDM_DEFAULT_COMPANY_ID;
  if (env) return env;
  if (defaultCompany && Date.now() - defaultCompany.at < 5 * 60_000) return defaultCompany.id;
  const c = await tx.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!c) throw new AgentError(503, 'SERVER_ERROR', 'Poslužitelj nema nijednu firmu.');
  defaultCompany = { id: c.id, at: Date.now() };
  return c.id;
}

/** Kod za upis jedinstven među uređajima firme koji čekaju (poziva se pod zaključavanjem firme). */
async function uniqueEnrollCode(tx: Tx, companyId: string): Promise<string> {
  for (let i = 0; i < 25; i++) {
    const code = enrollCode(() => randomInt(0, 900_000) / 900_000);
    const taken = await tx.mdmDevice.count({ where: { companyId, status: 'PENDING', enrollCode: code } });
    if (!taken) return code;
  }
  throw new AgentError(503, 'SERVER_ERROR', 'Nije moguće dodijeliti kod za upis, pokušajte ponovno.');
}

export async function registerDevice(raw: unknown, ip: string | null): Promise<AgentRegisterResponse> {
  const wait = registerLimiter.take(ip ?? 'unknown');
  if (wait) throw new AgentError(429, 'RATE_LIMITED', 'Previše registracija s ove adrese, pokušajte kasnije.', {}, { 'Retry-After': String(wait) });
  const input = RegisterSchema.parse(raw);
  if (input.protocol !== AGENT_PROTOCOL) throw new AgentError(400, 'PROTOCOL_UNSUPPORTED', `Protokol ${input.protocol} nije podržan (poslužitelj: ${AGENT_PROTOCOL}).`);

  const token = newDeviceToken();
  const tokenHash = hashToken(token);

  return transaction(async (tx) => {
    let enroll: { companyId: string; orgId: string; siteId: string | null; label: string | null } | null = null;
    if (input.enrollToken) {
      // uses++ samo ako ključ vrijedi — jedan atomski upit (dva uređaja ne mogu prijeći maxUses)
      const rows = await tx.$queryRaw<Array<{ companyId: string; orgId: string; siteId: string | null; label: string | null }>>`
        UPDATE "MdmEnrollToken" t SET uses = t.uses + 1
        FROM "MdmOrg" o
        WHERE t.token = ${input.enrollToken} AND o.id = t."orgId" AND o.active
          AND (t."maxUses" IS NULL OR t.uses < t."maxUses")
          AND (t."expiresAt" IS NULL OR t."expiresAt" > now())
        RETURNING t."companyId", t."orgId", t."siteId", t.label`;
      if (!rows.length) throw new AgentError(403, 'ENROLL_TOKEN_INVALID', 'Ključ za upis ne vrijedi (nepoznat, istekao ili iskorišten).');
      enroll = rows[0];
    }
    const companyId = enroll?.companyId ?? (await defaultCompanyId(tx));
    // registracije jedne firme redom: jedinstven kod i jedan redak po hardwareId-u i pri istovremenim pozivima
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${`mdm-register:${companyId}`}))) x`;

    const same = await tx.mdmDevice.findMany({
      where: { companyId, hardwareId: input.hardwareId, platform: input.platform },
      select: { id: true, status: true, orgId: true, name: true, configVersion: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    // Odjavljeni zapis se nikad ne oživljava, a zapis druge organizacije se ne preuzima: bilješke, PIN,
    // veza na skladište i povijest (događaji, naredbe, snimke) pripadaju prethodnom vlasniku — novi zapis.
    const targetOrgId = enroll?.orgId ?? null;
    const reuse =
      (enroll && same.find((d) => d.status === 'ENROLLED' && d.orgId === enroll.orgId)) ||
      same.find((d) => d.status === 'PENDING' && (d.orgId === null || d.orgId === targetOrgId)) ||
      null;

    const now = new Date();
    const code = enroll ? null : await uniqueEnrollCode(tx, companyId);
    const info = {
      hardwareId: input.hardwareId,
      platform: input.platform,
      ...(input.serial ? { serial: input.serial } : {}),
      ...(input.manufacturer ? { manufacturer: input.manufacturer } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.osVersion ? { osVersion: input.osVersion } : {}),
      ...(input.agentVersion ? { agentVersion: input.agentVersion } : {}),
    };
    const place = enroll
      ? { orgId: enroll.orgId, siteId: enroll.siteId, enrolledAt: now }
      : { orgId: null, siteId: null, enrolledAt: null };
    // postavke prethodnog života uređaja vrijede samo u istoj organizaciji
    const keepSetup = !!(reuse && enroll && reuse.orgId === enroll.orgId);
    const common = {
      ...info,
      ...place,
      status: enroll ? ('ENROLLED' as const) : ('PENDING' as const),
      enrollCode: code,
      tokenHash,
      appliedConfigVersion: 0,
      lastSeenAt: now,
      onlineSince: now,
      ...(keepSetup ? {} : { profileId: null, overrides: {} }),
    };

    let deviceId: string;
    if (reuse) {
      const d = await tx.mdmDevice.update({
        where: { id: reuse.id },
        data: { ...common, configVersion: reuse.configVersion + 1 },
        select: { id: true },
      });
      deviceId = d.id;
      await tx.mdmCommand.updateMany({
        where: { deviceId, status: { in: ['PENDING', 'SENT'] } },
        data: { status: 'CANCELLED', doneAt: now, error: 'Agent je ponovno registriran.' },
      });
    } else {
      const name = input.name || [input.manufacturer, input.model].filter(Boolean).join(' ') || `${input.platform === 'ANDROID' ? 'Android' : 'Windows'} ${input.hardwareId.slice(-6)}`;
      const d = await tx.mdmDevice.create({
        data: { ...common, companyId, name, configVersion: 1, telemetry: {} },
        select: { id: true },
      });
      deviceId = d.id;
    }
    // ostali zapisi istog uređaja: oni na čekanju uvijek, upisani tek kad je ovaj zapis upisan
    // (bez ključa upisa stari zapis ostaje do upisa kodom — enrollByCode ga tada odjavljuje)
    await retireDuplicates(
      tx,
      { companyId, hardwareId: input.hardwareId, platform: input.platform, keepId: deviceId, orgIds: enroll ? await orgTree(tx, enroll.orgId) : [] },
      enroll ? ['ENROLLED', 'PENDING'] : ['PENDING'],
      'Agent je ponovno registriran kao novi zapis uređaja.',
      now,
    );
    await tx.mdmEvent.create({
      data: {
        deviceId,
        type: enroll ? 'ENROLLED' : 'REGISTERED',
        message: enroll
          ? `Uređaj upisan ključem${enroll.label ? ` „${enroll.label}"` : ''}${reuse ? ' (ponovna instalacija agenta)' : ''}.`
          : `Agent se prijavio${reuse ? ' ponovno' : ''}, čeka upis (kod ${code}).`,
        data: { agentVersion: input.agentVersion, ip },
      },
    });
    const res: AgentRegisterResponse = { deviceId, token, status: enroll ? 'ENROLLED' : 'PENDING', enrollCode: code, checkinSec: CHECKIN_SEC };
    return res;
  });
}

// ---------------------------------------------------------------- javljanje

type ClaimedRow = { id: string; type: string; payload: Prisma.JsonValue; createdAt: Date };

/**
 * Preuzima naredbe za isporuku: PENDING (neistekle) i SENT bez rezultata starije od
 * REDELIVER_MIN minuta, najstarije prve. Jedan UPDATE … RETURNING sa SKIP LOCKED —
 * dva istovremena javljanja nikad ne dobiju istu naredbu.
 */
export async function claimCommands(deviceId: string, limit = MAX_COMMANDS_PER_CHECKIN): Promise<ClaimedRow[]> {
  // CTE je MATERIALIZED: podupit s LIMIT … SKIP LOCKED unutar IN (…) planer smije izvesti više puta (više od LIMIT redaka)
  const rows = await db.$queryRaw<ClaimedRow[]>`
    WITH picked AS MATERIALIZED (
      SELECT id FROM "MdmCommand"
      WHERE "deviceId" = ${deviceId}
        AND (status = 'PENDING' OR (status = 'SENT' AND "sentAt" < now() - interval '10 minutes'))
        AND ("expiresAt" IS NULL OR "expiresAt" > now())
      ORDER BY "createdAt" ASC, id ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "MdmCommand" c SET status = 'SENT', "sentAt" = now()
    FROM picked
    WHERE c.id = picked.id
      AND (c.status = 'PENDING' OR (c.status = 'SENT' AND c."sentAt" < now() - interval '10 minutes'))
    RETURNING c.id, c.type, c.payload, c."createdAt"`;
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
}

type Payload = Record<string, unknown>;
const asObj = (v: unknown): Payload => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : {});
const s = (v: unknown) => (typeof v === 'string' && v ? v : null);

/**
 * Portal smije poslati skraćeni oblik (INSTALL_APP {appId, versionId?}, PUSH_FILE {fileId, targetPath});
 * pri isporuci se dopunjuje paketom, verzijom, poveznicom i sažetkom, i sprema natrag
 * (preuzimanje datoteke provjerava naredbe uređaja).
 */
async function completePayload(device: AgentDevice, type: string, payload: Payload): Promise<Payload | null> {
  if (type === 'INSTALL_APP' && s(payload.appId) && !(s(payload.downloadPath) && s(payload.sha256))) {
    const app = await db.mdmApp.findFirst({
      where: { id: s(payload.appId)!, companyId: device.companyId, platform: device.platform },
      include: { versions: { include: { file: { select: { id: true, sha256: true } } }, orderBy: [{ versionCode: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }] } },
    });
    if (!app) return { ...payload, error: 'Aplikacija ne postoji ili nije za ovu platformu.' };
    const v = (s(payload.versionId) && app.versions.find((x) => x.id === payload.versionId)) || app.versions[0];
    if (!v) return { ...payload, error: 'Aplikacija nema nijednu verziju.' };
    return {
      ...payload,
      appId: app.id,
      versionId: v.id,
      packageName: app.packageName,
      name: app.name,
      version: v.version,
      versionCode: v.versionCode,
      downloadPath: filePath(v.file.id),
      sha256: v.file.sha256,
      installArgs: app.installArgs,
    };
  }
  if (type === 'PUSH_FILE' && s(payload.fileId) && !(s(payload.downloadPath) && s(payload.sha256))) {
    const f = await db.mdmFile.findFirst({
      where: { id: s(payload.fileId)!, companyId: device.companyId, kind: { notIn: ['SCREENSHOT', 'LOGS'] } },
      select: { id: true, name: true, sha256: true, size: true },
    });
    if (!f) return { ...payload, error: 'Datoteka ne postoji.' };
    return { ...payload, fileId: f.id, name: f.name, downloadPath: filePath(f.id), sha256: f.sha256, size: f.size, targetPath: s(payload.targetPath) ?? f.name };
  }
  return null;
}

function transitionEvents(device: AgentDevice, t: z.infer<typeof TelemetrySchema>, applied: number | undefined, configVersion: number, now: Date) {
  const ev: Prisma.MdmEventCreateManyInput[] = [];
  const add = (type: string, message: string, level = 'info', data?: Prisma.InputJsonValue) => ev.push({ deviceId: device.id, at: now, type, message, level, data });
  if (device.lastSeenAt) {
    const gone = now.getTime() - device.lastSeenAt.getTime();
    if (gone > ONLINE_GRACE_SEC * 1000) add('ONLINE', `Uređaj ponovno dostupan (nije se javljao ${formatDuration(gone)}).`);
  }
  if (t.uptimeSec != null && device.uptimeSec != null && t.uptimeSec + 60 < device.uptimeSec) add('BOOT', 'Uređaj je ponovno pokrenut.');
  const battery = t.batteryLevel !== undefined ? t.batteryLevel : device.batteryLevel;
  const charging = t.charging !== undefined ? t.charging : device.charging;
  if (battery != null && battery < LOW_BATTERY && !charging && (device.batteryLevel == null || device.batteryLevel >= LOW_BATTERY || device.charging))
    add('BATTERY_LOW', `Slaba baterija (${battery} %).`, 'warn');
  const ratio = (free: number | null | undefined, total: number | null | undefined) => (free != null && total ? free / total : null);
  const before = ratio(device.storageFreeMb, device.storageTotalMb);
  const after = ratio(t.storageFreeMb !== undefined ? t.storageFreeMb : device.storageFreeMb, t.storageTotalMb !== undefined ? t.storageTotalMb : device.storageTotalMb);
  if (after != null && after < LOW_STORAGE && (before == null || before >= LOW_STORAGE)) add('STORAGE_LOW', `Malo slobodnog prostora (${Math.round(after * 100)} %).`, 'warn');
  if (t.agentVersion && device.agentVersion && t.agentVersion !== device.agentVersion) add('AGENT_UPDATED', `Agent ažuriran: ${device.agentVersion} → ${t.agentVersion}.`);
  if (t.osVersion && device.osVersion && t.osVersion !== device.osVersion) add('OS_UPDATED', `Sustav ažuriran: ${device.osVersion} → ${t.osVersion}.`);
  if (applied !== undefined && applied === configVersion && device.appliedConfigVersion !== configVersion && device.status === 'ENROLLED')
    add('CONFIG_APPLIED', `Konfiguracija v${configVersion} primijenjena.`);
  return ev;
}

function formatDuration(ms: number) {
  const min = Math.round(ms / 60_000);
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

function eventTime(at: string | undefined, now: Date): Date {
  const t = at ? Date.parse(at) : NaN;
  return Number.isFinite(t) && t > now.getTime() - 7 * 86_400_000 && t < now.getTime() + 5 * 60_000 ? new Date(t) : now;
}

export async function checkin(device: AgentDevice, raw: unknown, ip: string | null, now = new Date()): Promise<AgentCheckinResponse> {
  const input = CheckinSchema.parse(raw);
  const t = input.telemetry;
  const enrolled = device.status === 'ENROLLED';
  // upisan uređaj s verzijom 0 (portal nije podigao verziju) — konfiguracija ipak mora stići
  const configVersion = enrolled && device.configVersion < 1 ? 1 : device.configVersion;
  const reported = input.appliedConfigVersion;
  const applied = reported === undefined ? device.appliedConfigVersion : Math.min(reported, configVersion);

  const data: Prisma.MdmDeviceUpdateInput = { lastSeenAt: now };
  for (const k of ['serial', 'manufacturer', 'model', 'osVersion', 'agentVersion', 'imei', 'macAddress', 'ipAddress', 'wifiSsid', 'wifiSignal', 'batteryLevel', 'charging', 'storageFreeMb', 'storageTotalMb', 'ramTotalMb', 'uptimeSec'] as const) {
    if (t[k] !== undefined) (data as Record<string, unknown>)[k] = t[k];
  }
  if (ip) data.publicIp = ip;
  if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() > ONLINE_GRACE_SEC * 1000) data.onlineSince = now;
  if (reported !== undefined) data.appliedConfigVersion = applied;
  if (configVersion !== device.configVersion) data.configVersion = configVersion;

  // telemetry (JSON) se spaja: aplikacije šalje agent samo kad se promijene
  const patch: Record<string, unknown> = {};
  if (t.apps !== undefined) Object.assign(patch, { apps: t.apps, appsAt: now.toISOString() });
  if (t.extra !== undefined) patch.extra = t.extra;

  const events = transitionEvents(device, t, reported, configVersion, now);
  for (const e of input.events ?? []) events.push({ deviceId: device.id, at: eventTime(e.at, now), level: e.level, type: e.type, message: e.message });

  const writes: Promise<unknown>[] = [
    Object.keys(patch).length
      ? db.$executeRaw`UPDATE "MdmDevice" SET telemetry = COALESCE(telemetry, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb WHERE id = ${device.id}`
      : Promise.resolve(),
    db.mdmDevice.update({ where: { id: device.id }, data, select: { id: true } }),
    events.length ? db.mdmEvent.createMany({ data: events }) : Promise.resolve(),
  ];

  let claimed: ClaimedRow[] = [];
  if (enrolled) {
    const [, rows] = await Promise.all([expireCommands(db, device.id), claimCommands(device.id), ...writes]);
    claimed = rows as ClaimedRow[];
  } else {
    await Promise.all(writes);
  }

  const commands: AgentCommand[] = [];
  for (const c of claimed) {
    let payload = asObj(c.payload);
    const full = await completePayload(device, c.type, payload);
    if (full) {
      payload = full;
      await db.mdmCommand.update({ where: { id: c.id }, data: { payload: full as Prisma.InputJsonValue }, select: { id: true } });
    }
    commands.push({ id: c.id, type: c.type as CommandType, payload });
  }

  let config: EffectiveConfig | null = null;
  if (enrolled && (applied !== configVersion || commands.some((c) => c.type === 'APPLY_CONFIG'))) {
    const extra = await db.mdmDevice.findUnique({ where: { id: device.id }, select: { overrides: true } });
    config = await buildEffectiveConfig(db, { ...device, configVersion, overrides: extra?.overrides ?? {} });
  }

  return {
    status: device.status as 'PENDING' | 'ENROLLED',
    enrollCode: device.status === 'PENDING' ? device.enrollCode : null,
    deviceName: device.name,
    checkinSec: CHECKIN_SEC,
    config,
    commands,
  };
}

// ---------------------------------------------------------------- rezultat naredbe

export interface CommandResultResponse {
  id: string;
  status: 'SUCCEEDED' | 'FAILED';
  deviceStatus: 'PENDING' | 'ENROLLED' | 'RETIRED';
  duplicate: boolean;
}

/** Naredbe čiji uspjeh odjavljuje uređaj. */
const RETIRING: ReadonlySet<string> = new Set(['FORGET', 'WIPE']);

export async function commandResult(device: AgentDevice, commandId: string, raw: unknown): Promise<CommandResultResponse> {
  const input = CommandResultSchema.parse(raw);
  return transaction(async (tx) => {
    const cmd = await tx.mdmCommand.findFirst({
      where: { id: commandId, deviceId: device.id },
      select: { id: true, type: true, status: true, sentAt: true, result: true },
    });
    if (!cmd) throw new AgentError(404, 'NOT_FOUND', 'Naredba ne postoji.');
    const done = (status: 'SUCCEEDED' | 'FAILED', duplicate: boolean): CommandResultResponse => ({ id: cmd.id, status, deviceStatus: device.status, duplicate });
    if (cmd.status === 'SUCCEEDED' || cmd.status === 'FAILED') return done(cmd.status, true);
    if (cmd.status === 'PENDING' || cmd.status === 'CANCELLED' || (cmd.status === 'EXPIRED' && !cmd.sentAt))
      throw new AgentError(409, 'COMMAND_CLOSED', 'Naredba nije isporučena ovom uređaju ili je otkazana.');

    const now = new Date();
    const status = input.ok ? 'SUCCEEDED' : 'FAILED';
    const result = { ...asObj(cmd.result), ...(input.result ?? {}) } as Prisma.InputJsonValue;
    const r = await tx.mdmCommand.updateMany({
      where: { id: cmd.id, status: { in: ['SENT', 'EXPIRED'] } },
      data: { status, result, error: input.ok ? null : input.error || 'Neuspjelo.', doneAt: now },
    });
    if (!r.count) {
      const again = await tx.mdmCommand.findUniqueOrThrow({ where: { id: cmd.id }, select: { status: true } });
      if (again.status === 'SUCCEEDED' || again.status === 'FAILED') return done(again.status, true);
      throw new AgentError(409, 'COMMAND_CLOSED', 'Naredba je u međuvremenu zatvorena.');
    }
    const label = COMMANDS[cmd.type as CommandType]?.label ?? cmd.type;
    await tx.mdmEvent.create({
      data: {
        deviceId: device.id,
        at: now,
        type: 'COMMAND_RESULT',
        level: input.ok ? 'info' : 'error',
        message: input.ok ? `Izvršeno: ${label}` : `Neuspjelo: ${label} — ${input.error || 'bez opisa'}`,
        data: { commandId: cmd.id },
      },
    });
    let deviceStatus = device.status;
    if (input.ok && RETIRING.has(cmd.type)) {
      // odjava: ključ se poništava (agent je već očistio stanje), organizacija ostaje radi povijesti
      await tx.mdmDevice.update({ where: { id: device.id }, data: { status: 'RETIRED', tokenHash: deadTokenHash(), enrollCode: null, onlineSince: null }, select: { id: true } });
      await tx.mdmCommand.updateMany({
        where: { deviceId: device.id, status: { in: ['PENDING', 'SENT'] } },
        data: { status: 'CANCELLED', doneAt: now, error: 'Uređaj je odjavljen.' },
      });
      await tx.mdmEvent.create({ data: { deviceId: device.id, at: now, type: 'RETIRED', level: 'warn', message: cmd.type === 'WIPE' ? 'Uređaj vraćen na tvorničke postavke i odjavljen.' : 'Uređaj odjavljen (Forget).' } });
      deviceStatus = 'RETIRED';
    }
    return { id: cmd.id, status, deviceStatus, duplicate: false };
  });
}

// ---------------------------------------------------------------- slanje datoteka s uređaja

export function isUploadKind(k: string | null): k is UploadKind {
  return k === 'SCREENSHOT' || k === 'LOGS';
}

/** Vrsta sadržaja iz prvih bajtova — zaglavlju Content-Type se ne vjeruje. */
export function sniffUpload(kind: UploadKind, buf: Buffer): { mime: string; ext: string } | null {
  const starts = (...b: number[]) => buf.length >= b.length && b.every((x, i) => buf[i] === x);
  if (kind === 'SCREENSHOT') {
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { mime: 'image/png', ext: 'png' };
    if (starts(0xff, 0xd8, 0xff)) return { mime: 'image/jpeg', ext: 'jpg' };
    return null;
  }
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06)) return { mime: 'application/zip', ext: 'zip' };
  if (starts(0x1f, 0x8b, 0x08)) return { mime: 'application/gzip', ext: 'gz' };
  if (buf.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { mime: 'text/plain; charset=utf-8', ext: 'txt' };
  } catch {
    return null;
  }
}

/** Provjere prije čitanja tijela (ne čita se 50 MB za zahtjev koji će ionako biti odbijen). */
export async function checkUpload(device: AgentDevice, kind: UploadKind, commandId: string | null) {
  if (device.status !== 'ENROLLED') throw new AgentError(403, 'FORBIDDEN', 'Uređaj još nije upisan.');
  if (!commandId) return null;
  const cmd = await db.mdmCommand.findFirst({
    where: {
      id: commandId,
      deviceId: device.id,
      type: kind === 'SCREENSHOT' ? 'SCREENSHOT' : 'UPLOAD_LOGS',
      OR: [{ status: 'SENT' }, { status: 'EXPIRED', sentAt: { not: null } }],
    },
    select: { id: true },
  });
  if (!cmd) throw new AgentError(404, 'NOT_FOUND', 'Naredba za ovo slanje ne postoji.');
  return cmd.id;
}

const safeName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 80) || 'uredaj';

export async function saveUpload(
  device: AgentDevice,
  kind: UploadKind,
  commandId: string | null,
  buf: Buffer,
  fileName: string | null,
  now = new Date(),
): Promise<{ fileId: string; size: number; sha256: string; mime: string }> {
  if (!buf.length) throw new AgentError(400, 'BAD_REQUEST', 'Prazna datoteka.');
  const type = sniffUpload(kind, buf);
  if (!type) throw new AgentError(415, 'UNSUPPORTED_TYPE', kind === 'SCREENSHOT' ? 'Snimka zaslona mora biti PNG ili JPEG.' : 'Zapisnik mora biti tekst (UTF-8), zip ili gzip.');
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const given = fileName ? safeName(fileName.replace(/\.[^.]*$/, '')) : null;
  const name = `${given ?? `${kind === 'SCREENSHOT' ? 'snimka' : 'zapisnik'}-${safeName(device.name)}-${stamp}`}.${type.ext}`;

  const stored = await saveBuffer(buf);
  let fileId: string;
  try {
    fileId = await transaction(async (tx) => {
      const f = await tx.mdmFile.create({
        data: { companyId: device.companyId, orgId: device.orgId, kind, name, mime: type.mime, size: stored.size, sha256: stored.sha256, storageKey: stored.key, createdBy: `Uređaj: ${device.name}`.slice(0, 120) },
        select: { id: true },
      });
      await tx.mdmUpload.create({ data: { deviceId: device.id, kind, fileId: f.id, at: now } });
      if (commandId) {
        const c = await tx.mdmCommand.findUnique({ where: { id: commandId }, select: { result: true } });
        await tx.mdmCommand.update({ where: { id: commandId }, data: { result: { ...asObj(c?.result), fileId: f.id } }, select: { id: true } });
      }
      await tx.mdmEvent.create({
        data: { deviceId: device.id, at: now, type: 'UPLOAD', message: `${kind === 'SCREENSHOT' ? 'Snimka zaslona' : 'Zapisnik'} primljen (${Math.max(1, Math.round(stored.size / 1024))} kB).`, data: { fileId: f.id } },
      });
      return f.id;
    });
  } catch (e) {
    await removeFile(stored.key).catch(() => {});
    throw e;
  }
  await pruneUploads(device.id, kind).catch((e) => console.error('[mdm-agent] čišćenje slanja', e));
  return { fileId, size: stored.size, sha256: stored.sha256, mime: type.mime };
}

/** Zadržava samo KEEP_UPLOADS najnovijih slanja te vrste po uređaju. */
export async function pruneUploads(deviceId: string, kind: UploadKind, keep = KEEP_UPLOADS) {
  const old = await db.mdmUpload.findMany({
    where: { deviceId, kind },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    skip: keep,
    select: { fileId: true, file: { select: { storageKey: true } } },
  });
  if (!old.length) return 0;
  await db.mdmFile.deleteMany({ where: { id: { in: old.map((o) => o.fileId) }, kind } });
  await Promise.all(old.map((o) => removeFile(o.file.storageKey).catch(() => {})));
  return old.length;
}

// ---------------------------------------------------------------- preuzimanje datoteka na uređaj

/**
 * Datoteka koju uređaj smije preuzeti: u trenutnoj konfiguraciji uređaja ili u naredbi
 * INSTALL_APP / PUSH_FILE isporučenoj ovom uređaju (još bez rezultata).
 */
export async function fileForDevice(device: AgentDevice, fileId: string) {
  if (device.status !== 'ENROLLED') throw new AgentError(403, 'FORBIDDEN', 'Uređaj još nije upisan.');
  const file = await db.mdmFile.findFirst({
    where: { id: fileId, companyId: device.companyId, kind: { notIn: ['SCREENSHOT', 'LOGS'] } },
    select: { id: true, name: true, mime: true, size: true, sha256: true, storageKey: true },
  });
  if (!file) throw new AgentError(404, 'NOT_FOUND', 'Datoteka ne postoji.');
  const p = filePath(fileId);
  const cmds = await db.mdmCommand.findMany({
    where: { deviceId: device.id, status: 'SENT', type: { in: ['INSTALL_APP', 'PUSH_FILE'] } },
    select: { payload: true },
    take: 200,
  });
  if (cmds.some((c) => asObj(c.payload).fileId === fileId || asObj(c.payload).downloadPath === p)) return file;
  const extra = await db.mdmDevice.findUnique({ where: { id: device.id }, select: { overrides: true } });
  const cfg = await buildEffectiveConfig(db, { ...device, overrides: extra?.overrides ?? {} });
  if (cfg.apps.some((a) => a.downloadPath === p)) return file;
  throw new AgentError(403, 'FORBIDDEN', 'Datoteka nije dodijeljena ovom uređaju.');
}

/** Jedan raspon iz zaglavlja Range; null = cijela datoteka, 'invalid' = 416. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return header.trim().startsWith('bytes=') && header.includes(',') ? null : 'invalid';
  const [, a, b] = m;
  if (!a && !b) return 'invalid';
  if (!a) {
    const n = Number(b);
    if (!n || !size) return 'invalid';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  const end = b ? Math.min(Number(b), size - 1) : size - 1;
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

export interface Streamable {
  size: number;
  sha256: string;
  mime: string;
  name: string;
  open: (range?: { start: number; end: number }) => NodeJS.ReadableStream;
}

/** Odgovor s datotekom: Content-Length, sažetak, Range (nastavak prekinutog preuzimanja), HEAD. */
export function fileResponse(req: Request, f: Streamable, extraHeaders: Record<string, string> = {}): Response {
  const etag = `"${f.sha256}"`;
  const headers: Record<string, string> = {
    'Content-Type': f.mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'X-Content-SHA256': f.sha256,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Cache-Control': 'private, no-cache',
    'X-MDM-Protocol': String(AGENT_PROTOCOL),
    ...extraHeaders,
  };
  const ifRange = req.headers.get('if-range');
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.get('range'), f.size);
  if (range === 'invalid') {
    return Response.json({ error: 'Neispravan raspon.', code: 'RANGE_NOT_SATISFIABLE' }, { status: 416, headers: { 'Content-Range': `bytes */${f.size}`, 'Cache-Control': 'no-store' } });
  }
  const head = req.method === 'HEAD';
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${f.size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
  } else {
    headers['Content-Length'] = String(f.size);
  }
  const body = head || f.size === 0 ? null : (Readable.toWeb(f.open(range ?? undefined) as Readable) as unknown as ReadableStream);
  return new Response(body, { status: range ? 206 : 200, headers });
}

// ---------------------------------------------------------------- instalacije agenta (javno)

export const ARTIFACTS = {
  android: { rel: 'android/app-release.apk', mime: 'application/vnd.android.package-archive', name: 'wms-agent.apk', template: false },
  windows: { rel: 'windows/wms-agent.zip', mime: 'application/zip', name: 'wms-agent.zip', template: false },
  'windows-install': { rel: 'windows/install.ps1', mime: 'text/plain; charset=utf-8', name: 'install.ps1', template: true },
} as const;
export type ArtifactName = keyof typeof ARTIFACTS;
export const isArtifact = (s: string): s is ArtifactName => Object.hasOwn(ARTIFACTS, s);

export const agentDir = () => path.resolve(process.env.MDM_AGENT_DIR || path.join(process.cwd(), 'agents', 'dist'));

/** SHA-256 potpisa APK-a za Android QR: MDM_ANDROID_SIGNATURE_CHECKSUM, inače iz izgradnje (agents/dist). */
export async function androidSignatureChecksum(): Promise<string | null> {
  const env = process.env.MDM_ANDROID_SIGNATURE_CHECKSUM?.trim();
  if (env) return env;
  try {
    const v = (await readFile(path.join(agentDir(), 'android', 'signature-checksum.txt'), 'utf8')).trim();
    return /^[A-Za-z0-9_-]{43}=?$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

const shaCache = new Map<string, { key: string; sha256: string }>();

async function sha256File(file: string, size: number, mtimeMs: number): Promise<string> {
  const key = `${size}:${mtimeMs}`;
  const hit = shaCache.get(file);
  if (hit?.key === key) return hit.sha256;
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  const sha256 = h.digest('hex');
  shaCache.set(file, { key, sha256 });
  return sha256;
}

/** Datoteka agenta na disku ili null ako još nije izgrađena. */
export async function artifactFile(name: ArtifactName) {
  const a = ARTIFACTS[name];
  const file = path.join(agentDir(), a.rel);
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return null;
  return { file, size: st.size, sha256: await sha256File(file, st.size, st.mtimeMs), ...a };
}

/** Javna adresa poslužitelja za instalacijsku skriptu. */
export function publicUrl(req: Request): string {
  const env = process.env.MDM_PUBLIC_URL?.replace(/\/+$/, '');
  if (env) return env;
  const u = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim() || u.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() || req.headers.get('host') || u.host;
  const url = `${proto}://${host}`;
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(url) ? url : u.origin;
}

/** install.ps1 s adresom poslužitelja i ključem upisa (samo sigurni znakovi — ide u PowerShell). */
export async function renderInstallScript(file: string, serverUrl: string, token: string | null): Promise<Buffer> {
  const src = await readFile(file, 'utf8');
  const tok = token && /^[A-Za-z0-9_-]{1,128}$/.test(token) ? token : '';
  return Buffer.from(src.replaceAll('__MDM_SERVER_URL__', serverUrl).replaceAll('__MDM_ENROLL_TOKEN__', tok), 'utf8');
}
