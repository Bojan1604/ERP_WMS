/**
 * MDM — čista logika (bez baze): vrste naredbi i tko ih smije slati, stanje
 * uređaja (online/offline), upozorenja, spajanje profila i postavki uređaja u
 * konfiguraciju koju agent primjenjuje, te oblik poruka između agenta i
 * poslužitelja (protokol v1).
 */
import type { Level } from './permissions';

export type Platform = 'ANDROID' | 'WINDOWS';

export const PLATFORM_LABEL: Record<Platform, string> = { ANDROID: 'Android', WINDOWS: 'Windows' };

// ---------------------------------------------------------------- naredbe

export type CommandType =
  | 'REBOOT'
  | 'FORGET'
  | 'APPLY_CONFIG'
  | 'INSTALL_APP'
  | 'UNINSTALL_APP'
  | 'SCREENSHOT'
  | 'UPLOAD_LOGS'
  | 'LOCK'
  | 'WIPE'
  | 'MESSAGE'
  | 'PUSH_FILE'
  | 'RUN_SCRIPT'
  | 'SET_KIOSK';

export interface CommandDef {
  label: string;
  /** Najniža razina prava na modulu mdm. */
  level: Exclude<Level, 'none'>;
  /** Samo korisnici vlasnika sustava (ne distributeri ni klijenti). */
  ownerOnly?: boolean;
  /** Traži potvrdu u sučelju. */
  confirm?: string;
  platforms: Platform[];
  /** Koliko dugo naredba čeka uređaj prije isteka (sati). */
  ttlHours: number;
}

export const COMMANDS: Record<CommandType, CommandDef> = {
  REBOOT: { label: 'Ponovno pokretanje', level: 'ops', confirm: 'Uređaj će se ponovno pokrenuti.', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 },
  FORGET: { label: 'Odjava uređaja (Forget)', level: 'edit', confirm: 'Uređaj se odjavljuje iz sustava i agent prestaje primati naredbe.', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 * 7 },
  APPLY_CONFIG: { label: 'Primijeni konfiguraciju', level: 'edit', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 * 30 },
  INSTALL_APP: { label: 'Instaliraj aplikaciju', level: 'edit', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 * 7 },
  UNINSTALL_APP: { label: 'Ukloni aplikaciju', level: 'edit', confirm: 'Aplikacija će biti uklonjena s uređaja.', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 * 7 },
  SCREENSHOT: { label: 'Snimka zaslona', level: 'ops', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 1 },
  UPLOAD_LOGS: { label: 'Preuzmi zapisnike', level: 'ops', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 },
  LOCK: { label: 'Zaključaj zaslon', level: 'ops', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 1 },
  WIPE: { label: 'Vraćanje na tvorničke postavke', level: 'edit', ownerOnly: true, confirm: 'SVI podaci na uređaju bit će obrisani. Ovo se ne može poništiti.', platforms: ['ANDROID'], ttlHours: 24 },
  MESSAGE: { label: 'Poruka na zaslon', level: 'ops', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 },
  PUSH_FILE: { label: 'Pošalji datoteku', level: 'edit', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 * 7 },
  RUN_SCRIPT: { label: 'Pokreni skriptu', level: 'edit', ownerOnly: true, confirm: 'Skripta se izvršava s administratorskim pravima na uređaju.', platforms: ['WINDOWS'], ttlHours: 24 },
  SET_KIOSK: { label: 'Zaključani način (kiosk)', level: 'edit', platforms: ['ANDROID', 'WINDOWS'], ttlHours: 24 * 7 },
};

export const COMMAND_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Čeka uređaj',
  SENT: 'Poslano',
  SUCCEEDED: 'Izvršeno',
  FAILED: 'Neuspjelo',
  CANCELLED: 'Otkazano',
  EXPIRED: 'Isteklo',
};

const RANK: Record<Level, number> = { none: 0, view: 1, ops: 2, edit: 3 };

/** Smije li korisnik poslati naredbu na uređaj te platforme. */
export function canSendCommand(type: CommandType, platform: Platform, level: Level, isOwnerUser: boolean): boolean {
  const d = COMMANDS[type];
  if (!d || !d.platforms.includes(platform)) return false;
  if (d.ownerOnly && !isOwnerUser) return false;
  return RANK[level] >= RANK[d.level];
}

// ---------------------------------------------------------------- stanje uređaja

/** Agent se javlja svakih CHECKIN_SEC sekundi; uređaj je online dok kasni manje od dva intervala. */
export const CHECKIN_SEC = 60;
export const ONLINE_GRACE_SEC = CHECKIN_SEC * 2 + 30;

