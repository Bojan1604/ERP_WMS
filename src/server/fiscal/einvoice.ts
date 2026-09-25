import 'server-only';
import { randomUUID } from 'node:crypto';
import { amsRegistered } from '@/domain/company-lookup';
import {
  BUSINESS_STATUS, alreadyInStatus, changedOnCandidates, extractXml, incomingList, normalizeIncoming, shapeError,
  type BusinessStatus, type IncomingDoc,
} from '@/domain/einvoice-inbound';
import { demoIncoming } from './einvoice-demo';

/**
 * Informacijski posrednik za eRačun (Fiskalizacija 2.0). Program zna samo za
 * sučelje `EInvoiceProvider`; konkretni posrednik se bira u postavkama.
 * Nijedna metoda ne baca — greške se vraćaju u `error`.
 */

export interface ProviderResult {
  ok: boolean;
  /** Id dokumenta kod posrednika. */
  id?: string;
  status?: string;
  error?: string;
  /** Sirovi odgovor za dnevnik. */
  raw?: string;
  demo?: boolean;
  /** Mreža/istek vremena — posrednik nije odgovorio (naknadnu dostavu nema smisla nastaviti). */
  unreachable?: boolean;
  /** Zahtjev je možda stigao do posrednika (istek vremena, prekinuta veza) — ishod nije poznat. */
  uncertain?: boolean;
}

export interface SendMeta {
  number: string;
  buyerOib: string | null;
  sellerOib: string | null;
}

export interface PaymentReport {
  documentId: string;
  issueDate: string;
  supplierOib: string | null;
  customerOib: string | null;
  paymentDate: string;
  /** Storno se prijavljuje negativnim iznosom. */
  paidAmount: number;
  /** UNCL4461: 30 transakcijski račun, 10 gotovina, 48 kartica. */
  paymentType: string;
}

export interface StatusChange {
  status: BusinessStatus;
  note?: string;
  /** Datum promjene (YYYY-MM-DD); zadano danas. */
  date?: string | null;
  partialPaymentAmount?: number;
}

export interface RejectReport {
  documentId: string;
  note: string;
  rejectionDate: string;
}

export interface EInvoiceProvider {
  readonly code: string;
  send(xml: string, meta: SendMeta): Promise<ProviderResult>;
  status(id: string): Promise<ProviderResult>;
  reportPayment(p: PaymentReport): Promise<ProviderResult>;
  ping(): Promise<ProviderResult>;
  /** AMS (adresar primatelja eRačuna): može li primatelj s tim OIB-om primati eRačune. */
  amsCheck?(oib: string): Promise<ProviderResult & { registered?: boolean }>;
  /** Provjera UBL-a kod posrednika bez slanja (document/validate). */
  validate?(xml: string): Promise<ProviderResult & { errors?: string[] }>;
  /** PDF (vizualizacija) poslanog dokumenta, base64. */
  visualization?(id: string): Promise<ProviderResult & { pdfBase64?: string }>;
  /** Fiskalizacija računa koji ne ide kao eRačun: IR (kupac izvan AMS-a) ili I (eIzvještavanje, strani kupac). */
  reportDocument?(xml: string, type: 'IR' | 'I', meta: SendMeta): Promise<ProviderResult>;

  // ---- ulazni eRačuni (kupac)
  /** Primljeni dokumenti (najnoviji prvi, koliko posrednik vrati). */
  incoming?(opts?: { limit?: number; offset?: number }): Promise<ProviderResult & { docs?: IncomingDoc[] }>;
  /** Izvorni UBL XML primljenog dokumenta. */
  documentXml?(id: string): Promise<ProviderResult & { xml?: string }>;
  /** Poslovni status kupca (prihvaćen, odbijen, plaćen). `already` = dokument je već bio u tom statusu. */
  changeStatus?(id: string, s: StatusChange): Promise<ProviderResult & { already?: boolean; body?: unknown }>;
  /** eIzvještavanje o odbijanju ulaznog računa (Porezna uprava). */
  reportRejected?(r: RejectReport): Promise<ProviderResult>;
}

// ---------------------------------------------------------------- demo

