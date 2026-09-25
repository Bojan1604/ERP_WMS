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
  /** Pravni podaci (sud, MBS, temeljni kapital) u podnožju svih dokumenata. */
  legalFooter?: string | null;
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
    <article className="print-area mx-auto max-w-[210mm] bg-white p-[14mm] text-[12px] max-sm:p-4 leading-[1.45] text-black shadow-[var(--shadow-panel)] print:text-[11px] print:leading-[1.35]">
      <header className="flex items-start justify-between gap-6 border-b border-black/20 pb-4 max-sm:flex-col max-sm:gap-3 print:flex-row print:pb-2 print:leading-[1.25]">
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
        <div className="shrink-0 text-right max-sm:text-left">
          <p className="text-[18px] font-bold uppercase tracking-wide print:text-[16px]">{title}</p>
          {number && <p className="text-[14px] font-semibold">br. {number}</p>}
          {meta && (
            <table className="ml-auto mt-2 text-[11px] max-sm:ml-0 print:ml-auto print:mt-1 print:text-[10px]">
              <tbody>
                {meta.map(([k, v]) => (
                  <tr key={k}>
                    <td className="pr-3 text-black/60">{k}</td>
                    <td className="text-right font-medium max-sm:text-left">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </header>

      {party && (
        <section className="mt-4 w-[55%] rounded border max-sm:w-full border-black/15 p-3 print:mt-2.5 print:w-[55%] print:px-3 print:py-1.5 print:leading-[1.3]">
          <p className="text-[10px] uppercase tracking-wider text-black/50">{partyLabel}</p>
          <p className="text-[13px] font-semibold">{party.name}</p>
          <p>{party.address}</p>
          <p>{[[party.zip, party.city].filter(Boolean).join(' '), party.country && party.country !== 'HR' ? party.country : null].filter(Boolean).join(', ')}</p>
          {(party.oib || party.vatId) && <p>{[party.oib && `OIB: ${party.oib}`, party.vatId && `PDV ID: ${party.vatId}`].filter(Boolean).join(' · ')}</p>}
        </section>
      )}

      <div className="mt-5 print:mt-3">{children}</div>

      {signatures && (
        <div className="mt-14 grid grid-cols-2 gap-16 max-sm:gap-6 print:mt-10 print:break-inside-avoid">
          {signatures.map((s) => (
            <div key={s} className="border-t border-black/40 pt-1 text-center text-[11px] text-black/60">
              {s}
            </div>
          ))}
        </div>
      )}

      <footer className="mt-8 border-t border-black/15 pt-2 text-[10px] text-black/55 print:mt-4 print:break-inside-avoid print:text-[9px]">
        {footer}
        {company.invoiceFooter && <p className="mt-1">{company.invoiceFooter}</p>}
        {company.legalFooter?.trim() && <p className="mt-1 text-[9.5px]">{company.legalFooter}</p>}
      </footer>
    </article>
  );
}

/** Tablica stavki dokumenta. */
export function DocTable({ head, rows, align }: { head: string[]; rows: ReactNode[][]; align?: Array<'left' | 'right' | 'center'> }) {
  return (
    // na mobitelu tablica klizi vodoravno umjesto da gura stranicu; ispis je nepromijenjen
    <div className="overflow-x-auto scroll-slim print:overflow-visible">
      <table className="w-full border-collapse text-[11.5px] max-sm:min-w-[34rem] print:min-w-0 print:text-[10.5px] print:leading-[1.25]">
        <thead>
          <tr className="border-y border-black/30 bg-black/[0.04]">
            {head.map((h, i) => (
              <th key={h + i} className="px-1.5 py-1.5 font-semibold print:py-1" style={{ textAlign: align?.[i] ?? 'left' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-black/10 align-top print:break-inside-avoid">
              {r.map((c, ci) => (
                <td key={ci} className="px-1.5 py-1.5 print:py-[2px]" style={{ textAlign: align?.[ci] ?? 'left' }}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocTotals({ rows }: { rows: Array<[string, ReactNode, boolean?]> }) {
  return (
    <table className="ml-auto mt-3 min-w-[45%] text-[12px] print:mt-2 print:break-inside-avoid print:text-[11px]">
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