export function isOnline(lastSeenAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - new Date(lastSeenAt).getTime() <= ONLINE_GRACE_SEC * 1000;
}

export type AlertKind = 'OFFLINE' | 'BATTERY' | 'STORAGE' | 'CONFIG';

export interface DeviceAlertInput {
  status: 'PENDING' | 'ENROLLED' | 'RETIRED';
  lastSeenAt: Date | string | null;
  batteryLevel: number | null;
  charging: boolean | null;
  storageFreeMb: number | null;
  storageTotalMb: number | null;
  configVersion: number;
  appliedConfigVersion: number;
}

export const ALERT_LABEL: Record<AlertKind, string> = {
  OFFLINE: 'Nije dostupan',
  BATTERY: 'Slaba baterija',
  STORAGE: 'Malo prostora',
  CONFIG: 'Konfiguracija nije primijenjena',
};

/** Upozorenja uređaja; pragovi: offline > 30 min, baterija < 15 % (bez punjenja), prostor < 10 %. */
export function deviceAlerts(d: DeviceAlertInput, now: Date = new Date()): AlertKind[] {
  if (d.status !== 'ENROLLED') return [];
  const out: AlertKind[] = [];
  if (!d.lastSeenAt || now.getTime() - new Date(d.lastSeenAt).getTime() > 30 * 60_000) out.push('OFFLINE');
  if (d.batteryLevel !== null && d.batteryLevel < 15 && !d.charging) out.push('BATTERY');
  if (d.storageFreeMb !== null && d.storageTotalMb && d.storageFreeMb / d.storageTotalMb < 0.1) out.push('STORAGE');
  if (d.configVersion > d.appliedConfigVersion && d.lastSeenAt && now.getTime() - new Date(d.lastSeenAt).getTime() < 30 * 60_000) out.push('CONFIG');
  return out;
}

// ---------------------------------------------------------------- upis (enrollment)

/** Šesteroznamenkasti kod za upis (bez vodeće nule radi čitljivosti). `random` vraća [0, 1). */
export function enrollCode(random: () => number): string {
  return String(100000 + Math.floor(random() * 900000));
}

export const isEnrollCode = (s: string) => /^\d{6}$/.test(s.trim());

// ---------------------------------------------------------------- konfiguracija

export interface Restrictions {
  /** Zabrana instalacije i uklanjanja aplikacija od strane korisnika. */
  noInstallApps?: boolean;
  /** Zabrana promjene postavki (Wi-Fi, datum, …). */
  noSettings?: boolean;
  noPlayStore?: boolean;
  noUsbFileTransfer?: boolean;
  noFactoryReset?: boolean;
  noCamera?: boolean;
  noStatusBar?: boolean;
}

export interface WifiNetwork {
  ssid: string;
  security: 'NONE' | 'WPA2' | 'WPA3';
  password?: string;
  hidden?: boolean;
}

export interface ProfileSettings {
  /** Zaključani način — kao „Orderman Mode": korisnik ne mijenja uređaj. */
  kiosk?: boolean;
  /** Aplikacija koja se pokreće nakon paljenja / jedina u kiosku (paket ili appId). */
  startApp?: string | null;
  adb?: boolean;
  restrictions?: Restrictions;
  wifi?: WifiNetwork[];
  /** Servisni PIN za izlaz iz zaključanog načina na uređaju. */
  maintenancePin?: string | null;
  screenTimeoutSec?: number | null;
  timezone?: string | null;
  volumePct?: number | null;
  /** Android: sistemska ažuriranja (AUTOMATIC, WINDOWED 02–04 h, POSTPONE). Windows: ništa/obavijest. */
  systemUpdates?: 'AUTOMATIC' | 'WINDOWED' | 'POSTPONE' | null;
  /** Windows: naziv računala, lokalne poruke… */
  [key: string]: unknown;
}

export interface ProfileApp {
  appId: string;
  /** Konkretna verzija; prazno = najnovija. */
  versionId?: string | null;
  /** Postavke aplikacije (Android managed configuration / Windows registry/json). */
  config?: Record<string, string>;
  hidden?: boolean;
  autoStart?: boolean;
  /** Ukloni s uređaja (umjesto instaliraj). */
  remove?: boolean;
}

export interface DeviceOverrides {
  settings?: Partial<ProfileSettings>;
  /** Aplikacije samo za ovaj uređaj ili izmjene aplikacija iz profila (po appId). */
  apps?: ProfileApp[];
}

