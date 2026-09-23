'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, FormGrid, Input, Select, Textarea, type Option } from '@/components/ui/field';
import { Notice } from '@/components/ui/misc';
import { useAction, FormError, type ServerAction } from '@/components/ui/action';
import { eur } from '@/lib/format';
import { today } from '@/domain/dates';
import { PartnerPicker } from './pickers';
import { WRITE_OFF_REASONS } from '@/domain/warehouse';
import {
  announceReturnAction, bulkEditAction, changeStatus, markOutAction, transferAction, writeOffAction,
} from '@/app/(app)/skladiste/actions';

export interface StatusOption {
  id: string;
  name: string;
  kind: string;
  color: string;
}

export interface WarehouseOptions {
  statuses: StatusOption[];
  warehouses: Option[];
  models: Option[];
}

export interface Perms {
  canEdit: boolean;
  canOps: boolean;
  needsApproval: boolean;
}

/** Sažetak odabranih uređaja potreban dijalozima (upozorenja). */
export interface SelectedMeta {
  count: number;
  onContract: number;
  cost: number;
}

interface Base {
  open: boolean;
  onClose: () => void;
  itemIds: string[];
  onDone?: () => void;
}

/** Zajednički okvir: dijalog s gumbom potvrde koji zove akciju. */
function ActionDialog<I>({
  open,
  onClose,
  onDone,
  title,
  action,
  input,
  confirmLabel,
  danger,
  disabled,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  title: string;
  action: ServerAction<I>;
  input: () => I;
  confirmLabel: string;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { run, pending, error } = useAction(action);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={pending}
            disabled={disabled}
            onClick={async () => {
              const r = await run(input());
              if (r.ok) {
                onClose();
                onDone?.();
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

export function StatusDialog({
  statuses,
  warehouses,
  perms,
  meta,
  ...base
}: Base & { statuses: StatusOption[]; warehouses: Option[]; perms: Perms; meta: SelectedMeta }) {
  const [statusId, setStatusId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [note, setNote] = useState('');
  const target = statuses.find((s) => s.id === statusId);
  const request = !perms.canEdit && perms.needsApproval;
  const detaches = target && target.kind !== 'RENTED' && target.kind !== 'RETURNING' ? meta.onContract : 0;
  return (
    <ActionDialog
      {...base}
      title={request ? 'Zahtjev za promjenu statusa' : 'Promjena statusa'}
      action={changeStatus}
      input={() => ({ itemIds: base.itemIds, statusId, note, warehouseId })}
      confirmLabel={request ? 'Pošalji na odobrenje' : 'Promijeni status'}
      disabled={!statusId}
    >
      <p className="text-sm text-fg-3">Odabrano uređaja: {meta.count}</p>
      {request && <Notice tone="info">Promjena statusa ide administratoru na odobrenje. Status se mijenja tek kad je zahtjev odobren.</Notice>}
      <Field label="Novi status" required>
        <Select value={statusId} onChange={(e) => setStatusId(e.target.value)} placeholder="Odaberite status…" options={statuses.map((s) => ({ value: s.id, label: s.name }))} />
      </Field>
      {target?.kind === 'IN_STOCK' && (
        <Field label="Skladište" hint="Prazno = uređaji ostaju u skladištu u kojem jesu.">
          <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} placeholder="— bez promjene —" options={warehouses} />
        </Field>
      )}
      <Field label="Napomena">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Razlog promjene (neobavezno)" />
      </Field>
      {detaches > 0 && (
        <Notice tone="warn">
          {detaches} od odabranih uređaja {detaches === 1 ? 'je' : 'su'} na ugovoru o najmu. Promjenom statusa u „{target!.name}" bit će skinuti s ugovora.
        </Notice>
      )}
      {target?.kind === 'SERVICE' && <Notice tone="info">Za uređaje bez otvorenog servisnog naloga automatski se otvara nalog.</Notice>}
    </ActionDialog>
  );
}

export function MarkOutDialog({ count, ...base }: Base & { count: number }) {
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  return (
    <ActionDialog {...base} title="Izašlo iz skladišta" action={markOutAction} input={() => ({ itemIds: base.itemIds, partnerId, note })} confirmLabel="Označi izlaz">
      <p className="text-sm text-fg-3">
        Uređaji ({count}) dobivaju status „Izašlo iz skladišta" i čekaju da prodaja izda račun ili ih doda na ugovor. Sa stanja se skidaju tek tada.
      </p>
      <Field label="Za koga (neobavezno)">
        <PartnerPicker value={partnerId} onChange={setPartnerId} role="customer" />
      </Field>
      <Field label="Napomena">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="npr. preuzeo kurir, montaža na lokaciji…" />
      </Field>
    </ActionDialog>
  );
}

export function TransferDialog({ warehouses, count, ...base }: Base & { warehouses: Option[]; count: number }) {
  const [to, setTo] = useState('');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  return (
    <ActionDialog
      {...base}
      title="Premještaj u drugo skladište"
      action={transferAction}
      input={() => ({ itemIds: base.itemIds, toWarehouseId: to, date, note })}
      confirmLabel="Premjesti"
      disabled={!to}
    >
      <p className="text-sm text-fg-3">Za {count} uređaja nastaje međuskladišnica (po jedna za svako izvorno skladište).</p>
      <FormGrid>
        <Field label="Odredišno skladište" required>
          <Select value={to} onChange={(e) => setTo(e.target.value)} placeholder="Odaberite…" options={warehouses} />
        </Field>
        <Field label="Datum">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </FormGrid>
      <Field label="Napomena">
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ActionDialog>
  );
}

export function WriteOffDialog({ meta, ...base }: Base & { meta: SelectedMeta }) {
  const [reason, setReason] = useState(WRITE_OFF_REASONS[0]);
  const [note, setNote] = useState('');
  const [book, setBook] = useState(true);
  const [date, setDate] = useState(today());
  return (
    <ActionDialog
      {...base}
      title="Otpis uređaja"
      action={writeOffAction}
      input={() => ({ itemIds: base.itemIds, reason, note, bookExpense: book, date })}
      confirmLabel={`Otpiši (${meta.count})`}
      danger
    >
      <p className="text-sm text-fg-2">
        Uređaji dobivaju status „Otpisan", skidaju se s ugovora i gube klijenta i skladište. Ostaju u evidenciji radi povijesti.
      </p>
      <FormGrid>
        <Field label="Razlog" required>
          <Select value={reason} onChange={(e) => setReason(e.target.value)} options={WRITE_OFF_REASONS.map((r) => ({ value: r, label: r }))} />
        </Field>
        <Field label="Datum otpisa">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </FormGrid>
      <Field label="Napomena">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
      </Field>
      <Checkbox checked={book} onChange={(e) => setBook(e.target.checked)} label={<>Knjiži trošak „Otpis opreme" u iznosu nabavne vrijednosti ({eur(meta.cost)})</>} />
      {meta.onContract > 0 && <Notice tone="warn">{meta.onContract} uređaja je na ugovoru i bit će skinuto s njega.</Notice>}
    </ActionDialog>
  );
}

export function BulkEditDialog({ warehouses, models, count, ...base }: Base & { warehouses: Option[]; models: Option[]; count: number }) {
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [v, setV] = useState({ warehouseId: '', supplierId: null as string | null, cost: '', modelId: '', note: '' });
  const toggle = (k: string) => setOn((o) => ({ ...o, [k]: !o[k] }));
  const row = (k: string, label: string, control: ReactNode) => (
    <div className="grid grid-cols-[9rem_1fr] items-center gap-2">
      <Checkbox checked={!!on[k]} onChange={() => toggle(k)} label={label} />
      <div className={on[k] ? '' : 'pointer-events-none opacity-40'}>{control}</div>
    </div>
  );
  return (
    <ActionDialog
      {...base}
      title={`Grupna izmjena (${count})`}
      action={bulkEditAction}
      input={() => ({
        itemIds: base.itemIds,
        ...(on.warehouseId ? { warehouseId: v.warehouseId } : {}),
        ...(on.supplierId ? { supplierId: v.supplierId } : {}),
        ...(on.cost ? { cost: v.cost } : {}),
        ...(on.modelId ? { modelId: v.modelId } : {}),
        ...(on.note ? { note: v.note } : {}),
      })}
      confirmLabel="Spremi izmjene"
      disabled={!Object.values(on).some(Boolean)}
    >
      <p className="text-sm text-fg-3">Označite polja koja želite promijeniti na svim odabranim uređajima.</p>
      {row('warehouseId', 'Skladište', <Select value={v.warehouseId} onChange={(e) => setV({ ...v, warehouseId: e.target.value })} placeholder="Odaberite…" options={warehouses} />)}
      {row('supplierId', 'Dobavljač', <PartnerPicker value={v.supplierId} onChange={(x) => setV({ ...v, supplierId: x })} role="supplier" placeholder="— bez dobavljača —" />)}
      {row('cost', 'Nabavna cijena', <Input inputMode="decimal" value={v.cost} onChange={(e) => setV({ ...v, cost: e.target.value })} placeholder="0,00" />)}
      {row('modelId', 'Model', <Select value={v.modelId} onChange={(e) => setV({ ...v, modelId: e.target.value })} placeholder="Odaberite…" options={models} />)}
      {row('note', 'Napomena', <Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="prazno = briše napomenu" />)}
    </ActionDialog>
  );
}

export function AnnounceReturnDialog({ count, ...base }: Base & { count: number }) {
  const [note, setNote] = useState('');
  return (
    <ActionDialog {...base} title="Najava povrata" action={announceReturnAction} input={() => ({ itemIds: base.itemIds, note })} confirmLabel="Najavi povrat">
      <p className="text-sm text-fg-2">
        {count === 1 ? 'Uređaj prelazi' : `Uređaji (${count}) prelaze`} u status „U dolasku". Na ugovoru ostaju dok ih ne zaprimite na skladište.
      </p>
      <Field label="Napomena">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="npr. kraj sezone, klijent vraća…" />
      </Field>
    </ActionDialog>
  );
}
