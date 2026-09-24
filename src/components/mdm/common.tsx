import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Monitor, Smartphone } from 'lucide-react';
import { ALERT_LABEL, isOnline, PLATFORM_LABEL, type AlertKind, type Platform } from '@/domain/mdm';
import { Badge, type Tone } from '@/components/ui/misc';
import { dateTime } from '@/lib/format';
import { cn } from '@/lib/cn';

/**
 * Zajednički mali prikazi MDM-a (bez stanja, rade i u server i u klijentskim
 * komponentama): platforma, online, status upisa, baterija, „prije 2 min".
 */

export const DEVICE_STATUS_LABEL: Record<string, string> = { PENDING: 'Čeka upis', ENROLLED: 'Upisan', RETIRED: 'Odjavljen' };
const DEVICE_STATUS_TONE: Record<string, Tone> = { PENDING: 'warn', ENROLLED: 'ok', RETIRED: 'neutral' };

export const ORG_TYPE_LABEL: Record<string, string> = { DISTRIBUTOR: 'Distributer', CUSTOMER: 'Klijent' };

export const COMMAND_STATUS_TONE: Record<string, Tone> = {
  PENDING: 'warn',
  SENT: 'info',
  SUCCEEDED: 'ok',
  FAILED: 'bad',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};

export const EVENT_LEVEL_TONE: Record<string, Tone> = { info: 'info', warn: 'warn', error: 'bad' };

export function PlatformIcon({ platform, className }: { platform: Platform | string; className?: string }) {
  const Icon = platform === 'WINDOWS' ? Monitor : Smartphone;
  return (
    <span title={PLATFORM_LABEL[platform as Platform] ?? platform} className="inline-flex">
      <Icon className={cn('size-4 text-fg-3', className)} aria-label={PLATFORM_LABEL[platform as Platform] ?? platform} />
    </span>
  );
}

export function DeviceStatusBadge({ status }: { status: string }) {
  return <Badge tone={DEVICE_STATUS_TONE[status] ?? 'neutral'}>{DEVICE_STATUS_LABEL[status] ?? status}</Badge>;
}

/** Online/offline prema zadnjem javljanju (isti prag kao u SQL filtru). */
export function OnlineBadge({ lastSeenAt, status, now }: { lastSeenAt: string | Date | null; status?: string; now?: Date }) {
  if (status && status !== 'ENROLLED') return <span className="text-fg-4">—</span>;
  const on = isOnline(lastSeenAt, now);
  return (
    <Badge tone={on ? 'ok' : 'bad'}>
      <span className={cn('size-1.5 rounded-full', on ? 'bg-ok' : 'bg-bad-strong')} />
      {on ? 'online' : 'offline'}
    </Badge>
  );
}

/** „prije 2 min" — relativno vrijeme; starije od tjedan dana kao datum. */
export function ago(d: string | Date | null | undefined, now: Date = new Date()): string {
  if (!d) return 'nikad';
  const s = Math.round((now.getTime() - new Date(d).getTime()) / 1000);
  if (s < 0) return 'upravo';
  if (s < 45) return 'upravo';
  const m = Math.round(s / 60);
  if (m < 60) return `prije ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `prije ${h} h`;
  const days = Math.round(h / 24);
  if (days <= 7) return `prije ${days} d`;
  return dateTime(d);
}

export function Ago({ at, now }: { at: string | Date | null | undefined; now?: Date }) {
  return (
    <span title={at ? dateTime(at) : undefined} className="whitespace-nowrap">
      {ago(at, now)}
    </span>
  );
}

export function Battery({ level, charging }: { level: number | null; charging: boolean | null }) {
  if (level === null || level === undefined) return <span className="text-fg-4">—</span>;
  const Icon = charging ? BatteryCharging : level < 15 ? BatteryLow : level < 60 ? BatteryMedium : BatteryFull;
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap tnum', level < 15 && !charging && 'text-bad-strong')} title={charging ? 'Puni se' : undefined}>
      <Icon className="size-4" />
      {level} %
    </span>
  );
}

export function mb(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v >= 1024) return `${(v / 1024).toLocaleString('hr-HR', { maximumFractionDigits: 1 })} GB`;
  return `${v} MB`;
}

export function bytes(v: number): string {
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toLocaleString('hr-HR', { maximumFractionDigits: 1 })} MB`;
  if (v >= 1024) return `${Math.round(v / 1024)} kB`;
  return `${v} B`;
}

export function uptime(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

export function AlertBadges({ alerts }: { alerts: AlertKind[] }) {
  if (!alerts.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {alerts.map((a) => (
        <Badge key={a} tone={a === 'CONFIG' ? 'info' : a === 'OFFLINE' ? 'bad' : 'warn'}>
          {ALERT_LABEL[a]}
        </Badge>
      ))}
    </span>
  );
}

/** „Distributer › Klijent" ili samo naziv organizacije. */
export function orgPath(org: { name: string; parent?: { name: string } | null } | null | undefined): string {
  if (!org) return '—';
  return org.parent ? `${org.parent.name} › ${org.name}` : org.name;
}

/** Vrijednosti obrasca organizacije (dijeli se između poslužitelja i klijentskog obrasca). */
export interface OrgValue {
  id?: string;
  type: 'DISTRIBUTOR' | 'CUSTOMER';
  parentId: string | null;
  name: string;
  oib: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  note: string;
  active: boolean;
  partnerId: string | null;
}

export const emptyOrg = (type: 'DISTRIBUTOR' | 'CUSTOMER', parentId: string | null): OrgValue => ({
  type, parentId, name: '', oib: '', email: '', phone: '', address: '', city: '', note: '', active: true, partnerId: null,
});
