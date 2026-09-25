'use client';

import { useMemo, useState } from 'react';
import { PackageCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Checkbox, Field, FormGrid, Input, Select, type Option } from '@/components/ui/field';
import { Badge, Card, Notice } from '@/components/ui/misc';
import { FormError, useAction } from '@/components/ui/action';
import { parseNumber, r2 } from '@/domain/money';
import { today } from '@/domain/dates';
import { cn } from '@/lib/cn';
import { eur, integer } from '@/lib/format';
import { PartnerPicker } from './pickers';
import { AttachmentGallery } from './attachments';
import { RejectButton } from './approval-buttons';
import { BookExpenseToggle, SupplierVatBadge, useReceiveHints } from './receive-extras';
import { approveReceiveRowsAction } from '@/app/(app)/skladiste/odobrenja/actions';

type Photo = { id: string; fileName: string; mime: string; size: number } | null;

interface Row {
  code: string;
  photo: Photo;
  /** Serijski je u međuvremenu zaprimljen (primka bi ga odbila). */
  exists: boolean;
}

interface Decision {
  serial: string;
  modelId: string | null;
  skip: boolean;
}

/**
 * Odobravanje zahtjeva za zaprimanje po retku: uz sliku naljepnice administrator
 * za svaki novi kod bira model (zadani za sve ili po retku), ispravlja serijski
 * broj ili redak preskače; poznate uređaje vraća na skladište ili preskače.
 */
