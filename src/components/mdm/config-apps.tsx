'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Settings2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, Empty } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import type { EditorApp, LibraryApp } from './config-model';

/**
 * Aplikacije u konfiguraciji (kao SCN „Applications"): odabir iz knjižnice,
 * verzija (konkretna ili najnovija), aplikacija nakon paljenja, skrivanje u
 * pokretaču, uklanjanje i postavke aplikacije (host/port + ključ/vrijednost).
 */
export function ConfigApps({
  value,
  onChange,
  library,
  readOnly,
  inherited,
}: {
  value: EditorApp[];
  onChange: (v: EditorApp[]) => void;
  library: LibraryApp[];
  readOnly?: boolean;
  /** Uređaj: aplikacije iz konfiguracije lokacije/profila (ne brišu se, samo mijenjaju). */
  inherited?: string[];
}) {
  const [adding, setAdding] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const byId = useMemo(() => new Map(library.map((a) => [a.id, a])), [library]);
  const patch = (appId: string, p: Partial<EditorApp>) => onChange(value.map((a) => (a.appId === appId ? { ...a, ...p } : a)));
  const start = value.find((a) => a.autoStart && !a.remove)?.appId ?? '';
  const current = configuring ? value.find((a) => a.appId === configuring) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Aplikacija za pokretanje nakon paljenja" hint="U zaključanom načinu to je jedina aplikacija na zaslonu." className="w-full max-w-sm">
          <Select
            value={start}
            disabled={readOnly}
            placeholder="(nijedna)"
            options={value.filter((a) => !a.remove).map((a) => ({ value: a.appId, label: byId.get(a.appId)?.name ?? a.appId }))}
            onChange={(e) => onChange(value.map((a) => ({ ...a, autoStart: a.appId === e.target.value })))}
          />
        </Field>
        {!readOnly && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Instaliraj
          </Button>
        )}
      </div>

      <div className="overflow-x-auto scroll-slim rounded-lg border border-line">
        {value.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>Naziv</th>
                <th>Paket</th>
                <th>Verzija</th>
                <th>Zastavice</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {value.map((a) => {
                const lib = byId.get(a.appId);
                const keys = Object.keys(a.config).length;
                return (
                  <tr key={a.appId} className={cn(a.remove && 'opacity-70')}>
                    <td className="font-medium">
                      {lib?.name ?? <span className="text-bad-strong">obrisana aplikacija</span>}
                      {a.autoStart && !a.remove && (
                        <Badge tone="brand" className="ml-1.5">
                          pokreće se
                        </Badge>
                      )}
                      {inherited?.includes(a.appId) && (
                        <Badge tone="neutral" className="ml-1.5" title="Iz konfiguracije lokacije/profila">
                          iz profila
                        </Badge>
                      )}
                    </td>
                    <td className="font-mono text-sm">{lib?.packageName ?? a.appId}</td>
                    <td>
                      <Select
                        className="w-full sm:w-44"
                        disabled={readOnly || !lib}
                        value={a.versionId ?? ''}
                        onChange={(e) => patch(a.appId, { versionId: e.target.value || null })}
                        options={[
                          { value: '', label: `najnovija${lib?.versions[0] ? ` (${lib.versions[0].version})` : ''}` },
                          ...(lib?.versions ?? []).map((v) => ({ value: v.id, label: v.version })),
                        ]}
                      />
                    </td>
                    <td className="space-y-1 whitespace-nowrap max-sm:col-span-2">
                      <Checkbox label="skrivena u pokretaču" checked={a.hidden} disabled={readOnly || a.remove} onChange={(e) => patch(a.appId, { hidden: e.target.checked })} />
                      <br />
                      <Checkbox
                        label={<span className={cn(a.remove && 'font-medium text-bad-strong')}>ukloni s uređaja</span>}
                        checked={a.remove}
                        disabled={readOnly}
                        onChange={(e) => patch(a.appId, { remove: e.target.checked, autoStart: e.target.checked ? false : a.autoStart })}
                      />
                    </td>
                    <td className="whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" title="Postavke aplikacije" onClick={() => setConfiguring(a.appId)} icon={<Settings2 className="size-4" />}>
                        {keys ? keys : null}
                      </Button>
                      {!readOnly && !inherited?.includes(a.appId) && (
                        <Button size="sm" variant="ghost" title="Makni iz konfiguracije" onClick={() => onChange(value.filter((x) => x.appId !== a.appId))} icon={<Trash2 className="size-4" />} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty title="Nema aplikacija" description={`Dodajte aplikacije iz knjižnice gumbom „Instaliraj".`} />
        )}
      </div>

      <AddAppDialog
        open={adding}
        onClose={() => setAdding(false)}
        library={library.filter((l) => !value.some((a) => a.appId === l.id))}
        onPick={(appId, versionId) => {
          onChange([...value, { appId, versionId, config: {}, hidden: false, autoStart: false, remove: false }]);
          setAdding(false);
        }}
      />
      {current && (
        <AppConfigDialog
          title={byId.get(current.appId)?.name ?? current.appId}
          config={current.config}
          readOnly={readOnly}
          onClose={() => setConfiguring(null)}
          onSave={(config) => {
            patch(current.appId, { config });
            setConfiguring(null);
          }}
        />
      )}
    </div>
  );
}

/** Popis aplikacija iz knjižnice s verzijama (SCN „Install Application"). */
export function AddAppDialog({
  open,
  onClose,
  library,
  onPick,
  title = 'Instaliraj aplikaciju',
  pickLabel = 'Dodaj',
  latestLabel = 'Najnovija',
}: {
  open: boolean;
  onClose: () => void;
  library: LibraryApp[];
  onPick: (appId: string, versionId: string | null) => void;
  title?: string;
  pickLabel?: string;
  latestLabel?: string;
}) {
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const list = library.filter((a) => !q || `${a.name} ${a.packageName}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog open={open} onClose={onClose} title={title} size="lg">
      <Input placeholder="Traži po nazivu ili paketu…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      {list.length ? (
        <div className="divide-y divide-line rounded-lg border border-line">
          {list.map((a) => (
            <div key={a.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <button type="button" className="text-fg-3" onClick={() => setExpanded(expanded === a.id ? null : a.id)} aria-label="Verzije">
                  {expanded === a.id ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {a.name}
                    {a.shared && (
                      <Badge tone="info" className="ml-1.5">
                        zajednička
                      </Badge>
                    )}
                  </div>
                  <div className="truncate font-mono text-xs text-fg-3">{a.packageName}</div>
                </div>
                <span className="tnum text-sm">{a.versions[0]?.version ?? '—'}</span>
                <button type="button" onClick={() => setExpanded(expanded === a.id ? null : a.id)}>
                  <Badge tone="brand">Verzije ({a.versions.length})</Badge>
                </button>
                <Button size="sm" variant="primary" disabled={!a.versions.length} onClick={() => onPick(a.id, null)}>
                  {pickLabel}
                </Button>
              </div>
              {expanded === a.id && (
                <div className="bg-muted/50 px-10 py-2">
                  <p className="mb-1 text-xs text-fg-3">{latestLabel} = uvijek zadnja učitana verzija; odabirom konkretne verzija se ne mijenja dok je ne promijenite.</p>
                  {a.versions.map((v) => (
                    <div key={v.id} className="flex items-center justify-between gap-3 py-1 text-sm">
                      <span className="tnum">
                        {v.version}
                        {v.versionCode !== null && <span className="ml-2 text-fg-3">({v.versionCode})</span>}
                      </span>
                      <Button size="sm" onClick={() => onPick(a.id, v.id)}>
                        {pickLabel} {v.version}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <Empty title="Nema aplikacija" description="U knjižnici nema (drugih) aplikacija za ovu platformu. Učitajte ih na stranici Aplikacije." />
      )}
    </Dialog>
  );
}

/** Postavke aplikacije: strukturirano (host, port, ključ/vrijednost) ili ručno (JSON). */
function AppConfigDialog({
  title,
  config,
  readOnly,
  onClose,
  onSave,
}: {
  title: string;
  config: Record<string, string>;
  readOnly?: boolean;
  onClose: () => void;
  onSave: (c: Record<string, string>) => void;
}) {
  const [tab, setTab] = useState<'structured' | 'manual'>('structured');
  const [host, setHost] = useState(config.host ?? '');
  const [port, setPort] = useState(config.port ?? '');
  const [pairs, setPairs] = useState(() => Object.entries(config).filter(([k]) => k !== 'host' && k !== 'port'));
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const collect = (): Record<string, string> => {
    const out: Record<string, string> = {};
    if (host.trim()) out.host = host.trim();
    if (port.trim()) out.port = port.trim();
    for (const [k, v] of pairs) if (k.trim()) out[k.trim()] = v;
    return out;
  };
  const toManual = () => {
    setJson(JSON.stringify(collect(), null, 2));
    setTab('manual');
  };
  const fromManual = (): Record<string, string> | null => {
    try {
      const o = JSON.parse(json || '{}');
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error();
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
    } catch {
      setError('JSON nije ispravan objekt { "ključ": "vrijednost" }.');
      return null;
    }
  };
  const toStructured = () => {
    const o = fromManual();
    if (!o) return;
    setHost(o.host ?? '');
    setPort(o.port ?? '');
    setPairs(Object.entries(o).filter(([k]) => k !== 'host' && k !== 'port'));
    setError(null);
    setTab('structured');
  };
  const save = () => {
    const out = tab === 'manual' ? fromManual() : collect();
    if (!out) return;
    if (out.port && !/^\d{1,5}$/.test(out.port)) return setError('Port mora biti broj 1–65535.');
    if (out.port && (Number(out.port) < 1 || Number(out.port) > 65535)) return setError('Port mora biti broj 1–65535.');
    onSave(out);
  };

  const tabBtn = (t: typeof tab, label: string, go: () => void) => (
    <button type="button" onClick={go} className={cn('-mb-px border-b-2 px-3 py-1.5', tab === t ? 'border-brand font-medium' : 'border-transparent text-fg-3')}>
      {label}
    </button>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Postavke: ${title}`}
      footer={
        <>
          <Button onClick={onClose}>Odustani</Button>
          {!readOnly && (
            <Button variant="primary" onClick={save}>
              Spremi
            </Button>
          )}
        </>
      }
    >
      <div className="mb-3 flex gap-1 border-b border-line">
        {tabBtn('structured', 'Strukturirano', () => (tab === 'manual' ? toStructured() : undefined))}
        {tabBtn('manual', 'Ručno (JSON)', () => (tab === 'structured' ? toManual() : undefined))}
      </div>
      {error && <p className="mb-2 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad-strong">{error}</p>}
      {tab === 'structured' ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
            <Field label="Adresa poslužitelja (host)" hint="IP adresa ili naziv računala s kasom/poslužiteljem">
              <Input value={host} disabled={readOnly} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10" />
            </Field>
            <Field label="Port">
              <Input value={port} disabled={readOnly} inputMode="numeric" onChange={(e) => setPort(e.target.value)} placeholder="24998" />
            </Field>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium text-fg-2">Vlastiti parovi ključ / vrijednost</p>
            <div className="space-y-1.5">
              {pairs.map(([k, v], i) => (
                <div key={i} className="flex gap-2">
                  <Input value={k} disabled={readOnly} placeholder="ključ" onChange={(e) => setPairs(pairs.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))} />
                  <Input value={v} disabled={readOnly} placeholder="vrijednost" onChange={(e) => setPairs(pairs.map((p, j) => (j === i ? [p[0], e.target.value] : p)))} />
                  {!readOnly && <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setPairs(pairs.filter((_, j) => j !== i))} aria-label="Ukloni" />}
                </div>
              ))}
            </div>
            {!readOnly && (
              <Button size="sm" className="mt-2" icon={<Plus className="size-3.5" />} onClick={() => setPairs([...pairs, ['', '']])}>
                Dodaj
              </Button>
            )}
          </div>
          <p className="text-xs text-fg-3">Android: šalje se kao „managed configuration" aplikacije. Windows: agent zapisuje u registry/JSON aplikacije.</p>
        </div>
      ) : (
        <Textarea rows={12} className="font-mono text-sm" value={json} disabled={readOnly} onChange={(e) => setJson(e.target.value)} />
      )}
    </Dialog>
  );
}
