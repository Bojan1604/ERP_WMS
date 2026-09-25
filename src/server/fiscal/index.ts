import 'server-only';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import type { Actor } from '../services/items';
import { isDomesticBusiness, truncate, UBL_PAYMENT_MEANS } from '@/domain/fiscal';
import { toISO } from '@/domain/dates';
import { num } from '@/domain/money';
import { companyCert, type ParsedCert } from './cert';
import { buildEcho, buildRacunZahtjev, parseCisResponse, postToCis, signXml, soapEnvelope, type RacunData } from './cis';
import { decryptSecret } from './crypto';
import { providerFor } from './einvoice';
import { readMeta, type InvoiceFiscalMeta } from './issue';
import { claimSend, ownsClaim } from './claim';
import { invoiceUbl } from './ubl-source';
import { withInvoicePdf } from '../pdf/einvoice';

/**
 * Fiskalizacija nakon izdavanja. Sve ovdje radi IZVAN transakcije izdavanja
 * (mrežni pozivi ne drže zaključanu bazu) i nikad ne baca: neuspjeh ostavlja
 * račun izdan, sa stanjem FAILED i porukom, a naknadna dostava ga ponavlja.
 */

export interface FiscalOutcome {
  ok: boolean;
  /** CIS/posrednik nije dostupan (mreža, istek vremena) — naknadnu dostavu nema smisla nastaviti. */
  unreachable?: boolean;
  /** Ništa nije poslano (nije potrebno ili je već poslano). */
  skipped?: boolean;
  message: string;
}

type Kind = 'FISCAL' | 'EINVOICE' | 'PAYMENT_REPORT';