/** Demo posrednik: ništa ne šalje, „prihvaća" svaki dokument i vraća izmišljeni id. */
export const demoProvider: EInvoiceProvider = {
  code: 'demo',
  async send(xml, meta) {
    const id = `DEMO-${randomUUID()}`;
    return { ok: true, id, status: 'ACCEPTED', demo: true, raw: JSON.stringify({ demo: true, id, number: meta.number, bytes: xml.length }) };
  },
  async status(id) {
    return { ok: true, id, status: 'DELIVERED', demo: true, raw: JSON.stringify({ demo: true, id, status: 'DELIVERED' }) };
  },
  async reportPayment(p) {
    return { ok: true, id: p.documentId, status: 'REPORTED', demo: true, raw: JSON.stringify({ demo: true, ...p }) };
  },
  async ping() {
    return { ok: true, status: 'OK', demo: true, raw: '{"demo":true}' };
  },
  async amsCheck(oib) {
    return { ok: true, registered: true, demo: true, raw: JSON.stringify({ demo: true, oib, registered: true }) };
  },
  async validate(xml) {
    // demo: samo osnovna provjera oblika (UBL Invoice/CreditNote)
    const ok = /<(?:\w+:)?(Invoice|CreditNote)[\s>]/.test(xml);
    return ok
      ? { ok: true, demo: true, errors: [], raw: JSON.stringify({ demo: true, valid: true }) }
      : { ok: false, demo: true, errors: ['Dokument nije UBL Invoice ni CreditNote.'], error: 'Dokument nije UBL Invoice ni CreditNote.' };
  },
  async visualization(id) {
    return { ok: true, demo: true, id, pdfBase64: DEMO_PDF, raw: JSON.stringify({ demo: true, id }) };
  },
  async reportDocument(xml, type, meta) {
    const id = `DEMO-${type}-${randomUUID()}`;
    return { ok: true, id, status: 'REPORTED', demo: true, raw: JSON.stringify({ demo: true, id, type, number: meta.number, bytes: xml.length }) };
  },
  async incoming() {
    const docs = demoIncoming().map((d) => d.doc);
    return { ok: true, demo: true, docs, raw: JSON.stringify({ demo: true, count: docs.length }) };
  },
  async documentXml(id) {
    const d = demoIncoming().find((x) => x.doc.id === id);
    return d ? { ok: true, demo: true, id, xml: d.xml } : { ok: false, demo: true, id, error: `Dokument ${id} ne postoji (demo).` };
  },
  async changeStatus(id, s) {
    return { ok: true, demo: true, id, status: s.status, raw: JSON.stringify({ demo: true, id, status: BUSINESS_STATUS[s.status], note: s.note ?? '' }) };
  },
  async reportRejected(r) {
    return { ok: true, demo: true, id: r.documentId, status: 'REPORTED', raw: JSON.stringify({ demo: true, ...r }) };
  },
};

// ---------------------------------------------------------------- ePoslovanje.hr (API v2)

/**
 * ePoslovanje.hr REST API v2 (https://test.eposlovanje.hr/api/v2/ i
 * https://eracun.eposlovanje.hr/api/v2/). Ključ ide goli u zaglavlje
 * `Authorization`. Korištene krajnje točke:
 *   POST document/send            { document: <UBL XML>, sendAsEmail: false, softwareId } → { id, insertedOn, message }
 *   GET  document/status/{id}     transportni, poslovni i fiskalizacijski status
 *   POST ereporting/paid/{id}     eIzvještavanje o naplati
 *   GET  document/outgoing?limit=1  (provjera veze i ključa)
 *   POST ams/check                { schema: '9934', identifier: OIB } → prima li eRačune
 *   GET  document/incoming?limit=&offset=   primljeni dokumenti (bez insertedFrom/To — s njima
 *                                 posrednik ne vrati ništa, iskustvo starog programa)
 *   GET  document/get/{id}        izvorni XML (čisti XML, JSON s poljem ili base64)
 *   POST document/changestatus/{id}  { status: 5|6|7|8, note, changedOn, partialPaymentAmount? }
 *   POST ereporting/rejected/{id}    { documentId, note, rejectionDate } — odbijanje u eIzvještavanje
 * Ostalo što posrednik nudi (document/validate, ereporting/reportdocument)
 * dodaje se ovdje, iza istog sučelja.
 */
