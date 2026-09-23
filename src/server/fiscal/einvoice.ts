import 'server-only';
import { randomUUID } from 'node:crypto';

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

export interface EInvoiceProvider {
  readonly code: string;
  send(xml: string, meta: SendMeta): Promise<ProviderResult>;
  status(id: string): Promise<ProviderResult>;
  reportPayment(p: PaymentReport): Promise<ProviderResult>;
  ping(): Promise<ProviderResult>;
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
 * Ostalo što posrednik nudi (document/validate, ams/check, ereporting/reportdocument,
 * document/incoming) dodaje se ovdje, iza istog sučelja.
 */
export function eposlovanjeProvider(apiKey: string, env: 'TEST' | 'PROD', timeoutMs = 30_000): EInvoiceProvider {
  const base = env === 'PROD' ? 'https://eracun.eposlovanje.hr/api/v2/' : 'https://test.eposlovanje.hr/api/v2/';
  const softwareId = process.env.EINVOICE_SOFTWARE_ID || 'erp-wms';

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ProviderResult & { data?: Record<string, unknown> }> {
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
      if (!res.ok) return { ok: false, error: errorText(data) || `HTTP ${res.status}`, raw, data };
      return { ok: true, raw, data };
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
  };
}

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
  return { code, send: no, status: no, reportPayment: no, ping: no };
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
