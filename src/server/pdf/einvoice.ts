import 'server-only';
import { renderDocumentPdf } from './index';

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Ugrađuje PDF (vizualizaciju računa) u UBL kao AdditionalDocumentReference s
 * EmbeddedDocumentBinaryObject — ide ispred AccountingSupplierParty, kako
 * traži redoslijed elemenata UBL 2.1 (HR CIUS). Ako oznaka ne postoji, XML se ne mijenja.
 */
export function embedPdfInUbl(xml: string, fileName: string, pdf: Buffer): string {
  const at = xml.indexOf('<cac:AccountingSupplierParty>');
  if (at < 0) return xml;
  const lineStart = xml.lastIndexOf('\n', at) + 1;
  const lead = xml.slice(lineStart, at);
  const [pos, indent] = /^[ \t]*$/.test(lead) ? [lineStart, lead] : [at, ''];
  const name = escXml(fileName);
  const ref =
    `${indent}<cac:AdditionalDocumentReference>\n` +
    `${indent}  <cbc:ID>${name}</cbc:ID>\n` +
    `${indent}  <cbc:DocumentDescription>Vizualizacija računa</cbc:DocumentDescription>\n` +
    `${indent}  <cac:Attachment>\n` +
    `${indent}    <cbc:EmbeddedDocumentBinaryObject mimeCode="application/pdf" filename="${name}">${pdf.toString('base64')}</cbc:EmbeddedDocumentBinaryObject>\n` +
    `${indent}  </cac:Attachment>\n` +
    `${indent}</cac:AdditionalDocumentReference>\n`;
  return xml.slice(0, pos) + ref + xml.slice(pos);
}

/**
 * eRačun za slanje posredniku: uz postavku firme „prilaži PDF"
 * (Company.eInvoiceAttachPdf) u UBL se ugrađuje PDF računa. Greška pri izradi
 * PDF-a ne zaustavlja slanje — eRačun ide bez vizualizacije.
 */
export async function withInvoicePdf(xml: string, companyId: string, invoiceId: string, attach: boolean): Promise<string> {
  if (!attach) return xml;
  try {
    const pdf = await renderDocumentPdf('invoice', invoiceId, companyId);
    return embedPdfInUbl(xml, pdf.fileName, pdf.buffer);
  } catch (e) {
    console.error('[einvoice] PDF privitak', e);
    return xml;
  }
}
