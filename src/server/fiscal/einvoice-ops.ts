import 'server-only';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { audit } from '../audit';
import type { Actor } from '../services/items';
import { isDomesticBusiness, truncate } from '@/domain/fiscal';
import { providerStatus, type EInvoiceStatusCode } from '@/domain/sales-lines';
import { decryptSecret } from './crypto';
import { providerFor, type EInvoiceProvider } from './einvoice';
import { readMeta, type InvoiceFiscalMeta } from './issue';
import { invoiceUbl } from './ubl-source';
import { withInvoicePdf } from '../pdf/einvoice';

/**
 * Radnje eRačuna na izdanom računu (kartica računa): provjera kod posrednika,
 * osvježavanje stanja, fiskalizacija bez slanja (IR), eIzvještavanje (tip I),
 * PDF posrednika i poništenje traga slanja. Sve radi izvan transakcije (mrežni
 * pozivi), piše dnevnik fiskalizacije i održava `Invoice.eInvoiceStatus`.
 */

export interface OpOutcome {
  ok: boolean;
  message: string;
  /** Više redaka (npr. greške validacije). */
  lines?: string[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function log(companyId: string, invoiceId: string, ok: boolean, p: { request?: string | null; response?: string | null; error?: string | null }) {
  try {
    await db.fiscalLog.create({
      data: { companyId, invoiceId, kind: 'EINVOICE', ok, request: truncate(p.request), response: truncate(p.response), error: truncate(p.error, 2000) },
    });
  } catch (e) {
    console.error('[eRačun] dnevnik', e);
  }
}

async function load(invoiceId: string, actor: Actor) {
  const inv = await db.invoice.findFirst({
    where: { id: invoiceId, companyId: actor.companyId },
    include: {
      company: { select: { id: true, oib: true, eInvoiceProvider: true, eInvoiceApiKey: true, fiscalEnv: true, eInvoiceAttachPdf: true } },
      partner: { select: { oib: true, country: true, name: true } },
    },
  });
  if (!inv) throw new Error('Račun ne postoji.');
  return inv;
}

function providerOf(c: { eInvoiceProvider: string; eInvoiceApiKey: string | null; fiscalEnv: string }, meta?: InvoiceFiscalMeta): EInvoiceProvider {
  let key: string | null = null;
  try {
    key = decryptSecret(c.eInvoiceApiKey);
  } catch {
    throw new Error('API ključ posrednika se ne može dešifrirati (promijenjen AUTH_SECRET?) — upišite ga ponovno.');
  }
  const p = providerFor(meta?.provider ?? c.eInvoiceProvider, key, meta?.env ?? c.fiscalEnv);
  if (!p) throw new Error('Posrednik za eRačun nije odabran (Postavke → Fiskalizacija).');
  return p;
}

async function ublOf(companyId: string, invoiceId: string) {
  const u = await invoiceUbl(companyId, invoiceId);
  if (!u?.xml) throw new Error('eRačun XML se ne može izraditi (račun nije izdan).');
  return u;
}

async function setStatus(invoiceId: string, meta: InvoiceFiscalMeta, status: EInvoiceStatusCode | null, extra: Prisma.InvoiceUpdateInput = {}) {
  await db.invoice.update({
    where: { id: invoiceId },
    data: { eInvoice: meta as Prisma.InputJsonValue, eInvoiceStatus: status, eInvoiceStatusAt: new Date(), ...extra },
  });
}

/** „Provjeri eRačun": UBL ide posredniku na provjeru (document/validate), ništa se ne šalje. */
export async function validateEInvoice(invoiceId: string, actor: Actor): Promise<OpOutcome> {
  try {
    const inv = await load(invoiceId, actor);
    const p = providerOf(inv.company);
    if (!p.validate) return { ok: false, message: `Posrednik (${p.code}) ne nudi provjeru dokumenta.` };
    const u = await ublOf(actor.companyId, inv.id);
    const r = await p.validate(u.xml);
    await log(inv.companyId, inv.id, r.ok, { request: `validate ${u.fileName}`, response: r.raw ?? null, error: r.ok ? null : r.error });
    return r.ok
      ? { ok: true, message: 'Posrednik nije našao grešaka — dokument je spreman za slanje.' }
      : { ok: false, message: 'Posrednik je našao greške u dokumentu.', lines: r.errors?.length ? r.errors : [r.error ?? 'Provjera nije prošla.'] };
  } catch (e) {
    return { ok: false, message: errMsg(e) };
  }
}

/** „Osvježi status": stanje kod posrednika (dostavljen / prihvaćen / odbijen / plaćen). */
export async function refreshEInvoiceStatus(invoiceId: string, actor: Actor): Promise<OpOutcome> {
  try {
    const inv = await load(invoiceId, actor);
    const meta = readMeta(inv.eInvoice);
    if (!meta.id) return { ok: false, message: 'eRačun još nije poslan posredniku.' };
    if (meta.reportType) return { ok: false, message: 'Dokument prijavljen bez slanja (IR / I) nema stanje dostave.' };
    const p = providerOf(inv.company, meta);
    const r = await p.status(meta.id);
    await log(inv.companyId, inv.id, r.ok, { request: `status ${meta.id}`, response: r.raw ?? null, error: r.ok ? null : r.error });
    if (!r.ok) return { ok: false, message: `Stanje nije dohvaćeno: ${r.error ?? 'nepoznata greška'}` };
    let data: unknown = r.status;
    try {
      data = r.raw ? JSON.parse(r.raw) : r.status;
    } catch {
      data = r.status;
    }
    const st = providerStatus(data);
    await setStatus(inv.id, { ...meta, statusText: st.text, checkedAt: new Date().toISOString() }, st.code);
    await audit(db, actor, { entity: 'invoice', entityId: inv.id, action: 'einvoice-status', summary: `eRačun ${inv.number}: stanje „${st.text}"` });
    return { ok: true, message: `Stanje kod posrednika: ${st.text}` };
  } catch (e) {
    return { ok: false, message: errMsg(e) };
  }
}

/**
 * Fiskalizacija bez slanja: IR (domaći poslovni kupac izvan AMS-a — podaci idu
 * Poreznoj upravi, kupcu se račun dostavlja PDF-om) ili I (eIzvještavanje za
 * stranog kupca).
 */
export async function reportWithoutSending(invoiceId: string, actor: Actor, type: 'IR' | 'I'): Promise<OpOutcome> {
  try {
    const inv = await load(invoiceId, actor);
    if (inv.status !== 'ISSUED') return { ok: false, message: 'Prijavljuje se samo izdani račun.' };
    const meta = readMeta(inv.eInvoice);
    if (meta.id) return { ok: false, message: `Dokument je već kod posrednika (${meta.id}).` };
    if (inv.zki) return { ok: false, message: 'Račun je fiskaliziran u CIS-u (gotovina/kartica) — ne prijavljuje se posredniku.' };
    const domestic = isDomesticBusiness(inv.partner);
    if (type === 'IR' && !domestic) return { ok: false, message: 'Fiskalizacija bez slanja (IR) je za domaće poslovne kupce s OIB-om.' };
    if (type === 'I' && (inv.partner.country || 'HR').toUpperCase() === 'HR') return { ok: false, message: 'eIzvještavanje (tip I) je za strane kupce.' };
    const p = providerOf(inv.company);
    if (!p.reportDocument) return { ok: false, message: `Posrednik (${p.code}) ne nudi prijavu dokumenta bez slanja.` };
    const u = await ublOf(actor.companyId, inv.id);
    // IR: PDF računa ugrađen u UBL (postavka „prilaži PDF") — kupcu se račun dostavlja PDF-om
    const xml = type === 'IR' ? await withInvoicePdf(u.xml, actor.companyId, inv.id, inv.company.eInvoiceAttachPdf) : u.xml;
    const r = await p.reportDocument(xml, type, { number: inv.number ?? '', buyerOib: inv.partner.oib, sellerOib: inv.company.oib });
    await log(inv.companyId, inv.id, r.ok, { request: `${p.code === 'demo' ? '[DEMO — nije poslano] ' : ''}reportdocument ${type} ${u.fileName}\n${u.xml}`, response: r.raw ?? null, error: r.ok ? null : r.error });
    if (!r.ok || !r.id) return { ok: false, message: `Prijava nije uspjela: ${r.error ?? 'posrednik nije vratio id'}` };
    const next: InvoiceFiscalMeta = {
      ...meta,
      provider: inv.company.eInvoiceProvider,
      env: inv.company.fiscalEnv,
      id: r.id,
      // „poslano" za naknadnu dostavu — isti račun se više ne šalje
      status: 'SENT',
      sentAt: new Date().toISOString(),
      error: undefined,
      reportType: type,
      statusText: type === 'IR' ? 'fiskalizirano bez slanja (IR)' : 'prijavljeno u eIzvještavanje (tip I)',
    };
    await setStatus(inv.id, next, type === 'IR' ? 'FISCALIZED' : 'REPORTED', {
      fiscalStatus: 'SENT',
      fiscalizedAt: new Date(),
      fiscalError: null,
      ...(type === 'I' ? { eReportedAt: new Date() } : {}),
    });
    await audit(db, actor, {
      entity: 'invoice',
      entityId: inv.id,
      action: type === 'IR' ? 'einvoice-ir' : 'einvoice-report',
      summary: type === 'IR' ? `Račun ${inv.number} fiskaliziran bez slanja (IR) · ${r.id}` : `Račun ${inv.number} prijavljen u eIzvještavanje (tip I) · ${r.id}`,
    });
    return { ok: true, message: type === 'IR' ? `Fiskalizirano bez slanja (IR) — ${r.id}${r.demo ? ' (demo)' : ''}.` : `Prijavljeno u eIzvještavanje (tip I) — ${r.id}${r.demo ? ' (demo)' : ''}.` };
  } catch (e) {
    return { ok: false, message: errMsg(e) };
  }
}

/** PDF (vizualizacija) dokumenta kod posrednika. */
export async function providerPdf(invoiceId: string, actor: Actor): Promise<{ ok: true; pdf: Buffer; fileName: string } | { ok: false; message: string }> {
  try {
    const inv = await load(invoiceId, actor);
    const meta = readMeta(inv.eInvoice);
    if (!meta.id) return { ok: false, message: 'Dokument nije kod posrednika.' };
    const p = providerOf(inv.company, meta);
    if (!p.visualization) return { ok: false, message: `Posrednik (${p.code}) ne nudi PDF dokumenta.` };
    const r = await p.visualization(meta.id);
    if (!r.ok || !r.pdfBase64) return { ok: false, message: r.error ?? 'Posrednik nije vratio PDF.' };
    return { ok: true, pdf: Buffer.from(r.pdfBase64, 'base64'), fileName: `eRacun-${String(inv.number ?? inv.id).replace(/[^\w-]/g, '_')}.pdf` };
  } catch (e) {
    return { ok: false, message: errMsg(e) };
  }
}

/**
 * „Poništi trag slanja": program zaboravlja da je dokument poslan (npr. upisan
 * greškom ili test). Kod posrednika dokument ostaje. Naknadna dostava ga sama
 * ne šalje ponovno — slanje je ručno (stanje „UNKNOWN").
 */
export async function resetEInvoiceTrace(invoiceId: string, actor: Actor): Promise<OpOutcome> {
  try {
    const inv = await load(invoiceId, actor);
    const meta = readMeta(inv.eInvoice);
    if (!meta.id && !inv.eInvoiceStatus) return { ok: false, message: 'Račun nema traga slanja.' };
    const { id: _id, sentAt: _s, statusText: _t, checkedAt: _c, reportType: _r, error: _e, ...rest } = meta;
    const einvoiceRoute = meta.route === 'EINVOICE';
    await setStatus(inv.id, { ...rest, status: einvoiceRoute ? 'UNKNOWN' : undefined }, null, {
      eInvoiceStatusAt: null,
      eReportedAt: null,
      ...(inv.zki ? {} : { fiscalStatus: einvoiceRoute ? 'FAILED' : 'NOT_REQUIRED', fiscalizedAt: null, fiscalError: einvoiceRoute ? 'Trag slanja eRačuna poništen — pošaljite ga ponovno ručno.' : null }),
    });
    await log(inv.companyId, inv.id, true, { request: 'reset', response: `Trag slanja poništen (bio: ${meta.id ?? '—'})` });
    await audit(db, actor, { entity: 'invoice', entityId: inv.id, action: 'einvoice-reset', summary: `eRačun ${inv.number}: trag slanja poništen (${meta.id ?? '—'})` });
    return { ok: true, message: 'Trag slanja je poništen. Dokument kod posrednika ostaje kakav jest.' };
  } catch (e) {
    return { ok: false, message: errMsg(e) };
  }
}

/** „Je li kupac u AMS-u?" — može li kupac primiti eRačun. */
export async function amsCheckInvoice(invoiceId: string, actor: Actor): Promise<OpOutcome> {
  try {
    const inv = await load(invoiceId, actor);
    if (!inv.partner.oib) return { ok: false, message: 'Kupac nema OIB.' };
    const p = providerOf(inv.company);
    if (!p.amsCheck) return { ok: false, message: `Posrednik (${p.code}) ne nudi provjeru adresara.` };
    const r = await p.amsCheck(inv.partner.oib);
    if (!r.ok) return { ok: false, message: r.error ?? 'Provjera nije uspjela.' };
    return r.registered
      ? { ok: true, message: `${inv.partner.name} je u adresaru (AMS) — može primiti eRačun.` }
      : { ok: true, message: `${inv.partner.name} nije u adresaru (AMS). Račun se fiskalizira bez slanja (IR), a kupcu se dostavlja na drugi način.` };
  } catch (e) {
    return { ok: false, message: errMsg(e) };
  }
}
