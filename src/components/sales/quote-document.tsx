import { DocumentShell, DocTable, DocTotals, type DocCompany, type DocParty } from '@/components/doc/document';
import { documentTotals } from '@/domain/invoice';
import { formatDate, toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { amount, decimal } from '@/lib/format';
import { proformaReference } from '@/domain/sales-lines';
import type { QuoteDetail } from '@/server/queries/sales';

export interface QuoteDocData {
  id: string;
  kind: 'QUOTE' | 'PROFORMA';
  number: string;
  date: string;
  validUntil: string | null;
  vatRate: number;
  discountPct: number;
  discountAmount: number;
  hideSerials: boolean;
  note: string | null;
  createdBy: string | null;
  lines: Array<{ description: string; serial: string | null; code: string | null; unit: string; qty: number; unitPrice: number; discountPct: number; rent?: boolean }>;
}

/**
 * Ponuda za ispis. Uz „bez serijskih brojeva" iste stavke (šifra, opis, cijena,
 * popust) spajaju se u jedan redak sa zbrojenom količinom.
 */
export function QuoteDocument({
  q,
  company,
  party,
  title = 'Ponuda',
}: {
  q: QuoteDocData;
  company: DocCompany & { paymentModel?: string | null; swift?: string | null };
  party: DocParty;
  /** Naslov dokumenta (predračun: iz postavki firme). */
  title?: string;
}) {
  const proforma = q.kind === 'PROFORMA';
  // isti uređaji (model, cijena) uvijek jedna stavka sa serijskima ispod (kao račun); „bez serijskih" spaja i ostale iste stavke
  const rows = groupLines(q.lines, q.hideSerials);
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
      title={title}
      number={q.number}
      meta={[
        ['Datum', formatDate(q.date)],
        ['Vrijedi do', q.validUntil ? formatDate(q.validUntil) : '—'],
        ...(q.createdBy ? ([['Izradio', q.createdBy]] as Array<[string, string]>) : []),
      ]}
      party={party}
      footer={<p>{proforma ? `${title} nije račun.` : 'Ponuda nije račun.'} Cijene su u eurima; PDV je iskazan zasebno.</p>}
    >
      <DocTable
        head={head}
        align={align}
        rows={rows.map((l, i) => [
          i + 1,
          ...(hasCode ? [l.code ?? ''] : []),
          <div key="d">
            {l.description}
            {l.rent && <span className="text-[10.5px] text-black/60"> (najam, mjesečno)</span>}
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
          {proforma ? title : 'Ponuda'} vrijedi do <b>{formatDate(q.validUntil)}</b>.
        </p>
      )}
      {proforma && t.total > 0 && (
        <section className="mt-5 flex items-end justify-between gap-6 rounded border border-black/15 p-3 max-sm:flex-col max-sm:items-start">
          <div className="text-[11.5px]">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-black/50">Podaci za plaćanje</p>
            <p>
              IBAN: <b>{company.iban ?? '—'}</b>
              {company.swift && (
                <>
                  {' '}
                  · SWIFT/BIC: <b>{company.swift}</b>
                </>
              )}
            </p>
            <p>
              Model i poziv na broj: <b>{company.paymentModel || 'HR00'} {proformaReference(q.number)}</b>
            </p>
            <p>
              Iznos: <b>{amount(t.total)} €</b>
            </p>
          </div>
          {company.iban && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/prodaja/ponude/${q.id}/hub3`} alt="HUB-3 barkod za plaćanje" className="h-[26mm] w-auto" />
          )}
        </section>
      )}
      {q.note && <p className="mt-3 whitespace-pre-line">{q.note}</p>}
    </DocumentShell>
  );
}

function groupLines(lines: QuoteDocData['lines'], all: boolean) {
  const out: Array<QuoteDocData['lines'][number] & { serials: string[] }> = [];
  const idx = new Map<string, number>();
  for (const l of lines) {
    const key = all || l.serial ? [l.code ?? '', l.description, l.unitPrice, l.discountPct, l.unit, l.rent ? 'R' : ''].join('|') : null;
    const i = key === null ? undefined : idx.get(key);
    if (i === undefined) {
      if (key !== null) idx.set(key, out.length);
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
    id: q.id,
    kind: q.kind,
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
      rent: l.lineType === 'RENT',
    })),
  };
}
