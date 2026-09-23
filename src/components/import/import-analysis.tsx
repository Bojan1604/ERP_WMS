'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, XCircle } from 'lucide-react';
import type { Analysis } from '@/server/import/analyze';
import { Badge, Card, TableWrap } from '@/components/ui/misc';
import { amount, date, dateTime, integer } from '@/lib/format';
import { ROLE_LABEL, type RoleCode } from '@/domain/permissions';

const LEVEL = {
  error: { icon: XCircle, tone: 'bad' as const, label: 'greška' },
  warn: { icon: AlertTriangle, tone: 'warn' as const, label: 'upozorenje' },
  info: { icon: Info, tone: 'info' as const, label: 'napomena' },
};

/** Korak 1: što je u datoteci — oblik, brojevi, upozorenja i primjer preslikavanja. */
export function ImportAnalysis({ a }: { a: Analysis }) {
  return (
    <div className="space-y-4">
      <Card title="Sadržaj datoteke">
        <dl className="mb-3 grid gap-x-6 gap-y-1 text-base sm:grid-cols-2">
          <div><dt className="inline text-fg-3">Prepoznat oblik: </dt><dd className="inline font-medium">{a.label}</dd></div>
          {a.companyName && <div><dt className="inline text-fg-3">Firma u datoteci: </dt><dd className="inline font-medium">{a.companyName}</dd></div>}
          {a.exportedAt && <div><dt className="inline text-fg-3">Izvezeno: </dt><dd className="inline">{a.exportedAt.length > 10 ? dateTime(a.exportedAt) : date(a.exportedAt)}</dd></div>}
        </dl>
        {a.notes.map((n) => (
          <p key={n} className="mb-2 text-sm text-fg-2">{n}</p>
        ))}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {a.counts.map((c) => (
            <div key={c.key} className="rounded-md bg-panel-2 px-3 py-2 ring-1 ring-line">
              <p className="text-xs text-fg-3">{c.label}</p>
              <p className="text-md font-semibold tnum">{integer(c.count)}</p>
            </div>
          ))}
        </div>
      </Card>

      <Warnings a={a} />

      {a.users.length > 0 && (
        <Card title={`Korisnici iz datoteke (${a.users.length})`}>
          <p className="mb-2 text-sm text-fg-2">
            Korisnici se ne uvoze: stara verzija čuva lozinke kao običan tekst, a e-adrese često nisu stvarne (npr. „admin"). Dodajte ih u
            Postavke → Korisnici; uloge su preslikane ovako:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {a.users.map((u, i) => (
              <Badge key={i} tone={u.active ? 'neutral' : 'warn'}>
                {u.name || u.email} · {ROLE_LABEL[u.role as RoleCode] ?? u.role}
                {!u.active && ' · neaktivan'}
              </Badge>
            ))}
          </div>
        </Card>
      )}

      <Samples a={a} />
    </div>
  );
}

function Warnings({ a }: { a: Analysis }) {
  const [open, setOpen] = useState(a.warningTotal > 0 && a.warningTotal <= 20);
  const [code, setCode] = useState<string | null>(null);
  const byCode = useMemo(() => Object.entries(a.warningCounts).sort((x, y) => y[1] - x[1]), [a.warningCounts]);
  const shown = code ? a.warnings.filter((w) => w.code === code) : a.warnings;
  if (!a.warningTotal) {
    return <Card><p className="text-base text-ok">Nema upozorenja — svi zapisi su čitljivi i veze su ispravne.</p></Card>;
  }
  return (
    <Card
      title={
        <button type="button" className="flex items-center gap-1.5" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Upozorenja ({integer(a.warningTotal)})
        </button>
      }
    >
      <p className="text-sm text-fg-2">
        Upozorenja ne sprječavaju uvoz — opisuju što je pri preslikavanju ispravljeno ili izostavljeno. Prikazano je prvih {Math.min(200, a.warnings.length)}.
      </p>
      {open && (
        <>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => setCode(null)} className={`rounded px-2 py-0.5 text-xs ${code === null ? 'bg-brand text-white' : 'bg-muted text-fg-2'}`}>
              sve
            </button>
            {byCode.map(([c, n]) => (
              <button key={c} type="button" onClick={() => setCode(c)} className={`rounded px-2 py-0.5 text-xs ${code === c ? 'bg-brand text-white' : 'bg-muted text-fg-2'}`}>
                {c} · {integer(n)}
              </button>
            ))}
          </div>
          <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto scroll-slim pr-1">
            {shown.map((w, i) => {
              const L = LEVEL[w.level];
              return (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <L.icon className={`mt-0.5 size-3.5 shrink-0 ${w.level === 'warn' ? 'text-warn' : w.level === 'error' ? 'text-bad-strong' : 'text-info'}`} />
                  <span>{w.message}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}

function Samples({ a }: { a: Analysis }) {
  const s = a.samples;
  if (!s.items.length && !s.invoices.length && !s.contracts.length) return null;
  return (
    <Card title="Primjer preslikavanja" padded={false}>
      <div className="space-y-4 p-4">
        {s.items.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-fg-2">Uređaji</h3>
            <TableWrap>
              <table className="data-table compact">
                <thead><tr><th>Serijski</th><th>Model</th><th>Status</th><th>Vrsta statusa</th><th>Kupac</th><th className="num">Nabavna</th></tr></thead>
                <tbody>
                  {s.items.map((i) => (
                    <tr key={i.serial}><td className="font-mono text-sm">{i.serial}</td><td>{i.model}</td><td>{i.status}</td><td>{i.state}</td><td>{i.partner ?? '—'}</td><td className="num">{amount(i.cost)}</td></tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
        )}
        {s.invoices.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-fg-2">Računi (najnoviji) — iznosi preračunati pravilima ove aplikacije</h3>
            <TableWrap>
              <table className="data-table compact">
                <thead><tr><th>Broj</th><th>Datum</th><th>Vrsta</th><th>Kupac</th><th className="num">Stavki</th><th className="num">Ukupno</th><th className="num">Plaćeno</th><th className="num">Otvoreno</th></tr></thead>
                <tbody>
                  {s.invoices.map((i, k) => (
                    <tr key={k}>
                      <td>{i.number ?? <Badge>nacrt</Badge>}</td><td>{date(i.date)}</td><td>{i.kind} · {i.type}</td><td>{i.partner}</td>
                      <td className="num">{i.lines}</td><td className="num">{amount(i.total)}</td><td className="num">{amount(i.paid)}</td><td className="num">{amount(i.open)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
        )}
        {s.contracts.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-fg-2">Ugovori i plan naplate</h3>
            <TableWrap>
              <table className="data-table compact">
                <thead><tr><th>Broj</th><th>Najmoprimac</th><th>Status</th><th className="num">Uređaja</th><th>Plan (prvi uređaji)</th></tr></thead>
                <tbody>
                  {s.contracts.map((c) => (
                    <tr key={c.number}><td>{c.number}</td><td>{c.partner}</td><td>{c.status}</td><td className="num">{c.devices}</td><td className="text-sm">{c.plans.join(' · ') || '—'}</td></tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </div>
        )}
      </div>
    </Card>
  );
}
