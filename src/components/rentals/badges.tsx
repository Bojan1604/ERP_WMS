import { Badge, COLOR_TONE, type Tone } from '@/components/ui/misc';
import { BILLING_LABEL, CONTRACT_STATUS_LABEL, type BillingCode, type BillingModeCode, type ContractStatusCode } from '@/domain/billing';

const STATUS_TONE: Record<ContractStatusCode, Tone> = { ACTIVE: 'ok', PAUSED: 'warn', EXPIRED: 'neutral', TERMINATED: 'bad' };

export function ContractStatusBadge({ status }: { status: ContractStatusCode }) {
  return <Badge tone={STATUS_TONE[status]}>{CONTRACT_STATUS_LABEL[status]}</Badge>;
}

export function ItemStatusBadge({ name, color }: { name: string; color: string }) {
  return <Badge tone={COLOR_TONE[color] ?? 'neutral'}>{name}</Badge>;
}

export const MODE_SHORT: Record<BillingModeCode, string> = { IN_ADVANCE: 'unaprijed', IN_ARREARS: 'unatrag' };

export function billingText(billing: BillingCode, mode: BillingModeCode) {
  return `${BILLING_LABEL[billing]} · ${MODE_SHORT[mode]}`;
}
