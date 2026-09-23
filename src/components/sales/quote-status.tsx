import { Badge, type Tone } from '@/components/ui/misc';
import { today } from '@/domain/dates';

export const QUOTE_LABEL: Record<string, string> = {
  DRAFT: 'Nacrt',
  SENT: 'Poslana',
  ACCEPTED: 'Prihvaćena',
  REJECTED: 'Odbijena',
  EXPIRED: 'Istekla',
};
const TONE: Record<string, Tone> = { DRAFT: 'neutral', SENT: 'info', ACCEPTED: 'ok', REJECTED: 'bad', EXPIRED: 'warn' };

/** Nacrt ili poslana ponuda kojoj je prošao rok prikazuje se kao istekla. */
export function quoteStatus(status: string, validUntil: string | null | undefined, now = today()): string {
  return (status === 'DRAFT' || status === 'SENT') && validUntil && validUntil < now ? 'EXPIRED' : status;
}

export function QuoteBadge({ status }: { status: string }) {
  return <Badge tone={TONE[status] ?? 'neutral'}>{QUOTE_LABEL[status] ?? status}</Badge>;
}
