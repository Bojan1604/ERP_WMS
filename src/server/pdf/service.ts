import 'server-only';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { deviceWarrantyEnd, getServiceOrder } from '../queries/service';
import { DomainError } from '../errors';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { SERVICE_STATUS } from '@/components/service/labels';
import { loadPdfCompany, type LoadedCompany } from './company';
import { amt, documentDefinition, fmtDate, itemsTable, pdfFileName, section } from './layout';

type Order = NonNullable<Awaited<ReturnType<typeof getServiceOrder>>>;

const model = (m: { brand: string | null; name: string }) => [m.brand, m.name].filter(Boolean).join(' ');

/**
 * Servisni nalog (zaprimanje, potpis klijenta pri predaji) ili nalog za
 * dostavu (povrat klijentu: rješenje, zamjenski uređaj; dijagnoza i poduzeto su interni) —
 * isti sadržaj kao /servis/[id]/ispis.
 */
export function serviceDefinition(o: Order, c: LoadedCompany, delivery: boolean): TDocumentDefinitions {
  const item = o.item;
  const wEnd = item ? deviceWarrantyEnd(item) : null;
  const rows: TableCell[][] = [
    [item ? model(item.model) : '—', { text: o.serial ?? '—', bold: true }, o.underWarranty ? `da${wEnd ? ` (do ${fmtDate(wEnd)})` : ''}` : 'ne', delivery && o.replacement ? 'zamijenjen' : ''],
  ];
  if (delivery && o.replacement) rows.push([model(o.replacement.model), { text: o.replacement.serial, bold: true }, 'nastavlja jamstvo izvornog', 'zamjenski uređaj']);
  const cost = num(o.cost);
  return documentDefinition({
    company: c.doc,
    title: delivery ? 'Nalog za dostavu' : 'Servisni nalog',
    number: o.number,
    party: o.partner,
    partyLabel: 'Klijent',
    issuerNote: o.createdBy ? `Zaprimio: ${o.createdBy}` : null,
    facts: [
      { k: 'Prijavljeno', v: fmtDate(toISO(o.reportedAt)) },
      o.receivedAt ? { k: 'Zaprimljeno', v: fmtDate(toISO(o.receivedAt)) } : null,
      delivery && o.closedAt ? { k: 'Zatvoreno', v: fmtDate(toISO(o.closedAt)) } : null,
      { k: 'Status', v: SERVICE_STATUS[o.status].label },
      o.invoice?.number ? { k: 'Račun', v: o.invoice.number } : null,
      o.contact ? { k: 'Kontakt', v: o.contact } : null,
    ],
    body: [
      itemsTable({ widths: ['*', 120, 120, 80], head: ['Uređaj', 'Serijski broj', 'Jamstvo', ''], rows }),
      section('Opis kvara', o.issue),
      ...(delivery ? [section('Rješenje', o.solution)] : []),
      section('Poruka klijentu', o.publicNote),
      !o.underWarranty && cost > 0 ? ({ text: `Trošak popravka (izvan jamstva): ${amt(cost)} EUR + PDV`, bold: true, margin: [0, 12, 0, 0] } as Content) : null,
      !delivery
        ? ({
            text: 'Potpisom klijent potvrđuje predaju uređaja u stanju opisanom na ovom nalogu. Popravci izvan jamstva naplaćuju se nakon prihvaćene ponude.',
            fontSize: 8,
            color: '#555',
            margin: [0, 14, 0, 0],
          } as Content)
        : null,
    ],
    signatures: delivery ? ['Uređaj predao', 'Uređaj preuzeo (klijent)'] : ['Uređaj predao (klijent)', 'Uređaj zaprimio'],
  });
}

export async function renderServiceDefinition(companyId: string, id: string, delivery: boolean) {
  const [o, c] = await Promise.all([getServiceOrder(companyId, id), loadPdfCompany(companyId)]);
  if (!o) throw new DomainError('Servisni nalog ne postoji.');
  return { def: serviceDefinition(o, c, delivery), fileName: pdfFileName(delivery ? 'Nalog-za-dostavu' : 'Servisni-nalog', o.number, o.id) };
}
