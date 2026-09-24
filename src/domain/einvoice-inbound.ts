/**
 * Ulazni eRačuni (Fiskalizacija 2.0) — čista pravila bez mreže i baze:
 * poslovni statusi posrednika, oblik zapisa iz popisa primljenih dokumenata,
 * izvlačenje XML-a iz odgovora i datum promjene statusa.
 */
import { localParts } from './fiscal';
import { today } from './dates';

/**
 * Poslovni statusi ePoslovanje.hr (potvrđeno porukom posrednika „Status mora biti
 * jedan od sljedećih: 5, 6, 7, 8"): 4 zaprimljen (dolazi u popisu ulaznih),
 * 5 prihvaćen, 6 odbijen, 7 djelomično plaćen (uz partialPaymentAmount), 8 plaćen.
 */
export const BUSINESS_STATUS = { RECEIVED: 4, ACCEPTED: 5, REJECTED: 6, PARTIAL: 7, PAID: 8 } as const;
export type BusinessStatus = keyof typeof BUSINESS_STATUS;

const BUSINESS_LABELS: Record<string, string> = {
  1: 'poslan', 2: 'dostavljen', 3: 'preuzet', 4: 'zaprimljen', 5: 'prihvaćen', 6: 'odbijen', 7: 'djelomično plaćen', 8: 'plaćen',
};

/** Tekst statusa posrednika (broj → naziv; ostalo kako je stiglo). */
export function businessStatusLabel(v: unknown): string {
  if (v == null || v === '') return '';
  return BUSINESS_LABELS[String(v)] ?? String(v);
}

/** Poslovni status ulaznog računa u programu. */
export const SUPPLIER_INVOICE_STATUS_LABEL: Record<'RECEIVED' | 'ACCEPTED' | 'REJECTED', string> = {
  RECEIVED: 'Zaprimljen',
  ACCEPTED: 'Prihvaćen',
  REJECTED: 'Odbijen',
};

/** Česti razlozi odbijanja (brzi odabir u dijalogu). */
export const REJECT_REASONS = [
  'Neispravan iznos',
  'Roba/usluga nije isporučena',
  'Pogrešan kupac',
  'Duplikat računa',
  'Neispravni podaci o PDV-u',
] as const;

export interface IncomingDoc {
  id: string;
  number: string;
  issueDate: string;
  insertedOn: string;
  supplierName: string;
  supplierOib: string;
  net: number;
  vat: number;
  total: number;
  status: string;
}

/**
 * Zapis iz `document/incoming`; nazivi polja posrednika nisu isti u svim
 * verzijama, pa se čita više mogućih naziva (kao u starom programu).
 */
export function normalizeIncoming(d: unknown): IncomingDoc {
  const o = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const g = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = k.split('.').reduce<unknown>((x, p) => (x == null || typeof x !== 'object' ? undefined : (x as Record<string, unknown>)[p]), o);
      if (v != null && v !== '') return v;
    }
    return '';
  };
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    id: String(g('id', 'documentId') ?? ''),
    number: String(g('documentNumber', 'invoiceNumber', 'number', 'id') ?? ''),
    issueDate: String(g('issueDate', 'issuedOn', 'date') || '').slice(0, 10),
    insertedOn: String(g('insertedOn', 'receivedOn', 'createdOn') || '').slice(0, 10),
    supplierName: String(g('supplierName', 'senderName', 'supplier.name', 'sender.name', 'issuerName') ?? ''),
    supplierOib: String(g('supplierOib', 'supplierIdentifier', 'senderIdentifier', 'supplier.oib', 'supplier.identifier', 'sender.identifier', 'issuerOib') || '')
      .replace(/^9934:/, '')
      .replace(/^HR/i, ''),
    total: n(g('payableAmount', 'totalAmount', 'amount', 'total', 'taxInclusiveAmount')),
    net: n(g('taxExclusiveAmount', 'netAmount', 'baseAmount')),
    vat: n(g('taxAmount', 'vatAmount')),
    status: businessStatusLabel(g('status', 'businessStatus', 'state')),
  };
}

/** Popis iz odgovora — goli niz ili niz u nekom od uobičajenih polja. */
export function incomingList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ['items', 'documents', 'data', 'results', 'list', 'rows']) if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  return [];
}

/** XML dokumenta iz odgovora posrednika: čisti XML, JSON s poljem ili base64. */
export function extractXml(data: unknown, depth = 0): string {
  if (!data || depth > 4) return '';
  if (typeof data === 'string') {
    const s = data.replace(/^﻿/, '');
    if (s.trim().startsWith('<')) return s;
    try {
      const dec = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8').replace(/^﻿/, '');
      if (dec.trim().startsWith('<')) return dec;
    } catch {
      /* nije base64 */
    }
    return '';
  }
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of ['document', 'xml', 'content', 'data', 'ubl', 'raw']) if (o[k]) {
      const x = extractXml(o[k], depth + 1);
      if (x) return x;
    }
  }
  return '';
}

/** Poruka posrednika da je dokument već u traženom statusu — cilj je postignut. */
export const alreadyInStatus = (msg: string | null | undefined) =>
  /već se nalazi u statusu|već nalazi u statusu|already in (the |this )?status|isti status/i.test(msg ?? '');

/** Greška koja može biti do oblika tijela (vrijedi probati sljedeći oblik datuma). */
export const shapeError = (msg: string | null | undefined, httpStatus?: number) =>
  httpStatus === 400 || /JSON|struktur|parsanj|parsiranj|neispravni ulazni|invalid input|bad request|datum|date/i.test(msg ?? '');

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/**
 * Oblici datuma promjene statusa, redom kojim se isprobavaju. Datum je obvezan
 * („Datum promjene statusa nije ispravno zadan"); dokumentirani oblik (API v2
 * 2.0.17) je `changedOn` u ISO 8601 s milisekundama i pomakom
 * (2025-07-15T12:00:00.123+02:00), ostali su rezerva ako posrednik promijeni oblik.
 * Vrijeme i pomak su po Europe/Zagreb; zadani datum koji nije današnji dobiva podne.
 */
export function changedOnCandidates(date?: string | null, now: Date = new Date()): Array<Record<string, string>> {
  const t = today(now);
  const d = date || t;
  const lp = localParts(now);
  const offMin = Math.round((Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi, lp.s) - Math.floor(now.getTime() / 1000) * 1000) / 60000);
  const hhmm = d !== t ? '12:00:00.000' : `${pad(lp.h)}:${pad(lp.mi)}:${pad(lp.s)}.${pad(now.getMilliseconds(), 3)}`;
  const off = `${offMin >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`;
  const iso = `${d}T${hhmm}${off}`;
  const dt = `${d}T${hhmm.slice(0, 8)}`;
  return [{ changedOn: iso }, { changedOn: dt }, { statusDate: iso }, { date: iso }, { statusChangeDate: iso }, { changedOn: d }];
}
