import 'server-only';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { DomainError } from '../errors';
import type { PdfKind } from '@/domain/documents';
import { renderPdf } from './engine';
import { renderDeliveryDefinition, renderInvoiceDefinition } from './invoice';
import { renderQuoteDefinition } from './quote';
import { renderServiceDefinition } from './service';
import { renderOrderDefinition, renderReceiptDefinition } from './purchasing';
import { renderContractListDefinition } from './contract';

export { renderPdf, pdfResponse, BASE_DOC } from './engine';
export { renderTablePdf, tableDocDefinition, formatCell, type TablePdfInput } from './table';
export { PDF_KINDS, PDF_KIND_LABEL, isPdfKind, type PdfKind } from '@/domain/documents';

export interface RenderedDocument {
  buffer: Buffer;
  /** Naziv datoteke bez putanje, npr. `Racun-12-PP1-1.pdf`. */
  fileName: string;
}

export interface RenderOptions {
  /** Prikaži nabavne cijene (primka, narudžbenica) — samo uz pravo `costs`. Zadano: ne. */
  showCost?: boolean;
}

/** pdfmake definicija dokumenta i naziv datoteke (za testove i ugradnju u eRačun). */
export async function documentDefinitionFor(kind: PdfKind, id: string, companyId: string, opts: RenderOptions = {}): Promise<{ def: TDocumentDefinitions; fileName: string }> {
  switch (kind) {
    case 'invoice':
      return renderInvoiceDefinition(companyId, id);
    case 'delivery':
      return renderDeliveryDefinition(companyId, id);
    case 'quote':
      return renderQuoteDefinition(companyId, id, null);
    case 'proforma':
      return renderQuoteDefinition(companyId, id, 'proforma');
    case 'service':
      return renderServiceDefinition(companyId, id, false);
    case 'service-delivery':
      return renderServiceDefinition(companyId, id, true);
    case 'order':
      return renderOrderDefinition(companyId, id, !!opts.showCost);
    case 'receipt':
      return renderReceiptDefinition(companyId, id, !!opts.showCost);
    case 'contract-list':
      return renderContractListDefinition(companyId, id);
    default: {
      // sve vrste iz PDF_KINDS imaju predložak (provjera pri prevođenju); nepoznata vrsta izvana → greška
      const unknown: never = kind;
      throw new DomainError(`Nepoznata vrsta dokumenta „${String(unknown)}".`);
    }
  }
}

/**
 * PDF dokumenta (račun, ponuda, predračun, otpremnica, servisni nalog…) za
 * pregled, preuzimanje, privitak e-pošte, ZIP knjigovođe i eRačun. Zapis se
 * uvijek traži unutar `companyId`; nepostojeći zapis → DomainError (ruta vraća 404).
 */
export async function renderDocumentPdf(kind: PdfKind, id: string, companyId: string, opts: RenderOptions = {}): Promise<RenderedDocument> {
  const { def, fileName } = await documentDefinitionFor(kind, id, companyId, opts);
  return { buffer: await renderPdf(def), fileName };
}
