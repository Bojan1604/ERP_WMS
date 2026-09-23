'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select, Textarea } from '@/components/ui/field';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Card, Detail, Notice } from '@/components/ui/misc';
import { formatDate } from '@/domain/dates';
import { DevicePicker, type DeviceSearch } from './device-picker';

export interface DeviceInfo {
  id: string;
  serial: string;
  model: string;
  state: string;
  status: string;
  partner: string | null;
  contract: string | null;
  warrantyEnd: string | null;
  underWarranty: boolean;
  openOrder: { id: string; number: string } | null;
}

interface CreateInput {
  itemId: string;
  issue: string;
  reportedAt: string;
  status: 'REPORTED' | 'RECEIVED';
  underWarranty: boolean;
  note: string | null;
  setServiceStatus: boolean;
}

export function NewServiceForm({
  search,
  info,
  action,
  today,
  initial,
}: {
  search: DeviceSearch;
  info: ServerAction<{ id: string }, DeviceInfo | null>;
  action: ServerAction<CreateInput>;
  today: string;
  initial: DeviceInfo | null;
}) {
  const [device, setDevice] = useState<DeviceInfo | null>(initial);
  const [itemId, setItemId] = useState<string | null>(initial?.id ?? null);
  const [issue, setIssue] = useState('');
  const [reportedAt, setReportedAt] = useState(today);
  const [status, setStatus] = useState<'REPORTED' | 'RECEIVED'>('RECEIVED');
  const [warranty, setWarranty] = useState(initial?.underWarranty ?? false);
  const [note, setNote] = useState('');
  const [setService, setSetService] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const create = useAction(action);
  const load = useAction(info, { refresh: false });

  useEffect(() => {
    if (!itemId || itemId === device?.id) return;
    load.run({ id: itemId }).then((r) => {
      if (r.ok && r.data) {
        setDevice(r.data);
        setWarranty(r.data.underWarranty);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const submit = () => {
    if (!itemId) return setLocalError('Odaberite uređaj.');
    if (!issue.trim()) return setLocalError('Upišite opis kvara.');
    setLocalError(null);
    create.run({ itemId, issue, reportedAt, status, underWarranty: warranty, note: note || null, setServiceStatus: setService });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Card title="Prijava kvara">
        <FormGrid cols={2}>
          <Field label="Uređaj" required className="sm:col-span-2">
            <DevicePicker
              search={search}
              value={itemId}
              initial={initial ? { value: initial.id, label: `${initial.serial} — ${initial.model}` } : null}
              onChange={(id) => setItemId(id)}
            />
          </Field>
          <Field label="Opis kvara" required className="sm:col-span-2">
            <Textarea rows={4} value={issue} onChange={(e) => setIssue(e.target.value)} placeholder="Što klijent prijavljuje…" />
          </Field>
          <Field label="Datum prijave" required>
            <Input type="date" value={reportedAt} onChange={(e) => setReportedAt(e.target.value)} />
          </Field>
          <Field label="Početni status">
            <Select
              value={status}
              onChange={(e) => setStatus(e.target.value as 'REPORTED' | 'RECEIVED')}
              options={[
                { value: 'RECEIVED', label: 'Zaprimljeno (uređaj je kod nas)' },
                { value: 'REPORTED', label: 'Prijavljeno (uređaj još nije stigao)' },
              ]}
            />
          </Field>
          <Field label="Interna napomena" className="sm:col-span-2">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </FormGrid>
        <div className="mt-3 flex flex-col gap-2">
          <Checkbox label="U jamstvu" checked={warranty} onChange={(e) => setWarranty(e.target.checked)} />
          <Checkbox
            label="Uređaju postavi status servisa (Pokvaren / Na servisu)"
            checked={setService}
            onChange={(e) => setSetService(e.target.checked)}
            disabled={device?.state === 'SERVICE'}
          />
          {setService && device?.contract && (
            <p className="text-xs text-warn">
              Uređaj je na ugovoru {device.contract}. Status servisa skida ga s ugovora; nakon popravka „Vrati uređaj" ga vraća na isti ugovor, a zamjenski
              uređaj preuzima njegovo mjesto.
            </p>
          )}
        </div>
      </Card>

      <div className="space-y-3">
        <Card title="Uređaj">
          {device ? (
            <dl>
              <Detail label="Serijski broj">
                <Link prefetch={false} href={`/skladiste/${device.id}`} className="link font-mono">
                  {device.serial}
                </Link>
              </Detail>
              <Detail label="Model">{device.model}</Detail>
              <Detail label="Status">{device.status}</Detail>
              <Detail label="Klijent">{device.partner ?? '—'}</Detail>
              {device.contract && <Detail label="Ugovor">{device.contract}</Detail>}
              <Detail label="Jamstvo do">
                {device.warrantyEnd ? <span className={device.underWarranty ? 'text-ok' : 'text-bad-strong'}>{formatDate(device.warrantyEnd)}</span> : '—'}
              </Detail>
            </dl>
          ) : (
            <p className="text-sm text-fg-3">{load.pending ? 'Učitavam…' : 'Odaberite uređaj pretragom po serijskom broju.'}</p>
          )}
        </Card>
        {device?.openOrder && (
          <Notice tone="bad">
            Uređaj već ima otvoren nalog{' '}
            <Link prefetch={false} href={`/servis/${device.openOrder.id}`} className="font-semibold underline">
              {device.openOrder.number}
            </Link>
            .
          </Notice>
        )}
      </div>

      <div className="lg:col-span-2">
        <FormError error={localError ?? create.error} />
        <div className="mt-2 flex justify-end gap-2">
          <LinkButton href="/servis">Odustani</LinkButton>
          <Button variant="primary" loading={create.pending} onClick={submit} disabled={!!device?.openOrder}>
            Otvori nalog
          </Button>
        </div>
      </div>
    </div>
  );
}