export function eposlovanjeProvider(apiKey: string, env: 'TEST' | 'PROD', timeoutMs = 30_000): EInvoiceProvider {
  const base = env === 'PROD' ? 'https://eracun.eposlovanje.hr/api/v2/' : 'https://test.eposlovanje.hr/api/v2/';
  const softwareId = process.env.EINVOICE_SOFTWARE_ID || 'erp-wms';

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ProviderResult & { data?: Record<string, unknown>; httpStatus?: number }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: { Authorization: apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const raw = await res.text();
      let data: Record<string, unknown> = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = { raw };
      }
      if (!res.ok) return { ok: false, error: errorText(data) || `HTTP ${res.status}`, raw, data, httpStatus: res.status };
      return { ok: true, raw, data, httpStatus: res.status };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      // veza nije ni uspostavljena → zahtjev sigurno nije stigao; inače (istek, prekid) ishod nije poznat
      const code = String((e as { cause?: { code?: unknown } })?.cause?.code ?? '');
      const notSent = !aborted && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code);
      return {
        ok: false,
        unreachable: true,
        uncertain: !notSent,
        error: aborted ? `Posrednik ne odgovara (${timeoutMs / 1000} s)` : `Posrednik nije dostupan: ${e instanceof Error ? e.message : e}${code ? ` (${code})` : ''}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    code: 'eposlovanje',
    async send(xml) {
      const r = await call('POST', 'document/send', { document: xml, sendAsEmail: false, softwareId });
      const id = r.data?.id ?? r.data?.documentId;
      return { ...r, id: id != null ? String(id) : undefined, status: r.ok ? 'SENT' : undefined, ...(r.ok && id == null ? { ok: false, error: 'Posrednik nije vratio id dokumenta.' } : {}) };
    },
    async status(id) {
      const r = await call('GET', `document/status/${encodeURIComponent(id)}`);
      return { ...r, id, status: r.ok ? String(r.data?.status ?? r.data?.businessStatus ?? 'OK') : undefined };
    },
    async reportPayment(p) {
      return call('POST', `ereporting/paid/${encodeURIComponent(p.documentId)}`, {
        documentId: p.documentId,
        issueDate: p.issueDate,
        supplierPartyId: p.supplierOib ?? '',
        customerPartyId: p.customerOib ?? '',
        paymentDate: p.paymentDate,
        paidAmount: p.paidAmount,
        paymentType: p.paymentType,
      });
    },
    async ping() {
      const r = await call('GET', 'document/outgoing?limit=1&offset=0');
      return { ...r, status: r.ok ? 'OK' : undefined };
    },
    async validate(xml) {
      const r = await call('POST', 'document/validate', { document: xml });
      const d = r.data as Record<string, unknown> | undefined;
      const msgs = errorList(d).filter((m) => !/^(ok|valid|success)/i.test(m));
      const valid = r.ok && d?.valid !== false && d?.isValid !== false && !msgs.length;
      return valid ? { ...r, ok: true, errors: [] } : { ...r, ok: false, errors: msgs.length ? msgs : [r.error || 'Provjera nije prošla.'], error: (msgs.length ? msgs : [r.error || 'Provjera nije prošla.']).join('; ') };
    },
    async visualization(id) {
      const r = await call('GET', `document/visualization/${encodeURIComponent(id)}`);
      if (!r.ok) return { ...r, id };
      const d = r.data as Record<string, unknown> | undefined;
      const pick = (v: unknown) => (typeof v === 'string' && v.length > 100 ? v : '');
      const b64 = pick(d?.raw) || pick(d?.pdf) || pick(d?.content) || pick(d?.data) || pick(d?.visualization);
      return b64 ? { ...r, id, pdfBase64: b64.replace(/^data:.*?;base64,/, '') } : { ...r, id, ok: false, error: 'Posrednik nije vratio PDF.' };
    },
    async reportDocument(xml, type) {
      const r = await call('POST', 'ereporting/reportdocument', { document: xml, type, softwareId });
      const id = r.data?.id ?? r.data?.documentId;
      return { ...r, id: id != null ? String(id) : undefined, status: r.ok ? 'REPORTED' : undefined, ...(r.ok && id == null ? { ok: false, error: 'Posrednik nije vratio id dokumenta.' } : {}) };
    },
    async amsCheck(oib) {
      // 9934 = shema hrvatskog OIB-a u AMS-u
      const r = await call('POST', 'ams/check', { schema: '9934', identifier: oib });
      return { ...r, registered: r.ok ? amsRegistered(200, r.data) : undefined };
    },
    async incoming(opts = {}) {
      const q = new URLSearchParams({ limit: String(opts.limit ?? 50), offset: String(opts.offset ?? 0) });
      const r = await call('GET', `document/incoming?${q}`);
      if (!r.ok) return r;
      // odgovor je goli niz ili objekt s nizom (items, documents, data…)
      const docs = incomingList(r.data)
        .map(normalizeIncoming)
        .filter((d) => d.id);
      return { ...r, docs };
    },
    async documentXml(id) {
      const r = await call('GET', `document/get/${encodeURIComponent(id)}`);
      if (!r.ok) return { ...r, id };
      // odgovor može biti goli XML (nije JSON → data = { raw }), JSON s poljem ili base64
      const xml = extractXml(r.data) || extractXml(r.raw);
      return xml ? { ...r, id, xml } : { ...r, id, ok: false, error: 'Posrednik nije vratio XML dokumenta.' };
    },
    async changeStatus(id, s) {
      const extra = s.partialPaymentAmount != null ? { partialPaymentAmount: s.partialPaymentAmount } : {};
      let last: ProviderResult | null = null;
      for (const date of changedOnCandidates(s.date)) {
        const body = { status: BUSINESS_STATUS[s.status], note: s.note ?? '', ...date, ...extra };
        const r = await call('POST', `document/changestatus/${encodeURIComponent(id)}`, body);
        if (r.ok) return { ...r, id, status: s.status, body };
        // „Dokument se već nalazi u statusu kojeg pokušavate postaviti" — raniji pokušaj je prošao
        if (alreadyInStatus(r.error)) return { ...r, ok: true, error: undefined, id, status: s.status, already: true, body };
        last = r;
        // mreža, ili greška koja nije o obliku tijela (dokument ne postoji, nije dopušteno) — dalje nema smisla
        if (r.unreachable || !shapeError(r.error, httpStatus(r))) break;
      }
      return { ...(last ?? { ok: false, error: 'Promjena statusa nije uspjela.' }), id };
    },
    async reportRejected(p) {
      const r = await call('POST', `ereporting/rejected/${encodeURIComponent(p.documentId)}`, { documentId: p.documentId, note: p.note, rejectionDate: p.rejectionDate });
      return { ...r, id: p.documentId };
    },
  };
}

const httpStatus = (r: ProviderResult & { httpStatus?: number }) => r.httpStatus;

/** Sve poruke iz odgovora posrednika (validacija). */
function errorList(data: unknown): string[] {
  const t = errorText(data);
  return t ? t.split('; ') : [];
}

/** Najmanji ispravan PDF (demo „vizualizacija" posrednika). */
const DEMO_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 58>>stream\nBT /F1 18 Tf 72 760 Td (eRacun - demo vizualizacija) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
).toString('base64');

function errorText(data: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (v == null || depth > 5) return;
    if (typeof v === 'string') return void (v.trim() && out.push(v.trim()));
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === 'object') {
      for (const k of ['message', 'error', 'errors', 'validationErrors', 'messages', 'description', 'detail', 'details', 'reason', 'raw']) {
        if (k in (v as Record<string, unknown>)) walk((v as Record<string, unknown>)[k], depth + 1);
      }
    }
  };
  walk(data);
  return [...new Set(out)].join('; ').slice(0, 1000);
}

const failing = (code: string, error: string): EInvoiceProvider => {
  const no = async (): Promise<ProviderResult> => ({ ok: false, error });
  return { code, send: no, status: no, reportPayment: no, ping: no, incoming: no, documentXml: no, changeStatus: no, reportRejected: no, validate: no, visualization: no, reportDocument: no };
};

/** Posrednik prema postavkama firme (ključ je već dešifriran). */
export function providerFor(code: string, apiKey: string | null, env: string): EInvoiceProvider | null {
  if (code === 'demo') return demoProvider;
  if (code === 'eposlovanje') {
    if (!apiKey) return failing(code, 'API ključ posrednika nije postavljen.');
    return eposlovanjeProvider(apiKey, env === 'PROD' ? 'PROD' : 'TEST');
  }
  if (code === 'none' || !code) return null;
  return failing(code, `Posrednik „${code}" još nije podržan — odaberite ePoslovanje.hr ili demo.`);
}
