'use client';

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Input, controlClass } from '@/components/ui/field';
import { Badge, COLOR_TONE } from '@/components/ui/misc';
import { useAction } from '@/components/ui/action';
import { parseNumber, r2 } from '@/domain/money';
import { eur } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Candidate, CandidateSource } from '@/server/queries/rentals';
import { PlanEditor } from './plan-editor';
import { planFromRows, validatePlan, type PlanRow } from '@/domain/plan';
import { addDevicesAction, searchCandidatesAction } from '@/app/(app)/najam/ugovori/actions';

const SOURCES: { value: CandidateSource; label: string; hint: string }[] = [
  { value: 'stock', label: 'Sa skladišta', hint: 'Na skladištu ili izašlo iz skladišta' },
  { value: 'partner', label: 'U najmu kod klijenta', hint: 'Već su kod klijenta, a nisu ni na jednom ugovoru' },
  { value: 'all', label: 'Svi uređaji', hint: 'Svi raspoloživi uređaji koji nisu na ugovoru' },
];

const SOURCE_LABEL: Record<string, string> = { agreed: 'dogovorena', item: 'uređaj', model: 'model', cost: '% nabavne' };

/**
 * Dodavanje uređaja na ugovor u skupini s istim uvjetima: tri izvora,
 * pretraga na poslužitelju, višestruki odabir, cijena po uređaju (prijedlog
 * iz dogovorenih cijena), po želji vlastiti plan i preskakanje prošlih rata.
 */
