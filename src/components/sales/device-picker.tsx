'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Search } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/misc';
import { controlClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { amount, pct } from '@/lib/format';
import { findDevices } from '@/app/(app)/prodaja/racuni/actions';
import { modelName, type DeviceOpt, type ModelOpt, type NamedOpt } from './types';

const SOURCE: Record<DeviceOpt['priceSource'], string> = { agreed: 'cjenik', model: 'cijena modela', margin: 'iz marže' };

/**
 * Birač uređaja sa skladišta (na skladištu ili izašli iz skladišta): tražilica,
 * filtri po modelu, kategoriji i skladištu, višestruki odabir. Cijena je
 * preporučena za odabranog kupca.
 */
export function DevicePicker({
  open,
  onClose,
  onPick,
  partnerId,
  models,
  categories,
  warehouses,
  exclude = [],
  fixedModelId,
  count,
  title = 'Uređaji sa skladišta',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (devices: DeviceOpt[]) => void;
  partnerId: string | null;
  models: ModelOpt[];
  categories: NamedOpt[];
  warehouses: NamedOpt[];
  exclude?: string[];
  fixedModelId?: string;
  count?: number;
  title?: string;
}) {
  const [q, setQ] = useState('');
  const [modelId, setModelId] = useState(fixedModelId ?? '');
  const [categoryId, setCategoryId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [rows, setRows] = useState<DeviceOpt[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, DeviceOpt>>(new Map());

  useEffect(() => {
    if (open) {
      setPicked(new Map());
      setModelId(fixedModelId ?? '');
    }
  }, [open, fixedModelId]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const t = setTimeout(async () => {
      const res = await findDevices({ q, modelId: modelId || null, categoryId: categoryId || null, warehouseId: warehouseId || null, partnerId });
      if (!live) return;
      setLoading(false);
      if (res.ok) {
        setRows(res.data ?? []);
        setError(null);
      } else setError(res.error);
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, q, modelId, categoryId, warehouseId, partnerId]);

  const skip = useMemo(() => new Set(exclude), [exclude]);
  const visible = rows.filter((r) => !skip.has(r.id));
  const allOn = visible.length > 0 && visible.every((r) => picked.has(r.id));
  const toggle = (r: DeviceOpt) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(r.id)) next.delete(r.id);
      else if (!count || next.size < count) next.set(r.id, r);
      return next;
    });
  const exact = count === undefined || picked.size === count;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="xl"
      footer={
        <>
          <span className="mr-auto self-center text-sm text-fg-3">
            Odabrano: <b className="text-fg">{picked.size}</b>
            {count !== undefined && <> od {count}</>}
          </span>
          <Button onClick={onClose}>Odustani</Button>
          <Button
            variant="primary"
            disabled={!picked.size || !exact}
            onClick={() => {
              onPick([...picked.values()]);
              onClose();
            }}
          >
            Dodaj odabrane
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          {loading ? (
            <Loader2 className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fg-3" />
          ) : (
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
          )}
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Serijski broj, model, šifra…" className={cn(controlClass, 'h-8 pl-8')} />
        </div>
        <select value={modelId} disabled={!!fixedModelId} onChange={(e) => setModelId(e.target.value)} className={cn(controlClass, 'h-8 w-auto max-w-56')}>
          <option value="">Svi modeli</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {modelName(m)}
            </option>
          ))}
        </select>
        {!fixedModelId && (
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={cn(controlClass, 'h-8 w-auto max-w-48')}>
            <option value="">Sve kategorije</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} className={cn(controlClass, 'h-8 w-auto max-w-48')}>
          <option value="">Sva skladišta</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="mb-2 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{error}</p>}
      <div className="max-h-[55vh] overflow-auto scroll-slim rounded-md border border-line">
        <table className="data-table compact">
          <thead>
            <tr>
              <th className="w-8">
                {!count && (
                  <input
                    type="checkbox"
                    aria-label="Označi sve"
                    checked={allOn}
                    onChange={() => setPicked(allOn ? new Map() : new Map(visible.map((r) => [r.id, r])))}
                    className="size-4 align-middle accent-[var(--color-brand)]"
                  />
                )}
              </th>
              <th>Serijski broj</th>
              <th>Model</th>
              <th>Kategorija</th>
              <th>Skladište</th>
              <th>Status</th>
              <th className="num">Nabavna</th>
              <th className="num">Cijena</th>
              <th className="num">Marža</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} data-selected={picked.has(r.id)} onClick={() => toggle(r)} className="cursor-pointer">
                <td>
                  <input type="checkbox" readOnly checked={picked.has(r.id)} className="size-4 align-middle accent-[var(--color-brand)]" aria-label="Označi" />
                </td>
                <td className="font-mono text-sm">{r.serial}</td>
                <td>{r.model}</td>
                <td className="text-fg-3">{r.category ?? '—'}</td>
                <td className="text-fg-3">{r.warehouse ?? '—'}</td>
                <td>
                  <Badge tone={r.state === 'RESERVED' ? 'warn' : 'ok'}>{r.status}</Badge>
                </td>
                <td className="num text-fg-3">{amount(r.cost)}</td>
                <td className="num">
                  {amount(r.price)}
                  <span className={cn('ml-1.5 text-xs', r.priceSource === 'agreed' ? 'font-medium text-brand' : 'text-fg-4')}>{SOURCE[r.priceSource]}</span>
                </td>
                <td className="num text-fg-3">{pct(r.margin)}</td>
              </tr>
            ))}
            {!visible.length && !loading && (
              <tr>
                <td colSpan={9} className="py-8 text-center text-fg-3">
                  Nema raspoloživih uređaja za zadane filtre.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length >= 150 && <p className="mt-2 text-xs text-fg-3">Prikazano je prvih 150 uređaja — suzite pretragu.</p>}
    </Dialog>
  );
}
