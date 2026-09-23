'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Field, FormGrid, Input, Select, Textarea, type Option } from '@/components/ui/field';
import { Card, Notice, Badge } from '@/components/ui/misc';
import { useAction, FormError } from '@/components/ui/action';
import { parseNumber, r2 } from '@/domain/money';
import { today } from '@/domain/dates';
import { eur, integer } from '@/lib/format';
import { cn } from '@/lib/cn';
import { PartnerPicker } from './pickers';
import { MAX_RECEIVE, parseSerials, serialRange } from '@/domain/warehouse';
import { checkSerials, receiveAction } from '@/app/(app)/skladiste/zaprimanje/actions';

const PREVIEW_ROWS = 300;

export function ReceiveForm({ models, warehouses }: { models: Option[]; warehouses: Option[] }) {
  const [modelId, setModelId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.value ?? '');
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [cost, setCost] = useState('');
  const [importDate, setImportDate] = useState(today());
  const [docNo, setDocNo] = useState('');
  const [note, setNote] = useState('');

  const [mode, setMode] = useState<'paste' | 'range'>('paste');
  const [text, setText] = useState('');
  const [range, setRange] = useState({ prefix: '', from: '1', to: '10', pad: '0' });

  const [skipExisting, setSkipExisting] = useState(true);
  const [dupNote, setDupNote] = useState('');
  const [existing, setExisting] = useState<Map<string, string[]>>(new Map());
  const [checking, setChecking] = useState(false);

  const { serials, repeated } = useMemo(() => {
    if (mode === 'paste') return parseSerials(text);
    const from = Number(range.from);
    const to = Number(range.to);
    return { serials: serialRange(range.prefix.trim(), from, to, Number(range.pad) || 0), repeated: [] as string[] };
  }, [mode, text, range]);

  // provjera postojećih serijskih na poslužitelju (s odgodom dok korisnik tipka)
  useEffect(() => {
    if (!serials.length || serials.length > MAX_RECEIVE) {
      setExisting(new Map());
      return;
    }
    let live = true;
    setChecking(true);
    const t = setTimeout(async () => {
      const res = await checkSerials({ serials });
      if (!live) return;
      setChecking(false);
      if (res.ok) setExisting(new Map((res.data ?? []).map((r) => [r.serial, r.notes])));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [serials]);

  const dupCount = serials.filter((s) => existing.has(s)).length;
  const newCount = skipExisting ? serials.length - dupCount : serials.length;
  const unit = parseNumber(cost);
  const total = r2(unit * newCount);
  const tooMany = serials.length > MAX_RECEIVE;

  const { run, pending, error } = useAction(receiveAction);
  const ready = !!modelId && !!warehouseId && newCount > 0 && !tooMany && !checking && (skipExisting || !dupCount || !!dupNote.trim());

  const submit = () =>
    run({ modelId, warehouseId, supplierId, cost, importDate, supplierDocNumber: docNo, note, serials, skipExisting, dupNote });

  return (
    <div className="grid gap-4 xl:grid-cols-[26rem_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card title="Podaci primke">
          <div className="space-y-3">
            <Field label="Model" required>
              <Combobox options={models} value={modelId} onChange={setModelId} placeholder="Odaberite model…" />
            </Field>
            <FormGrid>
              <Field label="Skladište" required>
                <Select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} options={warehouses} />
              </Field>
              <Field label="Datum uvoza" required>
                <Input type="date" value={importDate} onChange={(e) => setImportDate(e.target.value)} />
              </Field>
            </FormGrid>
            <Field label="Dobavljač">
              <PartnerPicker value={supplierId} onChange={setSupplierId} role="supplier" placeholder="— bez dobavljača —" />
            </Field>
            <FormGrid>
              <Field label="Nabavna cijena po komadu (€)">
                <Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0,00" className="text-right" />
              </Field>
              <Field label="Broj dokumenta dobavljača">
                <Input value={docNo} onChange={(e) => setDocNo(e.target.value)} placeholder="npr. otpremnica 123/26" />
              </Field>
            </FormGrid>
            <Field label="Napomena" hint="Upisuje se i na svaki uređaj.">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
            </Field>
          </div>
        </Card>

        <Card title="Serijski brojevi">
          <div className="mb-3 inline-flex rounded-md bg-muted p-0.5">
            {(['paste', 'range'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn('h-7 rounded px-3 text-sm', mode === m ? 'bg-panel font-medium text-fg shadow-sm' : 'text-fg-3 hover:text-fg')}
              >
                {m === 'paste' ? 'Zalijepi stupac' : 'Generiraj raspon'}
              </button>
            ))}
          </div>
          {mode === 'paste' ? (
            <Field hint="Jedan serijski broj po retku (npr. stupac iz Excela). Razmaci se brišu, ponovljeni se uzimaju jednom.">
              <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="font-mono text-sm" placeholder={'SN0001\nSN0002\nSN0003'} />
            </Field>
          ) : (
            <div className="space-y-2">
              <FormGrid cols={2}>
                <Field label="Prefiks">
                  <Input value={range.prefix} onChange={(e) => setRange({ ...range, prefix: e.target.value })} placeholder="npr. SN26-" className="font-mono" />
                </Field>
                <Field label="Nadopuna nulama (znamenki)">
                  <Input type="number" min={0} max={12} value={range.pad} onChange={(e) => setRange({ ...range, pad: e.target.value })} />
                </Field>
                <Field label="Od">
                  <Input type="number" min={0} value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
                </Field>
                <Field label="Do">
                  <Input type="number" min={0} value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
                </Field>
              </FormGrid>
              {serials.length > 0 && (
                <p className="text-sm text-fg-3">
                  {serials[0]} … {serials[serials.length - 1]}
                </p>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-4">
        <Card
          title="Pregled"
          actions={checking ? <Loader2 className="size-4 animate-spin text-fg-3" /> : null}
          padded={false}
        >
          <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-4 py-3 text-base">
            <span>
              Upisano: <b className="tnum">{integer(serials.length)}</b>
            </span>
            <span className="text-ok">
              Novih: <b className="tnum">{integer(serials.length - dupCount)}</b>
            </span>
            <span className={dupCount ? 'text-warn' : 'text-fg-3'}>
              Već postoji: <b className="tnum">{integer(dupCount)}</b>
            </span>
            {repeated.length > 0 && <span className="text-fg-3">Ponovljeno u unosu (uzeto jednom): {integer(repeated.length)}</span>}
          </div>

          {tooMany && (
            <div className="px-4 pt-3">
              <Notice tone="bad">Najviše {integer(MAX_RECEIVE)} uređaja odjednom — podijelite unos.</Notice>
            </div>
          )}

          {dupCount > 0 && (
            <div className="space-y-2 border-b border-line px-4 py-3">
              <p className="text-sm text-fg-2">Serijski brojevi koji već postoje:</p>
              <label className="flex items-center gap-2 text-base">
                <input type="radio" checked={skipExisting} onChange={() => setSkipExisting(true)} className="accent-[var(--color-brand)]" />
                Preskoči postojeće (zaprimaju se samo novi)
              </label>
              <label className="flex flex-wrap items-center gap-2 text-base">
                <input type="radio" checked={!skipExisting} onChange={() => setSkipExisting(false)} className="accent-[var(--color-brand)]" />
                Zaprimi i njih kao nove uređaje uz razlikovnu napomenu:
                <Input
                  value={dupNote}
                  onChange={(e) => {
                    setDupNote(e.target.value);
                    setSkipExisting(false);
                  }}
                  placeholder="npr. zamjenski 2026"
                  className="w-56"
                />
              </label>
            </div>
          )}

          {serials.length > 0 ? (
            <div className="max-h-[28rem] overflow-y-auto scroll-slim">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th className="w-12 num">#</th>
                    <th>Serijski broj</th>
                    <th>Provjera</th>
                  </tr>
                </thead>
                <tbody>
                  {serials.slice(0, PREVIEW_ROWS).map((s, i) => {
                    const ex = existing.get(s);
                    return (
                      <tr key={s} className={cn(ex && skipExisting && 'opacity-50')}>
                        <td className="num text-fg-3">{i + 1}</td>
                        <td className="font-mono text-sm">{s}</td>
                        <td>
                          {ex ? (
                            <Badge tone="warn" title={ex.filter(Boolean).join(', ')}>
                              <AlertTriangle className="size-3" /> postoji ({ex.length}){skipExisting ? ' — preskače se' : ''}
                            </Badge>
                          ) : (
                            <Badge tone="ok">
                              <CheckCircle2 className="size-3" /> novi
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {serials.length > PREVIEW_ROWS && (
                <p className="px-4 py-2 text-sm text-fg-3">… i još {integer(serials.length - PREVIEW_ROWS)} serijskih brojeva.</p>
              )}
            </div>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-fg-3">Zalijepite serijske brojeve ili generirajte raspon.</p>
          )}
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-base">
              Zaprima se <b className="tnum">{integer(newCount)}</b> kom × {eur(unit)} = <b className="tnum">{eur(total)}</b>
              <p className="text-xs text-fg-3">Nastaje primka i trošak „Nabava robe" u iznosu nabavne vrijednosti.</p>
            </div>
            <Button variant="primary" size="lg" loading={pending} disabled={!ready} onClick={submit}>
              Zaprimi {newCount > 0 ? `${integer(newCount)} kom` : ''}
            </Button>
          </div>
          <div className="mt-2">
            <FormError error={error} />
          </div>
        </Card>
      </div>
    </div>
  );
}
