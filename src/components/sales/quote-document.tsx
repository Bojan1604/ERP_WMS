import { DocumentShell, DocTable, DocTotals, type DocCompany, type DocParty } from '@/components/doc/document';
import { documentTotals } from '@/domain/invoice';
import { formatDate, toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { amount, decimal } from '@/lib/format';
import type { QuoteDetail } from '@/server/queries/sales';

export interface QuoteDocData {
  number: string;
  date: string;
  validUntil: string | null;
  vatRate: number;
  discountPct: number;
  discountAmount: number;
  hideSerials: boolean;
  note: string | null;
  createdBy: string | null;
  lines: Array<{ description: string; serial: string | null; code: string | null; unit: string; qty: number; unitPrice: number; discountPct: number }>;
}

/**
 * Ponuda za ispis. Uz „bez serijskih brojeva" iste stavke (šifra, opis, cijena,
 * popust) spajaju se u jedan redak sa zbrojenom količinom.
 */
export function QuoteDocument({ q, company, party }: { q: QuoteDocData; company: DocCompany; party: DocParty }) {
  const rows = q.hideSerials ? groupLines(q.lines) : q.lines.map((l) => ({ ...l, serials: l.serial ? [l.serial] : [] }));
  const t = documentTotals({ lines: q.lines, vatRate: q.vatRate, discountPct: q.discountPct, discountAmount: q.discountAmount });
  const hasCode = rows.some((l) => l.code);
  const hasDisc = rows.some((l) => l.discountPct);
  const head = ['#', ...(hasCode ? ['Šifra'] : []), 'Opis', 'Jed.', 'Kol.', 'Cijena', ...(hasDisc ? ['Pop. %'] : []), 'Iznos'];
  const align = head.map((h) => (['Kol.', 'Cijena', 'Pop. %', 'Iznos'].includes(h) ? 'right' : 'left')) as Array<'left' | 'right'>;
  const totals: Array<[string, React.ReactNode, boolean?]> = [];
  if (t.discount) totals.push(['Iznos stavki', amount(t.linesNet)], ['Popust', amount(-t.discount)]);
  totals.push(['Osnovica', amount(t.net)], [`PDV ${decimal(q.vatRate)} %`, amount(t.vat)], ['Ukupno (€)', amount(t.total), true]);

  return (
    <DocumentShell
      company={company}
      title="Ponuda"
      number={q.number}
      meta={[
        ['Datum', formatDate(q.date)],
        ['Vrijedi do', q.validUntil ? formatDate(q.validUntil) : '—'],
        ...(q.createdBy ? ([['Izradio', q.createdBy]] as Array<[string, string]>) : []),
      ]}
      party={party}
      footer={<p>Ponuda nije račun. Cijene su u eurima; PDV je iskazan zasebno.</p>}
    >
      <DocTable
        head={head}
        align={align}
        rows={rows.map((l, i) => [
          i + 1,
          ...(hasCode ? [l.code ?? ''] : []),
          <div key="d">
            {l.description}
            {!q.hideSerials && l.serials.length > 0 && <div className="font-mono text-[10.5px] text-black/60">SN: {l.serials.join(', ')}</div>}
          </div>,
          l.unit,
          decimal(l.qty),
          amount(l.unitPrice),
          ...(hasDisc ? [l.discountPct ? decimal(l.discountPct) : ''] : []),
          amount(r2(l.qty * l.unitPrice * (1 - l.discountPct / 100))),
        ])}
      />
      <DocTotals rows={totals} />
      {q.validUntil && (
        <p className="mt-4">
          Ponuda vrijedi do <b>{formatDate(q.validUntil)}</b>.
        </p>
      )}
      {q.note && <p className="mt-3 whitespace-pre-line">{q.note}</p>}
    </DocumentShell>
  );
}

function groupLines(lines: QuoteDocData['lines']) {
  const out: Array<QuoteDocData['lines'][number] & { serials: string[] }> = [];
  const idx = new Map<string, number>();
  for (const l of lines) {
    const key = [l.code ?? '', l.description, l.unitPrice, l.discountPct, l.unit].join('|');
    const i = idx.get(key);
    if (i === undefined) {
      idx.set(key, out.length);
      out.push({ ...l, serials: l.serial ? [l.serial] : [] });
    } else {
      out[i].qty += l.qty;
      if (l.serial) out[i].serials.push(l.serial);
    }
  }
  return out;
}

/** Zapis ponude iz baze → podaci za ispis. */
export function quoteDocData(q: QuoteDetail): QuoteDocData {
  return {
    number: q.number,
    date: toISO(q.date),
    validUntil: q.validUntil ? toISO(q.validUntil) : null,
    vatRate: num(q.vatRate),
    discountPct: num(q.discountPct),
    discountAmount: num(q.discountAmount),
    hideSerials: q.hideSerials,
    note: q.note,
    createdBy: q.createdBy,
    lines: q.lines.map((l) => ({
      description: l.description,
      serial: l.item?.serial ?? null,
      code: l.model?.code ?? null,
      unit: l.unit,
      qty: num(l.qty),
      unitPrice: num(l.unitPrice),
      discountPct: num(l.discountPct),
    })),
  };
}
