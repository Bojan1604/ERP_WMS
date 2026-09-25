import type { Module } from './permissions';

/**
 * Vrste dokumenata za PDF i e-poštu — dijele ih poslužitelj (server/pdf,
 * server/mail) i klijent (PdfButton, SendEmailButton), pa su ovdje, bez ovisnosti.
 */

/** Dokumenti koji se ispisuju u PDF (`renderDocumentPdf`, GET /api/pdf/[kind]/[id]). */
export const PDF_KINDS = ['invoice', 'quote', 'proforma', 'delivery', 'service', 'service-delivery', 'order', 'receipt', 'contract-list'] as const;
export type PdfKind = (typeof PDF_KINDS)[number];

export const PDF_KIND_LABEL: Record<PdfKind, string> = {
  invoice: 'Račun',
  quote: 'Ponuda',
  proforma: 'Predračun',
  delivery: 'Otpremnica',
  service: 'Servisni nalog',
  'service-delivery': 'Otpremnica servisa',
  order: 'Narudžbenica',
  receipt: 'Primka',
  'contract-list': 'Popis uređaja ugovora',
};

export const isPdfKind = (k: string): k is PdfKind => (PDF_KINDS as readonly string[]).includes(k);

/** Prijedlozi naslova predračuna (postavke firme i dokument). */
export const PROFORMA_TITLES = ['Predračun', 'Proforma', 'Profaktura', 'Proforma račun'] as const;

/**
 * Naslov ponude/predračuna na ispisu, PDF-u i u e-pošti: predračun nosi vlastiti
 * naslov dokumenta, inače naslov iz postavki firme (zadano „Predračun").
 */
export function quoteDocTitle(q: { kind: string; title?: string | null }, company: { proformaTitle?: string | null }): string {
  if (q.kind !== 'PROFORMA') return 'Ponuda';
  return q.title?.trim() || company.proformaTitle?.trim() || 'Predračun';
}

/** Vrste poruka e-pošte (`sendDocumentEmail`). `partner` = slobodna poruka partneru, `accountant-zip` = ZIP knjigovođi. */
export const MAIL_KINDS = ['invoice', 'quote', 'proforma', 'delivery', 'service', 'partner', 'accountant-zip'] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

export const isMailKind = (k: string): k is MailKind => (MAIL_KINDS as readonly string[]).includes(k);

/** Ulaz server akcije `sendDocumentEmail`. */
export interface SendDocumentEmailInput {
  kind: MailKind;
  /** Id dokumenta; za `partner` id partnera; za `accountant-zip` ključ razdoblja/izbora koji zna stranica Knjigovođa. */
  id: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  /** Priloži PDF dokumenta (za `accountant-zip`: ZIP). */
  attachPdf: boolean;
}


/** Modul čije pravo pregleda treba za PDF pojedine vrste. */
export const PDF_KIND_MODULE: Record<PdfKind, Module> = {
  invoice: 'sales',
  quote: 'sales',
  proforma: 'sales',
  delivery: 'sales',
  service: 'service',
  'service-delivery': 'service',
  order: 'purchasing',
  receipt: 'purchasing',
  'contract-list': 'rentals',
};

/** Modul i razina potrebni za slanje pojedine vrste e-pošte. */
export const MAIL_KIND_ACCESS: Record<MailKind, { module: Module; level: 'view' | 'ops' | 'edit' }> = {
  invoice: { module: 'sales', level: 'edit' },
  quote: { module: 'sales', level: 'edit' },
  proforma: { module: 'sales', level: 'edit' },
  delivery: { module: 'sales', level: 'edit' },
  service: { module: 'service', level: 'edit' },
  partner: { module: 'partners', level: 'view' },
  // kao označavanje „poslano knjigovođi" na stranici Knjigovođa
  'accountant-zip': { module: 'reports', level: 'ops' },
};
