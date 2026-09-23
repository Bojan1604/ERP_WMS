import type { ReactNode } from 'react';
import { formatDate } from '@/domain/dates';

export interface DocCompany {
  name: string;
  oib?: string | null;
  vatId?: string | null;
  address?: string | null;
  zip?: string | null;
  city?: string | null;
  iban?: string | null;
  bank?: string | null;
  email?: string | null;
  phone?: string | null;
  web?: string | null;
  logo?: string | null;
  invoiceFooter?: string | null;
}

export interface DocParty {
  name: string;
  oib?: string | null;
  vatId?: string | null;
  address?: string | null;
  zip?: string | null;
  city?: string | null;
  country?: string | null;
}

/**
 * Kostur A4 dokumenta (račun, ponuda, otpremnica, narudžbenica, međuskladišnica):
 * zaglavlje firme, naslov s brojem, stranke, sadržaj i podnožje. Na ekranu je
 * list papira, pri ispisu ide samo on (klasa print-area).
 */
export function DocumentShell({
  company,
  title,
  number,
  meta,
  party,
  partyLabel = 'Kupac',
  children,
  footer,
  signatures,
}: {
  company: DocCompany;
  title: string;
  number?: string | null;
  meta?: Array<[string, ReactNode]>;
  party?: DocParty | null;
  partyLabel?: string;
  children: ReactNode;
  footer?: ReactNode;
  signatures?: string[];
}) {
  return (
    <article className="print-area mx-auto max-w-[210mm] bg-white p-[14mm] text-[12px] leading-[1.45] text-black shadow-[var(--shadow-panel)]">
      <header className="flex items-start justify-between gap-6 border-b border-black/20 pb-4">
        <div className="min-w-0">
          {company.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={company.logo} alt="" className="mb-2 max-h-14 max-w-48 object-contain" />
          ) : (
            <p className="text-[16px] font-bold">{company.name}</p>
          )}
          {company.logo && <p className="font-semibold">{company.name}</p>}
          <p>{[company.address, [company.zip, company.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')}</p>
          <p>
            {company.oib && <>OIB: {company.oib}</>}
            {company.vatId && <> · PDV ID: {company.vatId}</>}
          </p>
          {company.iban && (
            <p>
              IBAN: {company.iban}
              {company.bank && <> ({company.bank})</>}
            </p>
          )}
          <p className="text-black/60">{[company.email, company.phone, company.web].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[18px] font-bold uppercase tracking-wide">{title}</p>
          {number && <p className="text-[14px] font-semibold">br. {number}</p>}
          {meta && (
            <table className="ml-auto mt-2 text-[11px]">
              <tbody>
                {meta.map(([k, v]) => (
                  <tr key={k}>
                    <td className="pr-3 text-black/60">{k}</td>
                    <td className="text-right font-medium">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </header>

      {party && (
        <section className="mt-4 w-[55%] rounded border border-black/15 p-3">
          <p className="text-[10px] uppercase tracking-wider text-black/50">{partyLabel}</p>
          <p className="text-[13px] font-semibold">{party.name}</p>
          <p>{party.address}</p>
          <p>{[[party.zip, party.city].filter(Boolean).join(' '), party.country && party.country !== 'HR' ? party.country : null].filter(Boolean).join(', ')}</p>
          {(party.oib || party.vatId) && <p>{[party.oib && `OIB: ${party.oib}`, party.vatId && `PDV ID: ${party.vatId}`].filter(Boolean).join(' · ')}</p>}
        </section>
      )}

      <div className="mt-5">{children}</div>

      {signatures && (
        <div className="mt-14 grid grid-cols-2 gap-16">
          {signatures.map((s) => (
            <div key={s} className="border-t border-black/40 pt-1 text-center text-[11px] text-black/60">
              {s}
            </div>
          ))}
        </div>
      )}

      <footer className="mt-8 border-t border-black/15 pt-2 text-[10px] text-black/55">
        {footer}
        {company.invoiceFooter && <p className="mt-1">{company.invoiceFooter}</p>}
      </footer>
    </article>
  );
}

/** Tablica stavki dokumenta. */
export function DocTable({ head, rows, align }: { head: string[]; rows: ReactNode[][]; align?: Array<'left' | 'right' | 'center'> }) {
  return (
    <table className="w-full border-collapse text-[11.5px]">
      <thead>
        <tr className="border-y border-black/30 bg-black/[0.04]">
          {head.map((h, i) => (
            <th key={h + i} className="px-1.5 py-1.5 font-semibold" style={{ textAlign: align?.[i] ?? 'left' }}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-black/10 align-top">
            {r.map((c, ci) => (
              <td key={ci} className="px-1.5 py-1.5" style={{ textAlign: align?.[ci] ?? 'left' }}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DocTotals({ rows }: { rows: Array<[string, ReactNode, boolean?]> }) {
  return (
    <table className="ml-auto mt-3 min-w-[45%] text-[12px]">
      <tbody>
        {rows.map(([k, v, strong]) => (
          <tr key={k} className={strong ? 'border-t border-black/40 text-[13.5px] font-bold' : ''}>
            <td className="py-0.5 pr-6">{k}</td>
            <td className="py-0.5 text-right tnum">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const docDate = formatDate;
