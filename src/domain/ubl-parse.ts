/**
 * Čitanje primljenog eRačuna (UBL 2.1 Invoice ili CreditNote, HR CIUS-2025).
 * Čista funkcija bez baze i preglednika: XML se čita s @xmldom/xmldom, elementi
 * se traže po lokalnom imenu (prefiksi imenskih prostora nisu bitni).
 *
 * Iz dokumenta se uzima samo ono što treba knjizi ulaznih računa: broj, datumi,
 * dobavljač (naziv, OIB, PDV ID), kupac (za provjeru), zbrojevi, valuta i ugrađeni
 * prilozi (najčešće PDF računa koji je dobavljač priložio).
 */
import { DOMParser } from '@xmldom/xmldom';
import { r2 } from './money';

export interface UblAttachment {
  fileName: string;
  mime: string;
  /** Sadržaj u base64 (bez razmaka). */
  base64: string;
  description: string;
}

export interface UblPartyInfo {
  name: string;
  /** OIB (11 znamenki) ako je stranka hrvatska; inače prazno. */
  oib: string;
  /** PDV ID kako je upisan (npr. HR12345678903, SI12345678). */
  vatId: string;
  address: string;
  zip: string;
  city: string;
  /** ISO 3166-1 alfa-2; prazno ako nije navedeno. */
  country: string;
}

export interface ParsedUbl {
  root: 'Invoice' | 'CreditNote';
  /** Knjižno odobrenje (CreditNote ili InvoiceTypeCode 381). */
  credit: boolean;
  typeCode: string;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  supplier: UblPartyInfo;
  customer: UblPartyInfo;
  /** Iznosi kako su u dokumentu (odobrenje ima pozitivne iznose). */
  net: number;
  vat: number;
  total: number;
  payable: number;
  note: string;
  attachments: UblAttachment[];
}

// minimalni oblik DOM-a koji koristimo (xmldom i preglednik ga dijele)
interface El {
  localName: string | null;
  childNodes: ArrayLike<unknown>;
  textContent: string | null;
  getAttribute(name: string): string | null;
}

const isEl = (n: unknown): n is El => !!n && (n as { nodeType?: number }).nodeType === 1;

function children(el: El | null | undefined, name?: string): El[] {
  if (!el) return [];
  const out: El[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (isEl(c) && (!name || c.localName === name)) out.push(c);
  }
  return out;
}

/** Put izravne djece po lokalnim imenima: path(root, 'LegalMonetaryTotal', 'PayableAmount'). */
function path(el: El | null | undefined, ...names: string[]): El | null {
  let cur: El | null | undefined = el;
  for (const n of names) {
    cur = children(cur, n)[0];
    if (!cur) return null;
  }
  return cur ?? null;
}

