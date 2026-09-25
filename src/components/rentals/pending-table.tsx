'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Ban, Eye, FileCheck2, FilePen, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/misc';
import { useAction } from '@/components/ui/action';
import { periodLabel, today } from '@/domain/dates';
import { r2 } from '@/domain/money';
import { date, eur } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { PendingRow } from '@/server/queries/rentals';
import { issueInstallmentsAction, previewInstallmentAction, skipInstallmentAction } from '@/app/(app)/najam/rate/actions';

type Ask = null | { kind: 'issue' | 'paid' | 'skip' };

/**
 * Rate koje čekaju izdavanje: označavanje i izdavanje odjednom (jedna
 * transakcija), „Ne izdaji — već izdano" i „Pregledaj" (nacrt u Prodaji).
 */
export function PendingTable({ rows, showContract = true, canIssue, canEdit }: { rows: PendingRow[]; showContract?: boolean; canIssue: boolean; canEdit: boolean }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [ask, setAsk] = useState<Ask>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const done = () => {
    setAsk(null);
    setSel(new Set());
  };
  const issue = useAction(issueInstallmentsAction, { onSuccess: done });
  const skip = useAction(skipInstallmentAction, { onSuccess: done });
  const preview = useAction(previewInstallmentAction, { refresh: false });

  const picked = useMemo(() => rows.filter((r) => sel.has(r.key)), [rows, sel]);
  const total = r2(picked.reduce((a, r) => a + r.amount, 0));
  const all = rows.length > 0 && sel.size === rows.length;
  const now = today();
  const toggle = (k: string) =>
    setSel((p) => {
      const n = new Set(p);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const confirmRun = () => {
    if (!ask) return;
    if (ask.kind === 'skip') skip.run({ rows: picked.map((r) => ({ contractId: r.contractId, period: r.period, itemIds: r.itemIds })) });
    else issue.run({ rows: picked.map((r) => ({ contractId: r.contractId, period: r.period })), paid: ask.kind === 'paid' });
  };

  return (
    <div>
      {picked.length > 0 && (
        <div className="no-print sticky top-0 z-20 mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-nav px-3 py-2 text-nav-fg shadow-[var(--shadow-pop)] max-sm:fixed max-sm:inset-x-2 max-sm:top-auto max-sm:bottom-[calc(5.25rem+env(safe-area-inset-bottom))] max-sm:z-30 max-sm:mb-0">
          <span className="mr-1 text-sm">
            Označeno: <b className="text-white">{picked.length}</b> · <b className="text-white">{eur(total)}</b>
          </span>
          {canIssue && (
            <>
              <Button size="sm" variant="primary" icon={<FileCheck2 className="size-3.5" />} onClick={() => setAsk({ kind: 'issue' })}>
                Izdaj označene
              </Button>
              <Button size="sm" icon={<Wallet className="size-3.5" />} onClick={() => setAsk({ kind: 'paid' })}>
                Izdaj označene i označi plaćeno
              </Button>
            </>
          )}
          {canEdit && (
            <Button size="sm" icon={<Ban className="size-3.5" />} onClick={() => setAsk({ kind: 'skip' })}>
              Ne izdaji — već izdano
            </Button>
          )}
          <button type="button" onClick={() => setSel(new Set())} className="ml-auto text-sm text-nav-fg-2 hover:text-white">
            Poništi odabir
          </button>
        </div>
      )}
      <div className="overflow-x-auto scroll-slim rounded-lg bg-panel shadow-[var(--shadow-panel)]">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  type="checkbox"
                  aria-label="Označi sve"
                  checked={all}
                  onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.key)))}
                  className="size-4 align-middle accent-[var(--color-brand)]"
                />
              </th>
              {showContract && <th>Ugovor</th>}
              {showContract && <th>Klijent</th>}
              <th>Razdoblje</th>
              <th>Datum računa</th>
              <th className="num">Uređaja</th>
              <th className="num">Iznos (neto)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-selected={sel.has(r.key)}>
                <td>
                  <input type="checkbox" aria-label={`Označi ${r.contractNumber} ${r.period}`} checked={sel.has(r.key)} onChange={() => toggle(r.key)} className="size-4 align-middle accent-[var(--color-brand)]" />
                </td>
                {showContract && (
                  <td>
                    <Link prefetch={false} href={`/najam/ugovori/${r.contractId}`} className="link font-medium">
                      {r.contractNumber}
                    </Link>
                  </td>
                )}
                {showContract && <td className="max-w-64 truncate">{r.partner?.name}</td>}
                <td className="capitalize">{periodLabel(r.period)}</td>
                <td>
                  <span className={cn(r.dueDate < now && 'text-warn')}>{date(r.dueDate)}</span>
                </td>
                <td className="num">{r.itemIds.length}</td>
                <td className="num font-medium" title={r.draftId ? 'Iznos postojećeg nacrta računa' : undefined}>
                  {eur(r.amount)}
                </td>
                <td className="num">
                  {r.draftId ? (
                    <Link prefetch={false} href={`/prodaja/racuni/${r.draftId}`} className="inline-flex items-center gap-1 text-sm link">
                      <FilePen className="size-3.5" /> Nacrt postoji
                    </Link>
                  ) : (
                    canIssue && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Eye className="size-3.5" />}
                        loading={preview.pending && previewing === r.key}
                        onClick={() => {
                          setPreviewing(r.key);
                          preview.run({ contractId: r.contractId, period: r.period });
                        }}
                      >
                        Pregledaj
                      </Button>
                    )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr>
                <td />
                <td colSpan={showContract ? 4 : 2}>Ukupno {rows.length} rata</td>
                <td className="num">{rows.reduce((a, r) => a + r.itemIds.length, 0)}</td>
                <td className="num">{eur(r2(rows.reduce((a, r) => a + r.amount, 0)))}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {/* mjesto za traku označenih koja na mobitelu stoji iznad donjeg izbornika */}
      {picked.length > 0 && <div aria-hidden className="h-32 sm:hidden" />}

      <Dialog
        open={ask !== null}
        onClose={() => setAsk(null)}
        title={ask?.kind === 'skip' ? 'Ne izdaji — već izdano' : ask?.kind === 'paid' ? 'Izdaj i označi plaćeno' : 'Izdaj označene rate'}
        size="sm"
        footer={
          <>
            <Button onClick={() => setAsk(null)}>Odustani</Button>
            <Button variant="primary" loading={issue.pending || skip.pending} onClick={confirmRun}>
              {ask?.kind === 'skip' ? 'Makni s popisa' : `Izdaj ${picked.length} računa`}
            </Button>
          </>
        }
      >
        {ask?.kind === 'skip' ? (
          <p className="text-base text-fg-2">
            {picked.length} rata ({eur(total)}) trajno se miče s popisa bez izrade računa — koristite kad su računi izdani izvan programa.
          </p>
        ) : (
          <div className="space-y-2 text-base text-fg-2">
            <p>
              Izdaje se <b className="text-fg">{picked.length}</b> računa za najam, ukupno <b className="text-fg">{eur(total)}</b> neto (+ PDV), u jednoj
              transakciji i kronološkim redoslijedom brojeva.
            </p>
            {ask?.kind === 'paid' && <p>Svi računi odmah se označavaju kao plaćeni na datum računa.</p>}
            {picked.some((r) => r.draftId) && (
              <p className="text-sm">Postojeći nacrti za ta razdoblja izdaju se takvi kakvi jesu (iznos nacrta) — za nove uvjete obrišite nacrt u Prodaji.</p>
            )}
            <div className="flex flex-wrap gap-1">
              {picked.slice(0, 12).map((r) => (
                <Badge key={r.key}>
                  {r.contractNumber} · {periodLabel(r.period)}
                </Badge>
              ))}
              {picked.length > 12 && <Badge>+{picked.length - 12}</Badge>}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
