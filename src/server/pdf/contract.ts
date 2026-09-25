import 'server-only';
import type { TableCell } from 'pdfmake/interfaces';
import { db } from '../db';
import { DomainError } from '../errors';
import { toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { warrantyEnd } from '@/domain/pricing';
import { loadPdfCompany } from './company';
import { amt, documentDefinition, fmtDate, GREY, itemsTable, pdfFileName, sums } from './layout';

const BILLING: Record<string, string> = { MONTHLY: 'mjesečno', QUARTERLY: 'tromjesečno', SEMIANNUAL: 'polugodišnje', ANNUAL: 'godišnje', ONCE: 'jednokratno' };
const STATUS: Record<string, string> = { ACTIVE: 'aktivan', PAUSED: 'pauziran', TERMINATED: 'raskinut', EXPIRED: 'istekao' };

/** Popis uređaja na ugovoru o najmu (za klijenta): model, serijski broj, od kada, mjesečni iznos, jamstvo. */
export async function renderContractListDefinition(companyId: string, id: string) {
  const [contract, c] = await Promise.all([
    db.contract.findFirst({
      where: { id, companyId },
      include: {
        partner: true,
        items: {
          orderBy: [{ item: { model: { name: 'asc' } } }, { item: { serial: 'asc' } }],
          select: {
            monthly: true,
            status: true,
            addedAt: true,
            item: {
              select: {
                serial: true,
                issueDate: true,
                warrantyStart: true,
                warrantyMonths: true,
                model: { select: { brand: true, name: true, code: true, warrantyMonths: true } },
              },
            },
          },
        },
      },
    }),
    loadPdfCompany(companyId),
  ]);
  if (!contract) throw new DomainError('Ugovor ne postoji.');
  const monthly = r2(contract.items.reduce((a, i) => a + num(i.monthly), 0));
  const season = contract.seasonFrom && contract.seasonTo ? `${contract.seasonFrom}.–${contract.seasonTo}. mj.` : null;
  const def = documentDefinition({
    company: c.doc,
    title: 'Popis uređaja',
    number: contract.number,
    docTitle: `Popis uređaja — ugovor ${contract.number}`,
    party: contract.partner,
    partyLabel: 'Klijent',
    facts: [
      { k: 'Ugovor', v: contract.number },
      { k: 'Od', v: fmtDate(toISO(contract.startDate)) },
      contract.endDate ? { k: 'Do', v: fmtDate(toISO(contract.endDate)) } : null,
      { k: 'Naplata', v: BILLING[contract.billing] ?? contract.billing },
      season ? { k: 'Sezona', v: season } : null,
      { k: 'Stanje na dan', v: fmtDate(toISO(new Date())) },
    ],
    body: [
      itemsTable({
        widths: [14, '*', 110, 56, 62, 60],
        head: ['#', 'Uređaj', 'Serijski broj', 'Od', 'Jamstvo do', 'Mjesečno'],
        right: [5],
        rows: contract.items.map((ci, i) => {
          const it = ci.item;
          const start = it.warrantyStart ?? it.issueDate;
          const wEnd = warrantyEnd(start ? toISO(start) : null, it.warrantyMonths ?? it.model.warrantyMonths);
          return [
            { text: String(i + 1), color: GREY },
            { stack: [[it.model.brand, it.model.name].filter(Boolean).join(' '), ...(ci.status && ci.status !== 'ACTIVE' ? [{ text: STATUS[ci.status] ?? ci.status, fontSize: 7.5, color: GREY }] : [])] },
            { text: it.serial, bold: true },
            fmtDate(toISO(it.issueDate ?? ci.addedAt)),
            wEnd ? fmtDate(wEnd) : '—',
            { text: amt(num(ci.monthly)), noWrap: true },
          ] as TableCell[];
        }),
      }),
      sums(
        [
          { k: 'Uređaja', v: String(contract.items.length) },
          { k: 'Ukupno mjesečno (EUR, bez PDV-a)', v: amt(monthly), strong: true },
        ],
        [contract.note],
      ),
    ],
    footer: 'Popis je izrađen iz evidencije na dan ispisa i služi za pregled opreme kod klijenta.',
  });
  return { def, fileName: pdfFileName('Popis-uredaja', contract.number, contract.id) };
}