export function AddDevicesDialog({
  contractId,
  partnerName,
  initial = [],
  defaultFrom,
  startOpen,
}: {
  contractId: string;
  partnerName: string;
  initial?: Candidate[];
  defaultFrom: string;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(startOpen));
  const [source, setSource] = useState<CandidateSource>('stock');
  const [q, setQ] = useState('');
  const [list, setList] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [picked, setPicked] = useState<Map<string, { c: Candidate; price: string }>>(
    () => new Map(initial.map((c) => [c.id, { c, price: String(c.suggested).replace('.', ',') }])),
  );
  const [custom, setCustom] = useState(false);
  const [plan, setPlan] = useState<PlanRow[]>([]);
  const [skipPast, setSkipPast] = useState(false);
  const [all, setAll] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const add = useAction(addDevicesAction, {
    onSuccess: () => {
      setOpen(false);
      setPicked(new Map());
      setPlan([]);
      setCustom(false);
    },
  });

  useEffect(() => {
    if (!open) return;
    let live = true;
    setLoading(true);
    const t = setTimeout(async () => {
      const res = await searchCandidatesAction({ contractId, source, q });
      if (!live) return;
      setLoading(false);
      if (res.ok) setList(res.data ?? []);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, source, q, contractId]);

  const toggle = (c: Candidate) =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.set(c.id, { c, price: String(c.suggested).replace('.', ',') });
      return next;
    });
  const visibleAll = list.length > 0 && list.every((c) => picked.has(c.id));
  const toggleVisible = () =>
    setPicked((prev) => {
      const next = new Map(prev);
      for (const c of list) visibleAll ? next.delete(c.id) : next.has(c.id) || next.set(c.id, { c, price: String(c.suggested).replace('.', ',') });
      return next;
    });

  const rows = [...picked.values()];
  const monthly = useMemo(() => r2(rows.reduce((a, r) => a + parseNumber(r.price), 0)), [rows]);

  const submit = () => {
    const p = custom ? planFromRows(plan) : [];
    const e = custom && !p.length ? 'Dodajte barem jedno razdoblje ili isključite „Različiti od ugovora".' : validatePlan(p);
    setErr(e);
    if (e) return;
    add.run({ contractId, rows: rows.map((r) => ({ itemId: r.c.id, monthly: parseNumber(r.price) })), plan: p, skipPast });
  };

  return (
    <>
      <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>
        Dodaj uređaje
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Dodaj uređaje — ${partnerName}`}
        size="xl"
        footer={
          <>
            <span className="mr-auto self-center text-sm text-fg-3">
              Odabrano: <b className="text-fg">{rows.length}</b> · mjesečno <b className="text-fg">{eur(monthly)}</b>
            </span>
            <Button onClick={() => setOpen(false)}>Odustani</Button>
            <Button variant="primary" loading={add.pending} disabled={!rows.length} onClick={submit}>
              Dodaj {rows.length || ''} na ugovor
            </Button>
          </>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {/* izvor i pretraga */}
          <div className="min-w-0">
            <div className="mb-2 inline-flex flex-wrap rounded-md bg-muted p-0.5">
              {SOURCES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  title={s.hint}
                  onClick={() => setSource(s.value)}
                  className={cn('h-7 rounded px-2.5 text-sm', source === s.value ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-3 hover:text-fg')}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="relative mb-2">
              {loading ? (
                <Loader2 className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-fg-3" />
              ) : (
                <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
              )}
              <input
                aria-label="Traži uređaje"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Serijski broj, model, klijent…"
                className={cn(controlClass, 'h-8 pl-8')}
              />
            </div>
            <p className="mb-1 text-xs text-fg-3">{SOURCES.find((s) => s.value === source)?.hint}. Prikazano najviše 100 — suzite pretragom.</p>
            <div className="max-h-[46vh] overflow-y-auto scroll-slim rounded-md border border-line">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th className="w-8">
                      <input type="checkbox" aria-label="Označi sve prikazane" checked={visibleAll} onChange={toggleVisible} className="size-4 align-middle accent-[var(--color-brand)]" />
                    </th>
                    <th>Serijski</th>
                    <th>Model</th>
                    <th>Status</th>
                    <th className="num">Prijedlog</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((c) => (
                    <tr key={c.id} data-selected={picked.has(c.id)} onClick={() => toggle(c)} className="cursor-pointer">
                      <td>
                        <input type="checkbox" readOnly checked={picked.has(c.id)} aria-label={`Označi ${c.serial}`} className="size-4 align-middle accent-[var(--color-brand)]" />
                      </td>
                      <td className="font-mono text-sm">{c.serial}</td>
                      <td className="max-w-48 truncate">{c.model}</td>
                      <td className="max-w-52 truncate whitespace-nowrap" title={c.where}>
                        <Badge tone={COLOR_TONE[c.color] ?? 'neutral'}>{c.status}</Badge>
                        {c.where && <span className="ml-1 text-xs text-fg-3">{c.where}</span>}
                      </td>
                      <td className="num">{eur(c.suggested)}</td>
                    </tr>
                  ))}
                  {!list.length && !loading && (
                    <tr>
                      <td colSpan={5} className="py-6 text-center text-sm text-fg-3">
                        Nema uređaja za ovaj izvor i pretragu.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* odabrani i uvjeti */}
          <div className="min-w-0 space-y-3">
            <div className="flex items-end justify-between gap-2">
              <h3 className="text-md font-semibold">Odabrani uređaji</h3>
              {rows.length > 1 && (
                <div className="flex items-center gap-1.5">
                  <Input aria-label="Cijena za sve" inputMode="decimal" placeholder="Cijena za sve" className="w-28 text-right" value={all} onChange={(e) => setAll(e.target.value)} />
                  <Button size="sm" disabled={!all.trim()} onClick={() => setPicked((prev) => new Map([...prev].map(([k, v]) => [k, { ...v, price: all }])))}>
                    Primijeni
                  </Button>
                </div>
              )}
            </div>
            <div className="max-h-[26vh] overflow-y-auto scroll-slim rounded-md border border-line">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Serijski</th>
                    <th>Model</th>
                    <th className="num">Mjesečno €</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ c, price }) => (
                    <tr key={c.id}>
                      <td className="font-mono text-sm">{c.serial}</td>
                      <td className="max-w-40 truncate">{c.model}</td>
                      <td className="num">
                        <Input
                          aria-label={`Mjesečna cijena ${c.serial}`}
                          inputMode="decimal"
                          className="w-24 text-right"
                          title={`Prijedlog: ${SOURCE_LABEL[c.source] ?? c.source}`}
                          value={price}
                          onChange={(e) => setPicked((prev) => new Map(prev).set(c.id, { c, price: e.target.value }))}
                        />
                      </td>
                      <td>
                        <button type="button" aria-label="Makni" onClick={() => toggle(c)} className="grid size-6 place-items-center rounded text-fg-3 hover:bg-muted">
                          <X className="size-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={4} className="py-4 text-center text-sm text-fg-3">
                        Označite uređaje s lijeve strane.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 rounded-md bg-panel-2 p-3">
              <Checkbox label={<span>Različiti od ugovora <span className="text-fg-3">— vlastiti plan naplate za ovu skupinu</span></span>} checked={custom} onChange={(e) => setCustom(e.target.checked)} />
              <Checkbox
                label={<span>Ne traži račune za prošla razdoblja <span className="text-fg-3">— već su izdani izvan programa</span></span>}
                checked={skipPast}
                onChange={(e) => setSkipPast(e.target.checked)}
              />
            </div>
          </div>
        </div>
        {custom && (
          <div className="mt-4 border-t border-line pt-3">
            <h3 className="mb-2 text-md font-semibold">Plan naplate skupine</h3>
            <PlanEditor rows={plan} onChange={setPlan} defaultFrom={defaultFrom} basePrice={rows.length && rows.every((r) => r.price === rows[0].price) ? parseNumber(rows[0].price) : null} />
          </div>
        )}
        {err && <p className="mt-2 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{err}</p>}
      </Dialog>
    </>
  );
}