const text = (el: El | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

function amount(el: El | null | undefined): number {
  const v = Number(text(el).replace(',', '.'));
  return Number.isFinite(v) ? r2(v) : 0;
}

/** OIB iz identifikatora: „HR12345678903", „9934:12345678903" ili 11 znamenki. */
export function oibFrom(v: string | null | undefined): string {
  const s = String(v ?? '').trim().replace(/^9934:/, '').replace(/^HR/i, '').replace(/\s+/g, '');
  return /^\d{11}$/.test(s) ? s : '';
}

function party(wrapper: El | null): UblPartyInfo {
  const p = path(wrapper, 'Party');
  if (!p) return { name: '', oib: '', vatId: '', address: '', zip: '', city: '', country: '' };
  const endpoint = path(p, 'EndpointID');
  const scheme = endpoint?.getAttribute('schemeID') ?? '';
  const taxIds = children(p, 'PartyTaxScheme').map((t) => text(path(t, 'CompanyID'))).filter(Boolean);
  const legalId = text(path(p, 'PartyLegalEntity', 'CompanyID'));
  const identIds = children(p, 'PartyIdentification').map((x) => text(path(x, 'ID')));
  // prednost ima elektronička adresa sa shemom 9934 (hrvatski OIB), pa PDV ID, pa registracijski broj
  const candidates = [scheme === '9934' || !scheme ? text(endpoint) : '', ...taxIds, legalId, ...identIds];
  const oib = candidates.map(oibFrom).find(Boolean) ?? '';
  const addr = path(p, 'PostalAddress');
  return {
    name: text(path(p, 'PartyLegalEntity', 'RegistrationName')) || text(path(p, 'PartyName', 'Name')),
    oib,
    vatId: taxIds[0] ?? '',
    address: [text(path(addr, 'StreetName')), text(path(addr, 'AdditionalStreetName'))].filter(Boolean).join(', '),
    zip: text(path(addr, 'PostalZone')),
    city: text(path(addr, 'CityName')),
    country: text(path(addr, 'Country', 'IdentificationCode')).toUpperCase().slice(0, 2),
  };
}

/** Vraća null ako ulaz nije UBL Invoice/CreditNote (ili XML nije čitljiv). */
export function parseUbl(xml: string | null | undefined): ParsedUbl | null {
  const src = String(xml ?? '').replace(/^﻿/, '').trim();
  if (!src.startsWith('<')) return null;
  let doc;
  try {
    // upozorenja parsera se zanemaruju; neispravan XML baca
    doc = new DOMParser({ onError: (level) => { if (level === 'fatalError') throw new Error('xml'); } }).parseFromString(src, 'text/xml');
  } catch {
    return null;
  }
  const rootEl = doc?.documentElement as unknown as El | null;
  if (!rootEl || (rootEl.localName !== 'Invoice' && rootEl.localName !== 'CreditNote')) return null;
  const root = rootEl.localName as ParsedUbl['root'];

  const currency = text(path(rootEl, 'DocumentCurrencyCode'));
  const typeCode = text(path(rootEl, root === 'Invoice' ? 'InvoiceTypeCode' : 'CreditNoteTypeCode'));
  const totals = path(rootEl, 'LegalMonetaryTotal');
  // PDV: TaxTotal u valuti dokumenta (drugi TaxTotal, ako postoji, je u valuti obračuna PDV-a)
  const taxTotals = children(rootEl, 'TaxTotal').map((t) => path(t, 'TaxAmount'));
  const vatEl = taxTotals.find((a) => !currency || a?.getAttribute('currencyID') === currency) ?? taxTotals[0];
  const payment = children(rootEl, 'PaymentMeans');
  const dueDate =
    text(path(rootEl, 'DueDate')) ||
    payment.map((p) => text(path(p, 'PaymentDueDate'))).find(Boolean) ||
    children(rootEl, 'PaymentTerms').map((p) => text(path(p, 'PaymentDueDate'))).find(Boolean) ||
    '';

  const attachments: UblAttachment[] = [];
  for (const ref of children(rootEl, 'AdditionalDocumentReference')) {
    const bin = path(ref, 'Attachment', 'EmbeddedDocumentBinaryObject');
    const base64 = (bin?.textContent ?? '').replace(/\s+/g, '');
    if (!bin || !base64) continue;
    attachments.push({
      fileName: bin.getAttribute('filename') || text(path(ref, 'ID')) || 'prilog',
      mime: bin.getAttribute('mimeCode') || 'application/octet-stream',
      base64,
      description: text(path(ref, 'DocumentDescription')) || text(path(ref, 'DocumentType')),
    });
  }

  const net = amount(path(totals, 'TaxExclusiveAmount'));
  const vat = amount(vatEl);
  const total = amount(path(totals, 'TaxInclusiveAmount')) || r2(net + vat);
  return {
    root,
    credit: root === 'CreditNote' || typeCode === '381',
    typeCode,
    number: text(path(rootEl, 'ID')),
    issueDate: text(path(rootEl, 'IssueDate')).slice(0, 10),
    dueDate: dueDate.slice(0, 10),
    currency,
    supplier: party(path(rootEl, 'AccountingSupplierParty')),
    customer: party(path(rootEl, 'AccountingCustomerParty')),
    net,
    vat,
    total,
    payable: totals && path(totals, 'PayableAmount') ? amount(path(totals, 'PayableAmount')) : total,
    note: children(rootEl, 'Note').map(text).filter(Boolean).join('\n'),
    attachments,
  };
}

/** Prvi ugrađeni PDF (vizualizacija računa koju je priložio dobavljač). */
export function ublPdf(p: Pick<ParsedUbl, 'attachments'>): UblAttachment | null {
  return p.attachments.find((a) => /pdf/i.test(a.mime) || /\.pdf$/i.test(a.fileName)) ?? null;
}

/**
 * Iznosi za knjigu ulaznih računa: odobrenje (CreditNote / 381) umanjuje obvezu,
 * pa se upisuje s negativnim predznakom; storno (384) već nosi negativne iznose.
 */
export function signedAmounts(p: Pick<ParsedUbl, 'credit' | 'net' | 'vat' | 'total'>) {
  if (!p.credit) return { net: r2(p.net), vat: r2(p.vat), total: r2(p.total) };
  const neg = (v: number) => (v ? -r2(Math.abs(v)) : 0);
  return { net: neg(p.net), vat: neg(p.vat), total: neg(p.total) };
}
