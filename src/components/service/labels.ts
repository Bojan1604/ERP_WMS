import type { Tone } from '@/components/ui/misc';

export type ServiceStatusCode = 'REPORTED' | 'RECEIVED' | 'DIAGNOSIS' | 'AT_SUPPLIER' | 'REPAIRED' | 'REPLACED' | 'WRITTEN_OFF';

export const SERVICE_STATUS: Record<ServiceStatusCode, { label: string; tone: Tone }> = {
  REPORTED: { label: 'Prijavljeno', tone: 'neutral' },
  RECEIVED: { label: 'Zaprimljeno', tone: 'info' },
  DIAGNOSIS: { label: 'U dijagnostici', tone: 'warn' },
  AT_SUPPLIER: { label: 'Kod dobavljača', tone: 'brand' },
  REPAIRED: { label: 'Popravljeno', tone: 'ok' },
  REPLACED: { label: 'Zamijenjeno', tone: 'ok' },
  WRITTEN_OFF: { label: 'Otpisano', tone: 'bad' },
};

export const OPEN_SERVICE_STATUSES: ServiceStatusCode[] = ['REPORTED', 'RECEIVED', 'DIAGNOSIS', 'AT_SUPPLIER'];
export const CLOSED_SERVICE_STATUSES: ServiceStatusCode[] = ['REPAIRED', 'REPLACED', 'WRITTEN_OFF'];
export const isOpenService = (s: string) => (OPEN_SERVICE_STATUSES as string[]).includes(s);

/** Zapis u tijeku naloga. `prev` = stanje uređaja prije servisa (za povrat). */
export interface TimelineEntry {
  at: string;
  status: ServiceStatusCode;
  by: string;
  note?: string | null;
  prev?: PrevSnapshot;
}

export interface PrevSnapshot {
  state: string;
  partnerId: string | null;
  warehouseId: string | null;
  contract?: { contractId: string; monthly: number; plan: unknown; skipped: string[]; status: string | null } | null;
}

/** Nalog se smatra „dugim" nakon ovoliko dana. */
export const LONG_SERVICE_DAYS = 14;
