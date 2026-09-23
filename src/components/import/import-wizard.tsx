'use client';

import { useRef, useState, type DragEvent } from 'react';
import { CheckCircle2, Copy, DatabaseBackup, Download, FileJson, LogOut, RotateCcw, Upload } from 'lucide-react';
import type { Analysis } from '@/server/import/analyze';
import type { ImportResult } from '@/server/import/run';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { Card, Notice, TableWrap } from '@/components/ui/misc';
import { integer } from '@/lib/format';
import { cn } from '@/lib/cn';
import { logout } from '@/app/(auth)/login/actions';
import { ImportAnalysis } from './import-analysis';

type Phase = 'idle' | 'uploading' | 'analyzed' | 'importing' | 'done';
interface Company { name: string; items: number; invoices: number; partners: number; /** Približna veličina kopije (bajtovi). */ backupBytes: number }

/** Dio datoteke ≤ 8 MB: veća tijela zahtjeva ne prolaze kroz middleware. */
const PART = 8 * 1024 * 1024;

/** Slanje datoteke u dijelovima; vraća oznaku privremene datoteke na poslužitelju. */
async function upload(file: File, onProgress: (pct: number) => void): Promise<string> {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const parts = Math.max(1, Math.ceil(file.size / PART));
  for (let i = 0; i < parts; i++) {
    const res = await fetch(`/api/postavke/uvoz/dio?id=${id}&dio=${i}`, { method: 'POST', body: file.slice(i * PART, (i + 1) * PART), headers: { 'Content-Type': 'application/octet-stream' } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? 'Slanje datoteke nije uspjelo.');
    onProgress(Math.round(((i + 1) / parts) * 100));
  }
  return id;
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/postavke/uvoz', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({ error: `Poslužitelj je vratio grešku ${res.status}.` }))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `Greška ${res.status}`));
  return data;
}

export function ImportWizard({ company, userEmail, maxUploadBytes }: { company: Company; userEmail: string; maxUploadBytes: number }) {
  const MAX_MB = Math.round(maxUploadBytes / 1024 / 1024);
  const input = useRef<HTMLInputElement>(null);
  // zaštita od dvostrukog klika prije nego se stanje osvježi (dvije nove firme)
  const running = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [target, setTarget] = useState<'new' | 'current'>('new');
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<(ImportResult & { labels: Record<string, string> }) | null>(null);
  const [drag, setDrag] = useState(false);

  const nonEmpty = company.items + company.invoices + company.partners > 0;

  async function analyze(f: File) {
    if (running.current) return;
    setError(null);
    setAnalysis(null);
    setResult(null);
    if (!/\.json$/i.test(f.name) && f.type !== 'application/json') return setError('Odaberite datoteku .json.');
    if (f.size > maxUploadBytes) return setError(`Datoteka je veća od ${MAX_MB} MB.`);
    running.current = true;
    setFile(f);
    setPhase('uploading');
    setProgress(0);
    try {
      const id = await upload(f, setProgress);
      setUploadId(id);
      const r = await post({ mode: 'analyze', uploadId: id, fileName: f.name });
      const a = r.analysis as Analysis;
      setAnalysis(a);
      setName(a.companyName ? `${a.companyName}${a.isBackup ? ' (kopija)' : ''}` : f.name.replace(/\.json$/i, ''));
      setTarget('new');
      setConfirm(false);
      setPhase('analyzed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analiza nije uspjela.');
      setPhase('idle');
    } finally {
      running.current = false;
    }
  }

  async function run() {
    if (!file || !analysis || !uploadId || running.current) return;
    running.current = true;
    setError(null);
    setPhase('importing');
    setProgress(100);
    try {
      const r = await post({ mode: 'import', uploadId, fileName: file.name, target, name, confirm });
      setResult({ ...(r.result as ImportResult), labels: (r.labels as Record<string, string>) ?? {} });
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Uvoz nije uspio.');
      setPhase('analyzed');
    } finally {
      running.current = false;
    }
  }

  function reset() {
    setFile(null);
    setUploadId(null);
    setAnalysis(null);
    setResult(null);
    setError(null);
    setPhase('idle');
    if (input.current) input.current.value = '';
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void analyze(f);
  };

  const busy = phase === 'uploading' || phase === 'importing';

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Sigurnosna kopija ove firme">
          <p className="mb-3 text-base text-fg-2">
            Cijela firma „{company.name}" u jednoj JSON datoteci: šifrarnici, partneri, uređaji s poviješću, računi, ugovori, nabava, servis,
            troškovi, prilozi i dnevnik. Lozinke korisnika i fiskalni certifikat nisu u kopiji.
          </p>
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/api/postavke/izvoz" variant="primary" icon={<Download className="size-4" />}>Izvoz sigurnosne kopije</LinkButton>
            <Button icon={<RotateCcw className="size-4" />} onClick={() => input.current?.click()} disabled={busy}>Vrati iz sigurnosne kopije</Button>
          </div>
          <p className="mt-2 text-xs text-fg-3">Kopija se vraća u novu firmu — postojeći podaci ostaju netaknuti.</p>
          {company.backupBytes > maxUploadBytes * 0.9 && (
            <p className="mt-2 text-sm text-warn">
              Kopija će imati oko {Math.round(company.backupBytes / 1024 / 1024)} MB, a vratiti se može datoteka do {MAX_MB} MB (najviše zbog priloga).
              Čuvajte je, ali za vraćanje će trebati pomoć administratora poslužitelja.
            </p>
          )}
        </Card>
        <Card title="Uvoz iz stare verzije">
          <p className="text-base text-fg-2">
            U staroj verziji otvorite <b>Postavke → Sigurnosna kopija → Preuzmi kopiju (JSON)</b> i datoteku ispustite ispod. Prepoznaju se i
            dnevne kopije (<code className="text-sm">backup:&lt;firma&gt;:&lt;datum&gt;</code>), omotači <code className="text-sm">{'{ data }'}</code> i
            zapisi po kolekciji (<code className="text-sm">db:&lt;firma&gt;:items</code>…). Prvo se prikaže analiza — ništa se ne upisuje dok ne potvrdite.
          </p>
        </Card>
      </div>

      <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && analyze(e.target.files[0])} />

      {phase !== 'done' && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => !busy && input.current?.click()}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !busy && input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          data-testid="dropzone"
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors',
            drag ? 'border-brand bg-brand-soft' : 'border-line-strong bg-panel hover:bg-panel-2',
            busy && 'pointer-events-none opacity-70',
          )}
        >
          {file ? <FileJson className="size-8 text-brand" /> : <Upload className="size-8 text-fg-3" />}
          <p className="text-md font-medium">{file ? file.name : 'Ispustite JSON datoteku ovdje ili kliknite za odabir'}</p>
          <p className="text-sm text-fg-3">
            {file ? `${(file.size / 1024 / 1024).toFixed(2)} MB` : `do ${MAX_MB} MB`}
            {phase === 'uploading' && ` · analiza… ${progress < 100 ? `slanje ${progress} %` : 'čitanje i preslikavanje'}`}
            {phase === 'importing' && ' · uvoz… upis u bazu (velika datoteka može potrajati nekoliko minuta)'}
          </p>
          {busy && (
            <div className="h-1.5 w-64 overflow-hidden rounded bg-muted">
              <div className={cn('h-full bg-brand transition-all', progress >= 100 && 'animate-pulse')} style={{ width: `${Math.max(5, progress)}%` }} />
            </div>
          )}
        </div>
      )}

      {error && <Notice tone="bad">{error}</Notice>}

      {analysis && phase !== 'done' && (
        <>
          <ImportAnalysis a={analysis} />
          <Card title={analysis.isBackup ? 'Vraćanje kopije' : 'Kamo uvesti'}>
            <div className="space-y-3">
              <div className="flex items-start gap-2.5 rounded-md p-2 ring-1 ring-line has-[:checked]:ring-brand">
                <input id="target-new" type="radio" name="target" className="mt-1" checked={target === 'new'} onChange={() => setTarget('new')} />
                <div className="flex-1">
                  <label htmlFor="target-new" className="cursor-pointer font-medium">{analysis.isBackup ? 'Vrati u novu firmu' : 'Uvezi u novu firmu'}</label> <span className="text-sm text-ok">(preporučeno)</span>
                  <p className="mt-0.5 text-sm text-fg-3">
                    Korisnik pripada jednoj firmi, pa se za novu firmu stvara <b>novi administratorski račun</b> ({userEmail.split('@')[0]}+naziv-firme@…) s
                    nasumičnom lozinkom koja se prikaže jednom. Vaš sadašnji račun i firma ostaju kakvi jesu; u novu firmu ulazite prijavom s tim računom.
                  </p>
                  {target === 'new' && (
                    <Field label="Naziv nove firme" className="mt-2 max-w-md">
                      <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
                    </Field>
                  )}
                </div>
              </div>
              {!analysis.isBackup && (
                <div className="flex items-start gap-2.5 rounded-md p-2 ring-1 ring-line has-[:checked]:ring-brand">
                  <input id="target-current" type="radio" name="target" className="mt-1" checked={target === 'current'} onChange={() => setTarget('current')} />
                  <div className="flex-1">
                    <label htmlFor="target-current" className="cursor-pointer font-medium">Uvezi u trenutnu firmu „{company.name}"</label>
                    <p className="mt-0.5 text-sm text-fg-3">
                      Postojeći zapisi se preskaču po prirodnom ključu (serijski + razlikovna napomena, OIB ili naziv partnera, proizvođač + model,
                      godina + redni broj računa, broj dokumenta), a veze vode na postojeće zapise.
                      {nonEmpty && ` Firma već ima ${integer(company.items)} uređaja, ${integer(company.invoices)} računa i ${integer(company.partners)} partnera; u datoteci ih se preklapa: ${integer(analysis.current.overlap.items)} uređaja, ${integer(analysis.current.overlap.invoices)} računa, ${integer(analysis.current.overlap.partners)} partnera (po OIB-u).`}
                    </p>
                    {target === 'current' && nonEmpty && (
                      <Checkbox className="mt-2" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} label="Razumijem — podaci se dodaju u firmu koja se već koristi." />
                    )}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button variant="primary" onClick={run} loading={phase === 'importing'} disabled={busy || (target === 'current' && nonEmpty && !confirm) || (target === 'new' && !name.trim())} icon={<DatabaseBackup className="size-4" />}>
                  {analysis.isBackup ? 'Vrati kopiju' : 'Uvezi podatke'}
                </Button>
                <Button variant="ghost" onClick={reset} disabled={busy}>Odustani</Button>
                <span className="text-sm text-fg-3">Uvoz je jedna transakcija: ako ne uspije, ne upisuje se ništa.</span>
              </div>
            </div>
          </Card>
        </>
      )}

      {phase === 'done' && result && <ImportDone result={result} onReset={reset} />}
    </div>
  );
}

