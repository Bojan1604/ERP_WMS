import 'server-only';
import { buildUbl, type UblInput } from '@/domain/ubl';
import type { IncomingDoc } from '@/domain/einvoice-inbound';
import { addDays, today } from '@/domain/dates';

/**
 * Izmišljeni primljeni eRačuni demo posrednika — da se preuzimanje, prihvaćanje
 * i odbijanje mogu isprobati bez mreže. Id-evi su stalni, pa ponovni dohvat ne
 * stvara duplikate. Prvi dobavljač ima OIB demo partnera iz početnih podataka,
 * drugi je nov (otvara se kao partner).
 */

/** Najmanji ispravan PDF s jednim retkom teksta (ugrađeni prilog eRačuna). */
export function tinyPdf(line: string): string {
  const safe = line.replace(/[()\\]/g, ' ').replace(/[^\x20-\x7e]/g, '?');
  const stream = `BT /F1 14 Tf 60 780 Td (${safe}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/** Umeće AdditionalDocumentReference s ugrađenim PDF-om (ide ispred AccountingSupplierParty). */
export function embedPdf(xml: string, fileName: string, pdf: string): string {
  const b64 = Buffer.from(pdf, 'latin1').toString('base64');
  const ref = `  <cac:AdditionalDocumentReference>
    <cbc:ID>${fileName}</cbc:ID>
    <cbc:DocumentDescription>Vizualizacija računa</cbc:DocumentDescription>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="${fileName}">${b64}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
`;
  return xml.replace('  <cac:AccountingSupplierParty>', `${ref}  <cac:AccountingSupplierParty>`);
}

const BUYER = { name: 'Demo Oprema d.o.o.', oib: '12345678903', address: 'Ilica 1', zip: '10000', city: 'Zagreb', country: 'HR' };

export function demoIncoming(now: Date = new Date()): Array<{ doc: IncomingDoc; xml: string }> {
  const t = today(now);
  const inputs: Array<{ id: string; input: UblInput; pdf: boolean }> = [
    {
      id: 'DEMO-IN-1001',
      pdf: true,
      input: {
        kind: 'INVOICE',
        type: 'SALE',
        number: 'R-2041/1/1',
        issueDate: addDays(t, -3),
        issueTime: '09:30:00',
        dueDate: addDays(t, 12),
        seller: { name: 'Distributer POS d.o.o.', oib: '69435151530', address: 'Savska 100', zip: '10000', city: 'Zagreb', country: 'HR', iban: 'HR1723600001101234565', vatRegistered: true },
        buyer: BUYER,
        vatRate: 25,
        taxCategory: 'S',
        paymentReference: '2041-1',
        lines: [
          { description: 'POS terminal Sunmi V2s', kpd: '26.20.16', unit: 'kom', qty: 4, unitPrice: 180 },
          { description: 'Dostava', kpd: '49.41.19', unit: 'kom', qty: 1, unitPrice: 20 },
        ],
      },
    },
    {
      id: 'DEMO-IN-1002',
      pdf: false,
      input: {
        kind: 'INVOICE',
        type: 'SERVICE',
        number: '77-WEB-2026',
        issueDate: addDays(t, -1),
        issueTime: '14:05:00',
        dueDate: addDays(t, 14),
        seller: { name: 'Oblak Usluge j.d.o.o.', oib: '84123456785', address: 'Riva 5', zip: '51000', city: 'Rijeka', country: 'HR', iban: 'HR6523400091110123456', vatRegistered: true },
        buyer: BUYER,
        vatRate: 25,
        taxCategory: 'S',
        paymentReference: '77-2026',
        lines: [{ description: 'Hosting i održavanje — mjesečno', kpd: '63.11.19', unit: 'mj', qty: 1, unitPrice: 49.9 }],
      },
    },
  ];
  return inputs.map(({ id, input, pdf }) => {
    const u = buildUbl(input);
    const xml = pdf ? embedPdf(u.xml, `${input.number.replace(/[^\w-]+/g, '-')}.pdf`, tinyPdf(`Racun ${input.number} - ${input.seller.name}`)) : u.xml;
    return {
      xml,
      doc: {
        id,
        number: input.number,
        issueDate: input.issueDate,
        insertedOn: t,
        supplierName: input.seller.name,
        supplierOib: input.seller.oib ?? '',
        net: u.totals.net,
        vat: u.totals.vat,
        total: u.totals.payable,
        status: 'zaprimljen',
      },
    };
  });
}
