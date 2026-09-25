/**
 * Oznake „dodatnih podataka" koje agent šalje u `telemetry.extra` (ključevi po platformi —
 * Android: sdk, securityPatch, kiosk…; Windows: domain, user, cpu…). Nepoznati ključ ostaje kakav jest.
 */
const LABELS: Record<string, string> = {
  sdk: 'Android API razina (SDK)',
  securityPatch: 'Sigurnosna zakrpa',
  kiosk: 'Zaključani način (kiosk)',
  kioskPackage: 'Aplikacija u kiosku',
  deviceOwner: 'Upravitelj uređaja (Device Owner)',
  brand: 'Marka',
  device: 'Kodni naziv uređaja',
  product: 'Proizvod',
  fingerprint: 'Oznaka firmvera',
  ramAvailMb: 'Slobodna RAM memorija',
  ramFreeMb: 'Slobodna RAM memorija',
  domain: 'Domena',
  user: 'Prijavljeni korisnik',
  cpu: 'Procesor',
  defender: 'Windows Defender',
  computerName: 'Naziv računala',
  hardwareUuid: 'UUID hardvera',
  osBuild: 'Izdanje OS-a (build)',
};

const VALUES: Record<string, Record<string, string>> = {
  defender: { 'up-to-date': 'ažuran', outdated: 'zastario', disabled: 'isključen' },
};

export function extraLabel(key: string): string {
  return LABELS[key] ?? key;
}

export function extraValue(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'da' : 'ne';
  if (typeof v === 'number' && /Mb$/.test(key)) return `${new Intl.NumberFormat('hr-HR').format(v)} MB`;
  const s = String(v);
  return VALUES[key]?.[s] ?? s;
}