function ImportDone({ result, onReset }: { result: ImportResult & { labels: Record<string, string> }; onReset: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (v: string) => void navigator.clipboard?.writeText(v).then(() => setCopied(v));
  const keys = [...new Set([...Object.keys(result.created), ...Object.keys(result.skipped)])].filter((k) => result.created[k] || result.skipped[k]);
  return (
    <div className="space-y-4">
      <Notice tone="ok">
        <span className="flex items-center gap-2">
          <CheckCircle2 className="size-4" />
          Uvoz u firmu „{result.companyName}" završen za {(result.durationMs / 1000).toFixed(1)} s.
        </span>
      </Notice>
      {result.admin && (
        <Card title="Pristup novoj firmi">
          <p className="mb-3 text-base text-fg-2">
            Stvoren je administrator nove firme. <b>Lozinka se prikazuje samo sada</b> — zapišite je, prijavite se s ovim podacima i promijenite je
            (Postavke → Korisnici). Vaš dosadašnji račun ostaje u firmi u kojoj jest.
          </p>
          <dl className="grid max-w-xl gap-2 text-base">
            {[['E-adresa', result.admin.email], ['Lozinka', result.admin.password]].map(([label, v]) => (
              <div key={label} className="flex items-center gap-2">
                <dt className="w-24 text-fg-3">{label}</dt>
                <dd className="flex-1 rounded bg-muted px-2 py-1 font-mono text-sm" data-testid={`admin-${label === 'Lozinka' ? 'password' : 'email'}`}>{v}</dd>
                <Button size="sm" variant="ghost" icon={<Copy className="size-3.5" />} onClick={() => copy(v)}>{copied === v ? 'Kopirano' : 'Kopiraj'}</Button>
              </div>
            ))}
          </dl>
          <div className="mt-3">
            <Button variant="primary" icon={<LogOut className="size-4" />} onClick={() => logout()}>Odjava — prijava u novu firmu</Button>
          </div>
        </Card>
      )}
      <Card title="Rezultat" padded={false}>
        <TableWrap className="shadow-none">
          <table className="data-table compact">
            <thead><tr><th>Podaci</th><th className="num">Upisano</th><th className="num">Preskočeno (već postoji)</th></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}><td>{result.labels[k] ?? k}</td><td className="num">{integer(result.created[k] ?? 0)}</td><td className="num">{result.skipped[k] ? integer(result.skipped[k]) : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
        <details className="border-t border-line px-4 py-2 text-sm text-fg-3">
          <summary className="cursor-pointer">Trajanje po koracima</summary>
          <ul className="mt-1 grid gap-x-6 sm:grid-cols-2">
            {result.steps.map((s) => <li key={s.name}>{s.name}: {integer(s.rows)} u {integer(s.ms)} ms</li>)}
          </ul>
        </details>
      </Card>
      <div className="flex flex-wrap gap-2">
        {!result.admin && <LinkButton href="/skladiste" variant="primary">Otvori skladište</LinkButton>}
        <LinkButton href="/postavke/dnevnik?entitet=import">Zapis u dnevniku</LinkButton>
        <Button variant="ghost" onClick={onReset}>Novi uvoz</Button>
      </div>
    </div>
  );
}