async function log(companyId: string, invoiceId: string | null, kind: Kind, ok: boolean, p: { request?: string | null; response?: string | null; error?: string | null }) {
  try {
    await db.fiscalLog.create({
      data: { companyId, invoiceId, kind, ok, request: truncate(p.request), response: truncate(p.response), error: truncate(p.error, 2000) },
    });
  } catch (e) {
    console.error('[fiscal] dnevnik', e);
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

class UnreachableError extends Error {
  /** Zahtjev je možda stigao (istek vremena) — ishod nepoznat. */
  constructor(message: string, readonly uncertain = false) {
    super(message);
  }
}

// ---------------------------------------------------------------- CIS

/** Slanje računa u CIS (ili demo) i upis JIR-a. */
export async function fiscalizeInvoice(invoiceId: string, actor: Actor): Promise<FiscalOutcome> {
  const inv = await db.invoice
    .findFirst({ where: { id: invoiceId, companyId: actor.companyId }, include: { company: true } })
    .catch(() => null);
  if (!inv) return { ok: false, message: 'Račun ne postoji.' };
  if (inv.status !== 'ISSUED' || !inv.zki || inv.seq == null || !inv.issuedAt) return { ok: true, skipped: true, message: 'Račun ne ide u CIS.' };
  if (inv.jir) return { ok: true, skipped: true, message: `Račun je već fiskaliziran (JIR ${inv.jir}).` };

  // zauzimanje prije mrežnog poziva: drugi istodobni poziv ne šalje isti račun
  const claim = await claimSend(inv.id, actor.companyId, 'cis');
  if (!claim) {
    const now = await db.invoice.findUnique({ where: { id: inv.id }, select: { jir: true } });
    if (now?.jir) return { ok: true, skipped: true, message: `Račun je već fiskaliziran (JIR ${now.jir}).` };
    return { ok: false, skipped: true, message: 'Račun se upravo šalje u CIS — pričekajte i osvježite stranicu.' };
  }

  const c = inv.company;
  const meta = claim.meta;
  let request: string | null = null;
  let response: string | null = null;
  try {
    let cert: ParsedCert | null = null;
    try {
      cert = companyCert(c);
    } catch (e) {
      throw new Error(`Certifikat se ne može učitati: ${errMsg(e)}`);
    }
    // račun izdan s demo ZKI-jem ostaje u demo načinu i kad se kasnije učita certifikat
    const demo = meta.cis ? meta.cis.demo : !cert;
    if (!demo && !cert) throw new Error('Fiskalizacijski certifikat nije učitan (Postavke → Fiskalizacija).');
    const operatorOib = meta.operator?.oib;
    if (!operatorOib) throw new Error('Račun nema OIB operatera.');

    const data: RacunData = {
      oib: c.oib ?? '',
      vatRegistered: meta.cis?.vatRegistered ?? c.vatRegistered,
      issuedAt: inv.issuedAt,
      seqMode: meta.cis?.seqMode ?? (c.fiscalSequenceMode === 'N' ? 'N' : 'P'),
      seq: inv.seq,
      premises: meta.cis?.premises ?? c.invoicePremises,
      device: meta.cis?.device ?? c.invoiceDevice,
      taxCategory: inv.taxCategory,
      vatRate: num(inv.vatRate),
      net: num(inv.netTotal),
      vat: num(inv.vatTotal),
      charges: num(inv.chargesTotal),
      total: num(inv.grandTotal),
      paymentMethod: inv.paymentMethod,
      operatorOib,
      zki: inv.zki,
      lateDelivery: claim.fiscalAttempts > 0,
    };
    const unsigned = buildRacunZahtjev(data);
    let jir: string;
    if (demo) {
      request = `[DEMO — nije poslano u CIS, ZKI iz demo ključa]\n${unsigned}`;
      jir = randomUUID();
      response = `[DEMO] <tns:Jir>${jir}</tns:Jir>`;
    } else {
      const env = c.fiscalEnv === 'PROD' ? 'PROD' : 'TEST';
      request = soapEnvelope(signXml(unsigned, cert!));
      const res = await postToCis(env, request).catch((e) => {
        throw new UnreachableError(`CIS nije dostupan: ${errMsg(e)}`);
      });
      response = res.body;
      const parsed = parseCisResponse(res.body);
      if (!parsed.jir) {
        const e = parsed.errors.map((x) => `${x.code} ${x.message}`.trim()).join('; ') || `CIS je vratio HTTP ${res.status} bez JIR-a.`;
        throw new Error(e);
      }
      jir = parsed.jir;
    }
    // JIR se upisuje samo ako ga račun još nema — drugi JIR nikad ne prepisuje prvi
    const saved = await db.invoice.updateMany({
      where: { id: inv.id, jir: null },
      data: { jir, fiscalStatus: 'SENT', fiscalizedAt: new Date(), fiscalError: null, fiscalAttempts: { increment: 1 }, eInvoice: meta as Prisma.InputJsonValue },
    });
    if (!saved.count) {
      const now = await db.invoice.findUnique({ where: { id: inv.id }, select: { jir: true } });
      await log(c.id, inv.id, 'FISCAL', false, { request, response, error: `Dobiven JIR ${jir}, ali račun već ima JIR ${now?.jir ?? '?'} — novi nije upisan.` });
      return { ok: true, skipped: true, message: `Račun je već fiskaliziran (JIR ${now?.jir ?? '?'}).` };
    }
    await log(c.id, inv.id, 'FISCAL', true, { request, response });
    return { ok: true, message: demo ? `Fiskalizirano (demo) — JIR ${jir}.` : `Fiskalizirano — JIR ${jir}.` };
  } catch (e) {
    const error = errMsg(e);
    await db.invoice
      .updateMany({
        where: { id: inv.id, jir: null, ...ownsClaim(claim.token) },
        data: { fiscalStatus: 'FAILED', fiscalError: error.slice(0, 1000), fiscalAttempts: { increment: 1 }, eInvoice: meta as Prisma.InputJsonValue },
      })
      .catch((x) => console.error('[fiscal]', x));
    await log(c.id, inv.id, 'FISCAL', false, { request, response, error });
    return {
      ok: false,
      unreachable: e instanceof UnreachableError,
      message: `Fiskalizacija nije uspjela: ${error} Račun je izdan sa ZKI-jem; pokušajte ponovno (naknadna dostava).`,
    };
  }
}

// ---------------------------------------------------------------- eRačun

/**
 * Slanje eRačuna posredniku. `resendUncertain: false` (naknadna dostava) ne
 * šalje ponovno račun čije je zadnje slanje isteklo bez odgovora — možda je
 * stigao; takav se šalje ručno („Pošalji eRačun") nakon provjere kod posrednika.
 */
export async function sendEInvoice(invoiceId: string, actor: Actor, opts: { resendUncertain?: boolean } = {}): Promise<FiscalOutcome> {
  const inv = await db.invoice
    .findFirst({
      where: { id: invoiceId, companyId: actor.companyId },
      include: { company: { select: { id: true, oib: true, eInvoiceProvider: true, eInvoiceApiKey: true, fiscalEnv: true, eInvoiceAttachPdf: true } }, partner: { select: { oib: true, country: true } } },
    })
    .catch(() => null);
  if (!inv) return { ok: false, message: 'Račun ne postoji.' };
  if (inv.status !== 'ISSUED') return { ok: false, message: 'eRačun se šalje samo za izdani račun.' };
  const before = readMeta(inv.eInvoice);
  if ((before.id && before.status === 'SENT') || inv.fiscalStatus === 'SENT') return { ok: true, skipped: true, message: `eRačun je već poslan (${before.id ?? '—'}).` };
  if (!isDomesticBusiness(inv.partner)) return { ok: false, message: 'eRačun se šalje samo domaćem poslovnom subjektu s ispravnim OIB-om.' };
  if (before.status === 'UNKNOWN' && !before.id && opts.resendUncertain === false) {
    return { ok: false, skipped: true, message: 'Ishod zadnjeg slanja eRačuna nije poznat — provjerite kod posrednika i pošaljite ručno.' };
  }

  const claim = await claimSend(inv.id, actor.companyId, 'einvoice');
  if (!claim) {
    const now = await db.invoice.findUnique({ where: { id: inv.id }, select: { fiscalStatus: true, eInvoice: true } });
    if (now?.fiscalStatus === 'SENT') return { ok: true, skipped: true, message: `eRačun je već poslan (${readMeta(now.eInvoice).id ?? '—'}).` };
    return { ok: false, skipped: true, message: 'eRačun se upravo šalje — pričekajte i osvježite stranicu.' };
  }

  const c = inv.company;
  const meta = claim.meta;
  let request: string | null = null;
  let response: string | null = null;
  const next: InvoiceFiscalMeta = { ...meta, provider: c.eInvoiceProvider, env: c.fiscalEnv };
  const markSent = async (id: string, demo?: boolean, how = 'poslan posredniku') => {
    Object.assign(next, { id, status: 'SENT', sentAt: new Date().toISOString(), error: undefined });
    // ne prepisuje eRačun koji je u međuvremenu upisan kao poslan (zastarjelo zauzimanje)
    const saved = await db.invoice.updateMany({
      where: { id: inv.id, fiscalStatus: { not: 'SENT' } },
      data: {
        eInvoice: next as Prisma.InputJsonValue,
        fiscalStatus: 'SENT',
        fiscalizedAt: new Date(),
        fiscalError: null,
        fiscalAttempts: { increment: 1 },
        // preslika za filtre popisa (Invoice.eInvoiceStatus)
        eInvoiceStatus: 'SENT',
        eInvoiceStatusAt: new Date(),
      },
    });
    if (!saved.count) {
      await log(c.id, inv.id, 'EINVOICE', false, { request, response, error: `Posrednik je vratio ${id}, ali eRačun je već upisan kao poslan — provjerite duplikat kod posrednika.` });
      return { ok: true, skipped: true, message: 'eRačun je već poslan.' };
    }
    await log(c.id, inv.id, 'EINVOICE', true, { request, response });
    return { ok: true, message: demo ? `eRačun poslan (demo) — ${id}.` : `eRačun ${how} — ${id}.` };
  };
  try {
    let key: string | null = null;
    try {
      key = decryptSecret(c.eInvoiceApiKey);
    } catch {
      throw new Error('API ključ posrednika se ne može dešifrirati (promijenjen AUTH_SECRET?) — upišite ga ponovno.');
    }
    const provider = providerFor(c.eInvoiceProvider, key, c.fiscalEnv);
    if (!provider) throw new Error('Posrednik za eRačun nije odabran (Postavke → Fiskalizacija).');

    // posrednik je već dao id (npr. upis ishoda nije uspio) — prvo pitati za stanje, ne slati ponovno
    if (meta.id) {
      const st = await provider.status(meta.id);
      if (st.unreachable) throw new UnreachableError(st.error || 'Posrednik nije dostupan.');
      if (st.ok) {
        request = `status ${meta.id}`;
        response = st.raw ?? null;
        return await markSent(meta.id, st.demo, 'je već kod posrednika');
      }
    }

    const ubl = await invoiceUbl(actor.companyId, inv.id);
    if (!ubl?.xml) throw new Error('eRačun XML se ne može izraditi.');
    request = `${provider.code === 'demo' ? '[DEMO — nije poslano] ' : ''}${ubl.fileName}\n${ubl.xml}`;
    // PDF računa ugrađen u UBL (postavka „prilaži PDF"); u dnevnik ide XML bez njega
    const xml = await withInvoicePdf(ubl.xml, actor.companyId, inv.id, inv.company.eInvoiceAttachPdf);
    const r = await provider.send(xml, { number: inv.number ?? '', buyerOib: inv.partner.oib, sellerOib: c.oib });
    response = r.raw ?? null;
    if (r.unreachable) throw new UnreachableError(r.error || 'Posrednik nije dostupan.', !!r.uncertain);
    if (!r.ok || !r.id) throw new Error(r.error || 'Posrednik nije prihvatio dokument.');
    return await markSent(r.id, r.demo);
  } catch (e) {
    const error = errMsg(e);
    const uncertain = e instanceof UnreachableError && e.uncertain;
    // istek bez odgovora: dokument je možda stigao — stanje UNKNOWN, naknadna dostava ga ne šalje sama
    Object.assign(next, { status: uncertain ? 'UNKNOWN' : 'FAILED', error });
    await db.invoice
      .updateMany({
        where: { id: inv.id, fiscalStatus: { not: 'SENT' }, ...ownsClaim(claim.token) },
        data: {
          eInvoice: next as Prisma.InputJsonValue,
          fiscalStatus: 'FAILED',
          fiscalError: error.slice(0, 1000),
          fiscalAttempts: { increment: 1 },
          eInvoiceStatus: 'ERROR',
          eInvoiceStatusAt: new Date(),
        },
      })
      .catch((x) => console.error('[fiscal]', x));
    await log(c.id, inv.id, 'EINVOICE', false, { request, response, error });
    return {
      ok: false,
      unreachable: e instanceof UnreachableError,
      message: uncertain
        ? `eRačun: ${error} — nije poznato je li dokument stigao. Provjerite kod posrednika prije ponovnog slanja.`
        : `eRačun nije poslan: ${error}`,
    };
  }
}

/** eIzvještavanje o naplati: zadnja uplata na eRačun poslan posredniku. Tiho preskače ostale račune. */
export async function reportLatestPayment(invoiceId: string, actor: Actor): Promise<FiscalOutcome | null> {
  try {
    const inv = await db.invoice.findFirst({
      where: { id: invoiceId, companyId: actor.companyId },
      include: {
        company: { select: { id: true, oib: true, eInvoiceProvider: true, eInvoiceApiKey: true, fiscalEnv: true, eReportingEnabled: true } },
        partner: { select: { oib: true, vatId: true } },
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const meta = readMeta(inv?.eInvoice);
    const pay = inv?.payments[0];
    // eIzvještavanje o naplati može se isključiti u postavkama (Company.eReportingEnabled);
    // račun stranom kupcu prijavljen u eIzvještavanje (tip I) nije eRačun — naplata se ne prijavljuje
    if (!inv || !pay || !meta.id || meta.status !== 'SENT' || meta.reportType === 'I' || !inv.company.eReportingEnabled) return null;
    const provider = providerFor(meta.provider ?? inv.company.eInvoiceProvider, decryptSecret(inv.company.eInvoiceApiKey), meta.env ?? inv.company.fiscalEnv);
    if (!provider) return null;
    const report = {
      documentId: meta.id,
      issueDate: toISO(inv.date),
      supplierOib: inv.company.oib,
      customerOib: inv.partner.oib ?? inv.partner.vatId,
      paymentDate: toISO(pay.date),
      paidAmount: num(pay.amount),
      paymentType: UBL_PAYMENT_MEANS[inv.paymentMethod],
    };
    const r = await provider.reportPayment(report);
    await log(inv.company.id, inv.id, 'PAYMENT_REPORT', r.ok, { request: JSON.stringify(report), response: r.raw ?? null, error: r.ok ? null : r.error });
    return { ok: r.ok, message: r.ok ? 'Naplata prijavljena posredniku.' : `Prijava naplate nije uspjela: ${r.error}` };
  } catch (e) {
    console.error('[fiscal] prijava naplate', e);
    return { ok: false, message: `Prijava naplate nije uspjela: ${errMsg(e)}` };
  }
}

// ---------------------------------------------------------------- nakon izdavanja, naknadna dostava

/** Što treba nakon izdavanja: CIS (ima ZKI) ili eRačun. Null = ništa. */
export async function afterIssue(invoiceId: string, actor: Actor, opts: { resendUncertain?: boolean } = {}): Promise<FiscalOutcome | null> {
  try {
    const inv = await db.invoice.findFirst({ where: { id: invoiceId, companyId: actor.companyId }, select: { zki: true, fiscalStatus: true, eInvoice: true } });
    if (!inv || inv.fiscalStatus === 'NOT_REQUIRED' || inv.fiscalStatus === 'SENT') return null;
    if (inv.zki) return await fiscalizeInvoice(invoiceId, actor);
    if (readMeta(inv.eInvoice).route === 'EINVOICE') return await sendEInvoice(invoiceId, actor, opts);
    return null;
  } catch (e) {
    console.error('[fiscal] afterIssue', e);
    return { ok: false, message: `Fiskalizacija nije uspjela: ${errMsg(e)}` };
  }
}

/** Poruka akcije s dodanim ishodom fiskalizacije. */
export const withOutcome = (message: string, o: FiscalOutcome | null) => (o && !o.skipped ? `${message} ${o.message}` : message);

/** Najdulje trajanje jedne naknadne dostave (ostali računi čekaju sljedeću). */
export const RETRY_BATCH_MS = 60_000;

/**
 * Naknadna dostava: svi računi koji čekaju ili su pali (najviše `limit`, najstariji prvi).
 * Nedostupan CIS zaustavlja ostale račune za CIS, nedostupan posrednik ostale
 * eRačune; cijela dostava traje najviše `maxMs`.
 */
export async function retryPending(actor: Actor, limit = 50, maxMs = RETRY_BATCH_MS) {
  const deadline = Date.now() + maxMs;
  const rows = await db.invoice.findMany({
    where: { companyId: actor.companyId, status: 'ISSUED', fiscalStatus: { in: ['PENDING', 'FAILED'] } },
    orderBy: [{ issuedAt: 'asc' }],
    take: limit,
    select: { id: true, zki: true },
  });
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let cisDown: string | null = null;
  let providerDown: string | null = null;
  let timedOut = false;
  for (const r of rows) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    // nedostupan CIS/posrednik: ostali računi istog puta čekaju sljedeći pokušaj
    if (r.zki ? cisDown : providerDown) continue;
    const o = await afterIssue(r.id, actor, { resendUncertain: false });
    if (o?.skipped) skipped++;
    else if (o?.ok) ok++;
    else if (o) failed++;
    if (o?.unreachable) {
      if (r.zki) cisDown = o.message;
      else providerDown = o.message;
    }
  }
  const remaining = await db.invoice.count({ where: { companyId: actor.companyId, status: 'ISSUED', fiscalStatus: { in: ['PENDING', 'FAILED'] } } });
  const stopped =
    [cisDown && 'CIS nije dostupan', providerDown && 'posrednik za eRačun nije dostupan', timedOut && `prekinuto nakon ${Math.round(maxMs / 1000)} s`]
      .filter(Boolean)
      .join(', ') || null;
  return { total: rows.length, ok, failed, skipped, remaining, stopped };
}

// ---------------------------------------------------------------- provjera veze

export async function testConnection(companyId: string): Promise<{ cis: FiscalOutcome; provider: FiscalOutcome | null }> {
  const c = await db.company.findUniqueOrThrow({ where: { id: companyId } });
  let cis: FiscalOutcome;
  let cert: ParsedCert | null = null;
  let certError: string | null = null;
  try {
    cert = companyCert(c);
  } catch (e) {
    certError = errMsg(e);
  }
  const env = c.fiscalEnv === 'PROD' ? 'PROD' : 'TEST';
  if (certError) {
    cis = { ok: false, message: `Certifikat se ne može učitati: ${certError}` };
  } else if (!cert && env === 'TEST') {
    cis = { ok: true, message: 'CIS: demo način (nema certifikata) — veza se simulira.' };
    await log(c.id, null, 'FISCAL', true, { request: '[DEMO] EchoRequest', response: '[DEMO] EchoResponse' });
  } else {
    const req = soapEnvelope(buildEcho('Provjera veze'));
    try {
      const res = await postToCis(env, req, 'echo');
      const p = parseCisResponse(res.body);
      cis = p.echo ? { ok: true, message: `CIS ${env}: veza radi (echo „${p.echo}").` } : { ok: false, message: `CIS ${env}: neočekivan odgovor (HTTP ${res.status}).` };
      await log(c.id, null, 'FISCAL', cis.ok, { request: req, response: res.body, error: cis.ok ? null : cis.message });
    } catch (e) {
      cis = { ok: false, message: `CIS ${env}: ${errMsg(e)}` };
      await log(c.id, null, 'FISCAL', false, { request: req, error: errMsg(e) });
    }
  }
  let provider: FiscalOutcome | null = null;
  try {
    const p = providerFor(c.eInvoiceProvider, decryptSecret(c.eInvoiceApiKey), c.fiscalEnv);
    if (p) {
      const r = await p.ping();
      provider = { ok: r.ok, message: r.ok ? `Posrednik (${p.code}${r.demo ? ', demo' : ''}): veza radi.` : `Posrednik (${p.code}): ${r.error}` };
      await log(c.id, null, 'EINVOICE', r.ok, { request: 'ping', response: r.raw ?? null, error: r.ok ? null : r.error });
    }
  } catch (e) {
    provider = { ok: false, message: `Posrednik: ${errMsg(e)}` };
  }
  return { cis, provider };
}
