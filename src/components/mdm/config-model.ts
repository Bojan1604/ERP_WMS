/**
 * Oblik konfiguracije u uređivaču (profil i izmjene uređaja) — dijeli se između
 * poslužitelja (priprema podataka) i klijentskih komponenti. Lozinke Wi-Fi mreža
 * nikad ne dolaze u preglednik: `hasPassword` + prazno polje `password`.
 */
import type { Platform, ProfileApp, ProfileSettings, Restrictions } from '@/domain/mdm';

export type Security = 'NONE' | 'WPA2' | 'WPA3';

export interface EditorWifi {
  ssid: string;
  security: Security;
  hidden: boolean;
  /** Na poslužitelju postoji spremljena lozinka. */
  hasPassword: boolean;
  /** SSID pod kojim je mreža spremljena (za preuzimanje lozinke pri promjeni naziva). */
  origSsid: string | null;
  /** Nova lozinka; prazno = zadrži spremljenu. */
  password: string;
}

export interface EditorSettings {
  kiosk: boolean;
  adb: boolean;
  restrictions: Restrictions;
  wifi: EditorWifi[];
  maintenancePin: string;
  screenTimeoutSec: string;
  volumePct: string;
  timezone: string;
  systemUpdates: '' | 'AUTOMATIC' | 'WINDOWED' | 'POSTPONE';
}

export interface EditorApp {
  appId: string;
  versionId: string | null;
  config: Record<string, string>;
  hidden: boolean;
  autoStart: boolean;
  remove: boolean;
}

export interface EditorConfig {
  settings: EditorSettings;
  apps: EditorApp[];
}

export interface LibraryApp {
  id: string;
  name: string;
  packageName: string;
  platform: Platform;
  shared: boolean;
  versions: { id: string; version: string; versionCode: number | null; createdAt: string }[];
}

export const RESTRICTIONS: { key: keyof Restrictions; label: string; hint: string; androidOnly?: boolean }[] = [
  { key: 'noInstallApps', label: 'Zabrana instalacije i uklanjanja aplikacija', hint: 'Korisnik ne može sam instalirati ni ukloniti aplikacije.' },
  { key: 'noSettings', label: 'Zabrana promjene postavki', hint: 'Wi-Fi, datum i vrijeme, zaslon… mijenjaju se samo kroz konfiguraciju.' },
  { key: 'noPlayStore', label: 'Bez Google Play trgovine', hint: 'Play Store je skriven i onemogućen.', androidOnly: true },
  { key: 'noUsbFileTransfer', label: 'Bez prijenosa datoteka USB kabelom', hint: 'Spajanje na računalo služi samo za punjenje.' },
  { key: 'noFactoryReset', label: 'Zabrana vraćanja na tvorničke postavke', hint: 'Samo naredbom iz sustava (vlasnik).', androidOnly: true },
  { key: 'noCamera', label: 'Kamera onemogućena', hint: 'Skeneri koji koriste kameru neće raditi.' },
  { key: 'noStatusBar', label: 'Skrivena traka obavijesti', hint: 'Nema povlačenja obavijesti ni brzih postavki.', androidOnly: true },
];

export const KIOSK_BLOCKS = [
  'instalacija i uklanjanje aplikacija',
  'promjena postavki (npr. Wi-Fi mreže, datum i vrijeme)',
  'pristup Google Play trgovini',
  'prijenos datoteka USB kabelom',
];

export const UPDATE_POLICY_LABEL: Record<string, string> = {
  AUTOMATIC: 'Automatski (odmah)',
  WINDOWED: 'U razdoblju održavanja 02–04 h',
  POSTPONE: 'Odgodi (do 30 dana)',
};

/** Konfiguracija iz baze → uređivač (lozinke već uklonjene na poslužitelju). */
export function toEditor(settings: ProfileSettings, apps: ProfileApp[], masked: EditorWifi[]): EditorConfig {
  const s = settings;
  const n = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return {
    settings: {
      kiosk: !!s.kiosk,
      adb: !!s.adb,
      restrictions: { ...(s.restrictions ?? {}) },
      wifi: masked,
      maintenancePin: n(s.maintenancePin),
      screenTimeoutSec: n(s.screenTimeoutSec),
      volumePct: n(s.volumePct),
      timezone: n(s.timezone),
      systemUpdates: (s.systemUpdates ?? '') as EditorSettings['systemUpdates'],
    },
    apps: apps.map((a) => ({
      appId: a.appId,
      versionId: a.versionId ?? null,
      config: { ...(a.config ?? {}) },
      hidden: !!a.hidden,
      autoStart: !!a.autoStart,
      remove: !!a.remove,
    })),
  };
}

/** Uređivač → ulaz server akcije. */
export function fromEditor(v: EditorConfig) {
  return {
    settings: {
      ...v.settings,
      wifi: v.settings.wifi.map((w) => ({ ssid: w.ssid, security: w.security, hidden: w.hidden, password: w.password, origSsid: w.origSsid })),
    },
    apps: v.apps,
  };
}

/** JSON pregled onoga što agent dobiva (lozinke skrivene). */
export function previewJson(v: EditorConfig, library: LibraryApp[]) {
  const s = v.settings;
  const byId = new Map(library.map((a) => [a.id, a]));
  const num = (x: string) => (x.trim() === '' ? undefined : Number(x));
  const start = v.apps.find((a) => a.autoStart && !a.remove);
  const settings: Record<string, unknown> = {
    kiosk: s.kiosk || undefined,
    adb: s.adb || undefined,
    restrictions: Object.fromEntries(Object.entries(s.restrictions).filter(([, x]) => x)),
    startApp: start ? (byId.get(start.appId)?.packageName ?? start.appId) : undefined,
    wifi: s.wifi.length ? s.wifi.map((w) => ({ ssid: w.ssid, security: w.security, hidden: w.hidden || undefined, password: w.security === 'NONE' ? undefined : w.password || w.hasPassword ? '••••' : '(nedostaje)' })) : undefined,
    maintenancePin: s.maintenancePin || undefined,
    screenTimeoutSec: num(s.screenTimeoutSec),
    volumePct: num(s.volumePct),
    timezone: s.timezone || undefined,
    systemUpdates: s.systemUpdates || undefined,
  };
  const apps = v.apps.map((a) => {
    const lib = byId.get(a.appId);
    const ver = a.versionId ? lib?.versions.find((x) => x.id === a.versionId) : lib?.versions[0];
    return {
      packageName: lib?.packageName ?? a.appId,
      name: lib?.name,
      version: ver?.version ?? null,
      ...(a.versionId ? {} : { latest: true }),
      ...(Object.keys(a.config).length ? { config: a.config } : {}),
      ...(a.hidden ? { hidden: true } : {}),
      ...(a.autoStart ? { autoStart: true } : {}),
      ...(a.remove ? { remove: true } : {}),
    };
  });
  return JSON.stringify({ settings, apps }, null, 2);
}
