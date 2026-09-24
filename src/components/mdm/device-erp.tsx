import Link from 'next/link';
import { Link2, Unlink } from 'lucide-react';
import type { erpMatches } from '@/server/queries/mdm';
import { STATE_LABEL } from '@/domain/warehouse';
import { CONTRACT_STATUS_LABEL, type ContractStatusCode } from '@/domain/billing';
import { warrantyEnd } from '@/domain/pricing';
import { Badge, Card, COLOR_TONE, Detail } from '@/components/ui/misc';
import { ActionButton } from '@/components/ui/action';
import { date } from '@/lib/format';
import { linkItemAction } from '@/app/(app)/mdm/uredaji/actions';

type Match = Awaited<ReturnType<typeof erpMatches>>[number];

/**
 * Veza MDM uređaja s uređajem u ERP skladištu (po serijskom broju) — vidi je
 * samo vlasnik sustava: status, klijent, ugovor, jamstvo.
 */
export function DeviceErpCard({ deviceId, serial, itemId, matches, canEdit }: { deviceId: string; serial: string | null; itemId: string | null; matches: Match[]; canEdit: boolean }) {
  const linked = matches.find((m) => m.id === itemId) ?? null;
  const candidates = matches.filter((m) => m.id !== itemId);
  return (
    <Card title="ERP — skladište">
      {linked ? (
        <ItemDetails item={linked} />
      ) : (
        <p className="text-sm text-fg-3">
          {serial ? (candidates.length ? `U skladištu postoji uređaj sa serijskim brojem ${serial}.` : `U skladištu nema uređaja sa serijskim brojem ${serial}.`) : 'Uređaj nije javio serijski broj.'}
        </p>
      )}
      {linked && canEdit && (
        <div className="mt-3">
          <ActionButton action={linkItemAction} input={{ id: deviceId, itemId: null }} size="sm" variant="ghost" icon={<Unlink className="size-4" />} confirm="Ukloniti vezu s uređajem u skladištu?">
            Ukloni vezu
          </ActionButton>
        </div>
      )}
      {candidates.map((m) => (
        <div key={m.id} className="mt-3 rounded-md border border-line p-3">
          <ItemDetails item={m} />
          {canEdit && (
            <div className="mt-2">
              <ActionButton action={linkItemAction} input={{ id: deviceId, itemId: m.id }} size="sm" variant="subtle" icon={<Link2 className="size-4" />}>
                Poveži s uređajem u skladištu
              </ActionButton>
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

function ItemDetails({ item }: { item: Match }) {
  const start = item.warrantyStart;
  const wEnd = warrantyEnd(start ? start.toISOString().slice(0, 10) : null, item.warrantyMonthsEff);
  const contract = item.contractItem?.contract;
  return (
    <dl>
      <Detail label="Serijski">
        <Link prefetch={false} href={`/skladiste/${item.id}`} className="link font-mono text-sm">
          {item.serial}
        </Link>
        {item.dupNote && <span className="ml-1 text-xs text-warn">({item.dupNote})</span>}
      </Detail>
      <Detail label="Model">{[item.model.brand, item.model.name].filter(Boolean).join(' ')}</Detail>
      <Detail label="Status">
        <Badge tone={COLOR_TONE[item.status.color] ?? 'neutral'}>{item.status.name}</Badge>
        <span className="ml-1.5 text-xs text-fg-3">{STATE_LABEL[item.state as keyof typeof STATE_LABEL] ?? item.state}</span>
      </Detail>
      <Detail label="Klijent">
        {item.partner ? (
          <Link prefetch={false} href={`/partneri/${item.partner.id}`} className="link">
            {item.partner.name}
          </Link>
        ) : null}
      </Detail>
      <Detail label="Ugovor">
        {contract ? (
          <Link prefetch={false} href={`/najam/ugovori/${contract.id}`} className="link">
            {contract.number} · {CONTRACT_STATUS_LABEL[contract.status as ContractStatusCode] ?? contract.status}
          </Link>
        ) : null}
      </Detail>
      <Detail label="Jamstvo do">
        {wEnd ? <span className={wEnd < new Date().toISOString().slice(0, 10) ? 'text-fg-3 line-through' : ''}>{date(wEnd)}</span> : null}
      </Detail>
    </dl>
  );
}