export interface ResolvedApp extends ProfileApp {
  packageName: string;
  name: string;
  version: string | null;
  versionCode: number | null;
  /** Relativni URL za preuzimanje (agent dodaje adresu poslužitelja). */
  downloadPath: string | null;
  sha256: string | null;
  installArgs?: string | null;
}

export interface EffectiveConfig {
  version: number;
  settings: ProfileSettings;
  apps: ResolvedApp[];
}

/**
 * Konfiguracija uređaja = profil + izmjene na uređaju. Postavke se spajaju po
 * ključu (restrikcije po ključu), aplikacije po appId (izmjena na uređaju
 * zamjenjuje stavku iz profila).
 */
export function mergeConfig(profile: { settings?: ProfileSettings; apps?: ProfileApp[] } | null, overrides: DeviceOverrides | null): {
  settings: ProfileSettings;
  apps: ProfileApp[];
} {
  const base = profile?.settings ?? {};
  const ov = overrides?.settings ?? {};
  const settings: ProfileSettings = { ...base, ...ov, restrictions: { ...(base.restrictions ?? {}), ...(ov.restrictions ?? {}) } };
  const apps = new Map<string, ProfileApp>();
  for (const a of profile?.apps ?? []) apps.set(a.appId, a);
  for (const a of overrides?.apps ?? []) apps.set(a.appId, { ...(apps.get(a.appId) ?? {}), ...a });
  return { settings, apps: [...apps.values()] };
}

/** Stabilan sažetak konfiguracije — agent primjenjuje samo kad se promijeni. */
export function configFingerprint(cfg: { settings: unknown; apps: unknown }): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  const s = JSON.stringify(stable(cfg));
  // FNV-1a 32-bit — dovoljno za otkrivanje promjene
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------- protokol agenta (v1)

export const AGENT_PROTOCOL = 1;

/** POST /api/mdm/agent/register — prvo javljanje agenta. */
export interface AgentRegisterRequest {
  protocol: number;
  platform: Platform;
  /** Ključ upisa iz QR koda / instalacije (automatski upis) — opcionalno. */
  enrollToken?: string | null;
  hardwareId: string;
  serial?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  osVersion?: string | null;
  agentVersion?: string | null;
  name?: string | null;
}

export interface AgentRegisterResponse {
  deviceId: string;
  /** Tajni ključ uređaja — šalje se u zaglavlju `Authorization: Device <token>`. */
  token: string;
  status: 'PENDING' | 'ENROLLED';
  /** Prikazati na zaslonu dok status nije ENROLLED. */
  enrollCode: string | null;
  checkinSec: number;
}

export interface AgentTelemetry {
  serial?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  osVersion?: string | null;
  agentVersion?: string | null;
  imei?: string | null;
  macAddress?: string | null;
  ipAddress?: string | null;
  wifiSsid?: string | null;
  wifiSignal?: number | null;
  batteryLevel?: number | null;
  charging?: boolean | null;
  storageFreeMb?: number | null;
  storageTotalMb?: number | null;
  ramTotalMb?: number | null;
  uptimeSec?: number | null;
  /** Instalirane aplikacije: [{ packageName, name, version, versionCode }] */
  apps?: Array<{ packageName: string; name?: string; version?: string; versionCode?: number }>;
  /** Ostalo po platformi (Windows: domena, korisnik, CPU; Android: sigurnosna zakrpa…). */
  extra?: Record<string, unknown>;
}

/** POST /api/mdm/agent/checkin */
export interface AgentCheckinRequest {
  telemetry: AgentTelemetry;
  /** Verzija konfiguracije koju je agent primijenio. */
  appliedConfigVersion?: number;
  /** Zapisi agenta od prošlog javljanja (najviše 50). */
  events?: Array<{ at?: string; level?: 'info' | 'warn' | 'error'; type: string; message: string }>;
}

export interface AgentCommand {
  id: string;
  type: CommandType;
  payload: Record<string, unknown>;
}

export interface AgentCheckinResponse {
  status: 'PENDING' | 'ENROLLED' | 'RETIRED';
  enrollCode: string | null;
  deviceName: string;
  checkinSec: number;
  /** Nova konfiguracija kad se razlikuje od primijenjene. */
  config: EffectiveConfig | null;
  commands: AgentCommand[];
}

/** POST /api/mdm/agent/commands/:id — rezultat naredbe. */
export interface AgentCommandResult {
  ok: boolean;
  error?: string | null;
  result?: Record<string, unknown> | null;
}
