'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Inbox, Loader2, Printer, ScanLine } from 'lucide-react';
import { Button, LinkButton } from '@/components/ui/button';
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
import { ScanDialog } from '@/components/scan/scan-input';
import { RECEIVE_PREFILL_KEY } from '@/components/scan/core';
import { AttachmentGallery } from './attachments';
import { dateTime } from '@/lib/format';

const PREVIEW_ROWS = 300;

/** Zahtjev skladištara koji se zaprima („Provjeri i zaprimi" s Odobrenja). */
export interface ReceiveRequestInfo {
  id: string;
  requestedBy: string;
  createdAt: string;
  warehouseId: string;
  note: string | null;
  returning: Array<{ id: string; serial: string; status: string }>;
  photos: Array<{ id: string; code: string | null; mime: string; fileName: string; size: number }>;
}

export function ReceiveForm({
  models,
  warehouses,
  initialSerials = [],
  request: initialRequest = null,
}: {
  models: Option[];
  warehouses: Option[];
  initialSerials?: string[];
  request?: ReceiveRequestInfo | null;
}) {
  const [request, setRequest] = useState(initialRequest);
  const [modelId, setModelId] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState(
    initialRequest && warehouses.some((w) => w.value === initialRequest.warehouseId) ? initialRequest.warehouseId : (warehouses[0]?.value ?? ''),
  );
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [cost, setCost] = useState('');
  const [importDate, setImportDate] = useState(today());
  const [docNo, setDocNo] = useState('');
  const [note, setNote] = useState(initialRequest?.note ?? '');

  const [mode, setMode] = useState<'paste' | 'range'>('paste');
  const [text, setText] = useState(initialSerials.join('\n'));
  const [scanOpen, setScanOpen] = useState(false);
  const [done, setDone] = useState<{ receiptId: string; number: string; count: number; returned?: number; requestApproved?: boolean } | null>(null);

  // serijski brojevi predani iz skeniranja („Zaprimi nepoznate")
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(RECEIVE_PREFILL_KEY);
      if (saved) {
        sessionStorage.removeItem(RECEIVE_PREFILL_KEY);
        const list = JSON.parse(saved) as string[];
        if (Array.isArray(list) && list.length) setText((t) => [t, ...list].filter(Boolean).join('\n'));
      }
    } catch {
      /* nedostupno — ništa */
    }
  }, []);

  // poruka o uspjehu je na vrhu obrasca — na mobitelu je treba dovesti u vidno polje
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) doneRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [done]);

  const appendSerial = (code: string) => {
    setMode('paste');
    setText((t) => (t && !t.endsWith('\n') ? `${t}\n${code}` : `${t}${code}`));
  };
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

  const { run, pending, error } = useAction(receiveAction, {
    onSuccess: (d) => {
      if (d) {
        setDone(d);
        setText('');
        if (request) {
          // zahtjev je odobren — daljnje zaprimanje je obično, bez zahtjeva
          setRequest(null);
          setNote('');
          window.history.replaceState(null, '', '/skladiste/zaprimanje');
        }
      }
    },
  });
  const ready = !!modelId && !!warehouseId && newCount > 0 && !tooMany && !checking && (skipExisting || !dupCount || !!dupNote.trim());

  const submit = () =>
    run({ modelId, warehouseId, supplierId, cost, importDate, supplierDocNumber: docNo, note, serials, skipExisting, dupNote, requestId: request?.id ?? null });

  return (
    <>
      <div ref={doneRef} className="scroll-mt-3" />
      {done && (
        <Notice
          tone="ok"
          action={
            <div className="flex flex-wrap gap-2">
              <LinkButton href={`/skladiste/naljepnice?receipt=${done.receiptId}`} size="sm" icon={<Printer className="size-3.5" />}>
                Ispiši naljepnice
              </LinkButton>
              <LinkButton href={`/nabava/primke/${done.receiptId}`} size="sm">
                Otvori primku
              </LinkButton>
            </div>
          }
        >
          Zaprimljeno <b>{integer(done.count)} kom</b> — primka <b>{done.number}</b>.
          {done.returned ? <> Vraćeno na skladište: <b>{integer(done.returned)} kom</b>.</> : null}
          {done.requestApproved ? <> Zahtjev za zaprimanje je odobren.</> : null} Možete nastaviti sa sljedećim zaprimanjem.
        </Notice>
      )}
      {request && <RequestPanel request={request} />}
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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex rounded-md bg-muted p-0.5">
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
              <Button size="sm" variant="subtle" icon={<ScanLine className="size-3.5" />} onClick={() => setScanOpen(true)}>
                Skeniraj
              </Button>
            </div>
            <ScanDialog
              open={scanOpen}
              onClose={() => setScanOpen(false)}
              onCode={appendSerial}
              title="Skeniranje serijskih brojeva"
              hint="Svaki očitani kod dodaje se u popis serijskih brojeva. Ručni čitač radi i izravno u polju ispod."
            />
            {mode === 'paste' ? (
              <Field hint="Jedan serijski broj po retku (stupac iz Excela ili ručni čitač barkodova). Razmaci se brišu, ponovljeni se uzimaju jednom.">
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
                <table className="data-table compact no-stack">
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
    </>
  );
}

/** Podaci zahtjeva skladištara iznad obrasca: tko je poslao, što se vraća i slike naljepnica. */
function RequestPanel({ request }: { request: ReceiveRequestInfo }) {
  return (
    <div className="mb-4 rounded-lg border-l-4 border-l-warn bg-warn-soft/60 px-4 py-3" data-receive-request={request.id}>
      <p className="flex items-start gap-2 text-base">
        <Inbox className="mt-1 size-4 shrink-0 text-warn" />
        <span className="min-w-0">
          Zaprimanje po zahtjevu <b>{request.requestedBy}</b> · {dateTime(request.createdAt)}
        </span>
      </p>
      <p className="mt-1 text-sm text-fg-2">
        Provjerite serijske brojeve i slike, odaberite model i zaprimite. Zahtjev se odobrava zajedno sa zaprimanjem
        {request.returning.length > 0 && <>, a {request.returning.length} poznatih uređaja vraća se na odabrano skladište</>}.
      </p>
      {request.note && <p className="mt-1 text-sm text-fg-2">Napomena: {request.note}</p>}
      {request.returning.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {request.returning.map((i) => (
            <span key={i.id} className="rounded bg-panel px-1.5 py-0.5 font-mono text-xs" title={`Sada: ${i.status}`}>
              {i.serial} <span className="font-sans text-fg-3">· {i.status}</span>
            </span>
          ))}
        </div>
      )}
      {request.photos.length > 0 && (
        <AttachmentGallery className="mt-3" items={request.photos.map((p) => ({ ...p, label: p.code, caption: p.code ? `Serijski: ${p.code}` : 'Općenita slika' }))} />
      )}
    </div>
  );
}
