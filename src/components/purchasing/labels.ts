import type { Tone } from '@/components/ui/misc';

export type OrderStatusCode = 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED';

export const ORDER_STATUS: Record<OrderStatusCode, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Nacrt', tone: 'neutral' },
  ORDERED: { label: 'Naručeno', tone: 'info' },
  PARTIAL: { label: 'Djelomično zaprimljeno', tone: 'warn' },
  RECEIVED: { label: 'Zaprimljeno', tone: 'ok' },
  CANCELLED: { label: 'Otkazano', tone: 'bad' },
};

export const RECEIPT_STATUS: Record<'POSTED' | 'CANCELLED', { label: string; tone: Tone }> = {
  POSTED: { label: 'Proknjižena', tone: 'ok' },
  CANCELLED: { label: 'Stornirana', tone: 'bad' },
};

/** Serijski brojevi iz zalijepljenog teksta: jedan po retku (ili odvojeni zarezom / tabom). */
export function parseSerials(text: string): string[] {
  return text
    .split(/[\r\n,;\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
