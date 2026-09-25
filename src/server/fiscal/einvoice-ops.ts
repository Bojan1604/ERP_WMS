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
import { CLAIM_STALE_MS, claimSend, ownsClaim, releaseClaim } from './claim';
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

/**
 * Upis stanja eRačuna samo ako vrijedi uvjet `guard` (npr. oznaka zauzimanja je još
 * naša, račun se u međuvremenu nije promijenio) — istodobno slanje ili druga radnja
 * ne smiju se međusobno prepisati. Vraća je li upisano.
 */
async function setStatus(invoiceId: string, guard: Prisma.InvoiceWhereInput, meta: InvoiceFiscalMeta, status: EInvoiceStatusCode | null, extra: Prisma.InvoiceUpdateManyMutationInput = {}) {
  const r = await db.invoice.updateMany({
    where: { id: invoiceId, ...guard },
    data: { eInvoice: meta as Prisma.InputJsonValue, eInvoiceStatus: status, eInvoiceStatusAt: new Date(), ...extra },
  });
  return r.count > 0;
}

/** Oznaka „upravo se šalje" (claimSend) koja još nije zastarjela. */
function sendingNow(v: unknown, now = Date.now()): boolean {
  const s = (readMeta(v) as { sending?: { at?: string } }).sending;
  if (!s) return false;
  const at = Date.parse(s.at ?? '');
  return !Number.isFinite(at) || now - at < CLAIM_STALE_MS;
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
    // upis samo dok je trag slanja isti (u međuvremenu nije poništen ni zamijenjen)
    const saved = await setStatus(inv.id, { eInvoice: { path: ['id'], equals: meta.id } }, { ...meta, statusText: st.text, checkedAt: new Date().toISOString() }, st.code);
    if (!saved) return { ok: false, message: 'Trag slanja eRačuna se u međuvremenu promijenio — osvježite stranicu.' };
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
    // zauzimanje kao kod slanja: istodobno „Pošalji eRačun", naknadna dostava ili druga prijava ne prolaze
    const claim = await claimSend(inv.id, actor.companyId, 'einvoice');
    if (!claim) {
      const now = await db.invoice.findUnique({ where: { id: inv.id }, select: { fiscalStatus: true, eInvoice: true } });
      if (now?.fiscalStatus === 'SENT') return { ok: false, message: `Račun je već poslan ili prijavljen (${readMeta(now.eInvoice).id ?? '—'}).` };
      return { ok: false, message: 'eRačun se upravo šalje — pričekajte i osvježite stranicu.' };
    }
    const cur = claim.meta;
    if (cur.id) {
      await releaseClaim(inv.id, claim.token, cur);
      return { ok: false, message: `Dokument je već kod posrednika (${cur.id}).` };
    }
    let r: Awaited<ReturnType<NonNullable<EInvoiceProvider['reportDocument']>>>;
    let u: Awaited<ReturnType<typeof ublOf>>;
    try {
      u = await ublOf(actor.companyId, inv.id);
      // IR: PDF računa ugrađen u UBL (postavka „prilaži PDF") — kupcu se račun dostavlja PDF-om
      const xml = type === 'IR' ? await withInvoicePdf(u.xml, actor.companyId, inv.id, inv.company.eInvoiceAttachPdf) : u.xml;
      r = await p.reportDocument(xml, type, { number: inv.number ?? '', buyerOib: inv.partner.oib, sellerOib: inv.company.oib });
    } catch (e) {
      await releaseClaim(inv.id, claim.token, cur);
      throw e;
    }
    await log(inv.companyId, inv.id, r.ok, { request: `${p.code === 'demo' ? '[DEMO — nije poslano] ' : ''}reportdocument ${type} ${u.fileName}\n${u.xml}`, response: r.raw ?? null, error: r.ok ? null : r.error });
    if (!r.ok || !r.id) {
      await releaseClaim(inv.id, claim.token, cur);
      return { ok: false, message: `Prijava nije uspjela: ${r.error ?? 'posrednik nije vratio id'}` };
    }
    const next: InvoiceFiscalMeta = {
      ...cur,
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
    // upis samo uz našu oznaku i dok račun nije upisan kao poslan (ne prepisuje istodobno slanje)
    const saved = await setStatus(inv.id, { fiscalStatus: { not: 'SENT' }, ...ownsClaim(claim.token) }, next, type === 'IR' ? 'FISCALIZED' : 'REPORTED', {
      fiscalStatus: 'SENT',
      fiscalizedAt: new Date(),
      fiscalError: null,
      ...(type === 'I' ? { eReportedAt: new Date() } : {}),
    });
    if (!saved) {
      await log(inv.companyId, inv.id, false, { request: `reportdocument ${type}`, error: `Posrednik je vratio ${r.id}, ali račun je u međuvremenu upisan kao poslan — provjerite duplikat kod posrednika.` });
      return { ok: false, message: `Posrednik je vratio ${r.id}, ali račun je u međuvremenu poslan drugim putem — provjerite duplikat kod posrednika.` };
    }
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
    // slanje ili prijava u tijeku: poništenje bi obrisalo trag koji to slanje upravo upisuje
    if (sendingNow(inv.eInvoice)) return { ok: false, message: 'eRačun se upravo šalje — pričekajte da slanje završi pa pokušajte ponovno.' };
    const { id: _id, sentAt: _s, statusText: _t, checkedAt: _c, reportType: _r, error: _e, ...all } = meta;
    const { sending: _x, ...rest } = all as InvoiceFiscalMeta & { sending?: unknown };
    const einvoiceRoute = meta.route === 'EINVOICE';
    // usporedi-i-upiši: račun se od čitanja nije mijenjao (npr. slanje nije u međuvremenu zauzelo ni upisalo ishod)
    const saved = await setStatus(inv.id, { updatedAt: inv.updatedAt }, { ...rest, status: einvoiceRoute ? 'UNKNOWN' : undefined }, null, {
      eInvoiceStatusAt: null,
      eReportedAt: null,
      ...(inv.zki ? {} : { fiscalStatus: einvoiceRoute ? 'FAILED' : 'NOT_REQUIRED', fiscalizedAt: null, fiscalError: einvoiceRoute ? 'Trag slanja eRačuna poništen — pošaljite ga ponovno ručno.' : null }),
    });
    if (!saved) return { ok: false, message: 'Račun se u međuvremenu promijenio (slanje ili prijava) — osvježite stranicu i pokušajte ponovno.' };
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
