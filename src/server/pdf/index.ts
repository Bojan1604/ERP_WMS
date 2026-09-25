import 'server-only';
import { DomainError } from '../errors';
import type { PdfKind } from '@/domain/documents';

export { renderPdf, pdfResponse, BASE_DOC } from './engine';
export { renderTablePdf, tableDocDefinition, formatCell, type TablePdfInput } from './table';
export { PDF_KINDS, PDF_KIND_LABEL, isPdfKind, type PdfKind } from '@/domain/documents';

/** Vrsta dokumenta još nema PDF predložak — ruta /api/pdf vraća 501. */
export class PdfNotImplementedError extends DomainError {
  constructor(kind: string) {
    super(`PDF za „${kind}" još nije dostupan.`);
    this.name = 'PdfNotImplementedError';
  }
}

export interface RenderedDocument {
  buffer: Buffer;
  /** Naziv datoteke bez putanje, npr. `Racun-12-PP1-1.pdf`. */
  fileName: string;
}

/**
 * PDF dokumenta (račun, ponuda, predračun, otpremnica, servisni nalog…) za
 * pregled, preuzimanje i privitak e-pošte. Zapis se uvijek traži unutar
 * `companyId`; nepostojeći zapis → DomainError (ruta vraća 404).
 *
 * UGOVOR (faza 0): potpis je konačan; predloške implementira područje A.
 * Dok vrsta nema predložak, baca `PdfNotImplementedError`.
 */
export async function renderDocumentPdf(kind: PdfKind, id: string, companyId: string): Promise<RenderedDocument> {
  void id;
  void companyId;
  throw new PdfNotImplementedError(kind);
}
