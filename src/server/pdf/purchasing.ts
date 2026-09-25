import 'server-only';
import type { TableCell } from 'pdfmake/interfaces';
import { getOrder, getReceipt } from '../queries/purchasing';
import { DomainError } from '../errors';
import { toISO } from '@/domain/dates';
import { num, r2 } from '@/domain/money';
import { loadPdfCompany } from './company';
import { amt, documentDefinition, fmtDate, GREY, itemsTable, pdfFileName, sums } from './layout';

const ORDER_STATUS: Record<string, string> = { DRAFT: 'Nacrt', ORDERED: 'Naručena', PARTIAL: 'Djelomično zaprimljena', RECEIVED: 'Zaprimljena', CANCELLED: 'Otkazana' };

/** Narudžbenica dobavljaču (kao /nabava/narudzbenice/[id]/ispis). */
export async function renderOrderDefinition(companyId: string, id: string) {
  const [order, c] = await Promise.all([getOrder(companyId, id), loadPdfCompany(companyId)]);
  if (!order) throw new DomainError('Narudžbenica ne postoji.');
  const def = documentDefinition({
    company: c.doc,
    title: 'Narudžbenica',
    number: order.number,
    party: order.supplier,
    partyLabel: 'Dobavljač',
    issuerNote: order.createdBy ? `Naručio: ${order.createdBy}` : null,
    facts: [
      { k: 'Datum', v: fmtDate(toISO(order.date)) },
      order.expectedDate ? { k: 'Očekivana isporuka', v: fmtDate(toISO(order.expectedDate)) } : null,
      ORDER_STATUS[order.status] ? { k: 'Status', v: ORDER_STATUS[order.status] } : null,
    ],
    body: [
      itemsTable({
        widths: [26, 60, '*', 44, 64, 70],
        head: ['R. br.', 'Šifra', 'Naziv', 'Kol.', 'Jed. cijena', 'Iznos'],
        right: [3, 4, 5],
        rows: order.lines.map((l, i) => [
          { text: `${i + 1}.`, color: GREY },
          { text: l.model.code ?? '', fontSize: 7.5 },
          [l.model.brand, l.model.name].filter(Boolean).join(' '),
          `${l.qty} kom`,
          { text: amt(num(l.unitCost)), noWrap: true },
          { text: amt(r2(l.qty * num(l.unitCost))), noWrap: true },
        ]) as TableCell[][],
      }),
      sums([{ k: 'Ukupno bez PDV-a (EUR)', v: amt(num(order.total)), strong: true }], [order.note]),
    ],
    signatures: ['Naručio', 'Odobrio'],
    footer: `Molimo potvrdu narudžbe i rok isporuke. Na računu navedite broj narudžbenice ${order.number}.`,
  });
  return { def, fileName: pdfFileName('Narudzbenica', order.number, order.id) };
}

/** Primka (kao /nabava/primke/[id]); nabavne cijene samo uz pravo `costs`. */
export async function renderReceiptDefinition(companyId: string, id: string, showCost: boolean) {
  const [data, c] = await Promise.all([getReceipt(companyId, id), loadPdfCompany(companyId)]);
  if (!data) throw new DomainError('Primka ne postoji.');
  const { receipt, groups, count } = data;
  const cancelled = receipt.status === 'CANCELLED';
  const def = documentDefinition({
    company: c.doc,
    title: cancelled ? 'Primka — stornirana' : 'Primka',
    number: receipt.number,
    party: receipt.supplier,
    partyLabel: 'Dobavljač',
    issuerNote: receipt.createdBy ? `Upisao: ${receipt.createdBy}` : null,
    facts: [
      { k: 'Datum', v: fmtDate(toISO(receipt.date)) },
      { k: 'Skladište', v: receipt.warehouse.name },
      receipt.order ? { k: 'Narudžbenica', v: receipt.order.number } : null,
      receipt.supplierDocNumber ? { k: 'Dokument dobavljača', v: receipt.supplierDocNumber } : null,
      { k: 'Komada', v: String(count) },
    ],
    body: [
      itemsTable({
        widths: showCost ? [26, 110, '*', 40, 56, 62] : [26, 130, '*', 44],
        head: ['R. br.', 'Artikl', 'Serijski brojevi', 'Kol.', ...(showCost ? ['Nabavna', 'Iznos'] : [])],
        right: showCost ? [3, 4, 5] : [3],
        rows: groups.map((g, i) => [
          { text: `${i + 1}.`, color: GREY },
          { stack: [{ text: g.model, bold: true }, ...(g.code ? [{ text: g.code, fontSize: 7.5, color: GREY }] : [])] },
          { text: g.serials.join(', '), fontSize: 7.5 },
          `${g.qty} kom`,
          ...(showCost ? [{ text: amt(g.unitCost), noWrap: true }, { text: amt(g.total), noWrap: true }] : []),
        ]) as TableCell[][],
      }),
      sums(
        [{ k: 'Količina', v: `${count} kom`, strong: !showCost }, showCost ? { k: 'Ukupno nabavna vrijednost (EUR)', v: amt(num(receipt.total)), strong: true } : null],
        [receipt.note, !groups.length ? `Na primci nema uređaja${cancelled ? ' — obrisani su stornom.' : '.'}` : null],
      ),
    ],
    signatures: ['Robu predao', 'Robu zaprimio'],
    footer: 'Primka je interni dokument o ulazu robe na skladište. Dokument je izrađen elektroničkim putem.',
  });
  return { def, fileName: pdfFileName('Primka', receipt.number, receipt.id) };
}