export function ReceiveReview({
  id,
  rows,
  returning,
  general,
  models,
  warehouses,
  warehouseId: initialWarehouse,
  canSeeCost,
}: {
  id: string;
  rows: Row[];
  returning: Array<{ id: string; serial: string; status: string; partner: string | null; model: string; photo: Photo }>;
  general: Array<{ id: string; fileName: string; mime: string; size: number }>;
  models: Option[];
  warehouses: Option[];
  warehouseId: string;
  canSeeCost: boolean;
  company: { vatRate: number; country: string };
}) {
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [plan, setPlan] = useState<Record<string, Partial<Decision>>>(() => Object.fromEntries(rows.filter((r) => r.exists).map((r) => [r.code, { skip: true }])));
  const [skipBack, setSkipBack] = useState<Set<string>>(new Set());
  const [warehouseId, setWarehouseId] = useState(initialWarehouse);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [cost, setCost] = useState('');
  const [date, setDate] = useState(today());
  const [docNo, setDocNo] = useState('');
  const [book, setBook] = useState(true);
  const hints = useReceiveHints(supplierId, null);
  const { run, pending, error } = useAction(approveReceiveRowsAction);

  const decisions = useMemo(
    () =>
      rows.map((r) => {
        const p = plan[r.code] ?? {};
        return { code: r.code, serial: p.serial ?? r.code, modelId: p.modelId ?? defaultModel, skip: !!p.skip };
      }),
    [rows, plan, defaultModel],
  );
  const set = (code: string, patch: Partial<Decision>) => setPlan((v) => ({ ...v, [code]: { ...v[code], ...patch } }));
  const active = decisions.filter((d) => !d.skip);
  const back = returning.filter((r) => !skipBack.has(r.id));
  const missing = active.filter((d) => !d.modelId || !d.serial.trim());
  const unit = parseNumber(cost);
  const total = r2(unit * active.length);
  const ready = (active.length > 0 || back.length > 0) && !missing.length && !!warehouseId;

  const submit = () =>
    run({
      id,
      warehouseId,
      supplierId,
      cost: canSeeCost ? cost : 0,
      importDate: date,
      supplierDocNumber: docNo,
      note: null,
      bookExpense: book,
      rows: decisions,
      skipReturning: [...skipBack],
    });

  return (
    <div className="space-y-4">
      <Card title="Podaci zaprimanja">
        <FormGrid cols={3}>
          <Field label="Model za nove uređaje (zadano)" hint="Vrijedi za retke bez vlastitog modela">
            <Combobox options={models} value={defaultModel} onChange={setDefaultModel} placeholder="Odaberite model…" allowEmpty />
          </Field>
          <Field label="Skladište" required>
            <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={warehouses} />
          </Field>
          <Field label="Datum uvoza" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Dobavljač (novi uređaji)">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <PartnerPicker value={supplierId} onChange={setSupplierId} role="supplier" placeholder="— bez dobavljača —" />
              </div>
              <SupplierVatBadge vat={hints.vat} />
            </div>
          </Field>
          {canSeeCost && (
            <Field label="Nabavna cijena po komadu (€)">
              <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0,00" className="text-right" />
            </Field>
          )}
          <Field label="Broj dokumenta dobavljača">
            <Input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="npr. otpremnica 123/26" />
          </Field>
        </FormGrid>
        {canSeeCost && (
          <div className="mt-3">
            <BookExpenseToggle checked={book} onChange={setBook} total={total} vat={hints.vat} />
          </div>
        )}
      </Card>

      {rows.length > 0 && (
        <Card title={`Novi serijski brojevi (${rows.length})`} padded={false}>
          <p className="px-4 pt-3 text-sm text-fg-3">
            Usporedite serijski broj sa slikom naljepnice (klik = povećaj) i po potrebi ga ispravite. „Preskoči" izostavlja redak — uređaj ne nastaje.
          </p>
          <div className="overflow-x-auto scroll-slim">
            <table className="data-table mt-2">
              <thead>
                <tr>
                  <th>Slika</th>
                  <th>Skenirano</th>
                  <th>Serijski broj</th>
                  <th>Model</th>
                  <th>Preskoči</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const d = decisions[i];
                  return (
                    <tr key={r.code} className={cn(d.skip && 'opacity-50')} data-review-row={r.code}>
                      <td data-label="Slika">{r.photo ? <AttachmentGallery items={[r.photo]} /> : <span className="text-xs text-fg-4">bez slike</span>}</td>
                      <td data-label="Skenirano" className="font-mono text-sm text-fg-3">
                        {r.code}
                        {r.exists && (
                          <Badge tone="warn" className="ml-1.5">
                            već postoji
                          </Badge>
                        )}
                      </td>
                      <td data-label="Serijski broj">
                        <Input value={d.serial} disabled={d.skip} onChange={(e) => set(r.code, { serial: e.target.value })} className="min-w-44 font-mono" aria-label={`Serijski broj ${r.code}`} />
                      </td>
                      <td data-label="Model" className="min-w-56">
                        <Combobox options={models} value={d.modelId} onChange={(v) => set(r.code, { modelId: v })} placeholder={defaultModel ? 'zadani model' : 'Odaberite…'} disabled={d.skip} allowEmpty />
                      </td>
                      <td data-label="Preskoči">
                        <Checkbox checked={d.skip} onChange={(e) => set(r.code, { skip: e.target.checked })} aria-label={`Preskoči ${r.code}`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {returning.length > 0 && (
        <Card title={`Povrat na skladište (${returning.length})`} padded={false}>
          <div className="overflow-x-auto scroll-slim">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Slika</th>
                  <th>Serijski broj</th>
                  <th>Model</th>
                  <th>Sada</th>
                  <th>Preskoči</th>
                </tr>
              </thead>
              <tbody>
                {returning.map((r) => {
                  const off = skipBack.has(r.id);
                  return (
                    <tr key={r.id} className={cn(off && 'opacity-50')}>
                      <td data-label="Slika">{r.photo ? <AttachmentGallery items={[r.photo]} /> : <span className="text-xs text-fg-4">bez slike</span>}</td>
                      <td data-label="Serijski broj" className="font-mono text-sm">
                        {r.serial}
                      </td>
                      <td data-label="Model">{r.model}</td>
                      <td data-label="Sada">
                        {r.status}
                        {r.partner && <span className="text-fg-3"> · {r.partner}</span>}
                      </td>
                      <td data-label="Preskoči">
                        <Checkbox
                          checked={off}
                          onChange={(e) =>
                            setSkipBack((s) => {
                              const n = new Set(s);
                              if (e.target.checked) n.add(r.id);
                              else n.delete(r.id);
                              return n;
                            })
                          }
                          aria-label={`Preskoči ${r.serial}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {general.length > 0 && (
        <Card title="Ostale slike uz zahtjev">
          <AttachmentGallery items={general} />
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-base">
            Zaprima se <b className="tnum">{integer(active.length)}</b> novih
            {canSeeCost && active.length > 0 && <> × {eur(unit)} = <b className="tnum">{eur(total)}</b></>}
            {returning.length > 0 && (
              <>
                {' '}
                · vraća se <b className="tnum">{integer(back.length)}</b>
              </>
            )}
            {missing.length > 0 && <p className="text-sm text-warn">Bez modela ili serijskog broja: {missing.length} redaka — odaberite model ili ih preskočite.</p>}
          </div>
          <div className="flex gap-2">
            <RejectButton id={id} />
            <Button variant="primary" size="lg" icon={<PackageCheck className="size-4" />} loading={pending} disabled={!ready} onClick={submit}>
              Zaprimi i odobri
            </Button>
          </div>
        </div>
        {!active.length && !back.length && <Notice tone="warn">Svi redovi su preskočeni — ako roba nije stigla, zahtjev odbijte.</Notice>}
        <div className="mt-2">
          <FormError error={error} />
        </div>
      </Card>
    </div>
  );
}
