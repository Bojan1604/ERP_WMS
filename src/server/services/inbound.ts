import 'server-only';
import { db, transaction, type Tx } from '../db';
import { DomainError, assert } from '../errors';
import { audit } from '../audit';
import { decryptSecret } from '../fiscal/crypto';
import { providerFor, type EInvoiceProvider, type ProviderResult } from '../fiscal/einvoice';
import type { Actor } from './items';
import { applyInvoiceExpense, setSupplierInvoicesPaid } from './supplier-invoices';
import { truncate } from '@/domain/fiscal';
import { parseUbl, ublPdf } from '@/domain/ubl-parse';
import { sniffMime } from '@/domain/attachments';
import { today } from '@/domain/dates';

// =============================================================================
//  Ulazni eRačuni (Fiskalizacija 2.0): prihvaćanje, odbijanje i plaćanje
//  (preuzimanje od posrednika → inbound-fetch.ts). Mrežni pozivi idu IZVAN transakcije — baza se mijenja
//  tek kad posrednik potvrdi, pa odbijen račun u programu znači i odbijen kod
//  posrednika (i prijavljen Poreznoj upravi).
// =============================================================================

/** Posrednik firme; baca poruku za korisnika ako nije postavljen. */
export async function companyProvider(companyId: string) {
  const c = await db.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { id: true, oib: true, eInvoiceProvider: true, eInvoiceApiKey: true, fiscalEnv: true },
  });
  let key: string | null = null;
  try {
    key = decryptSecret(c.eInvoiceApiKey);
  } catch {
    throw new DomainError('API ključ posrednika se ne može dešifrirati (promijenjen AUTH_SECRET?) — upišite ga ponovno u Postavke → Fiskalizacija.');
  }
  const provider = providerFor(c.eInvoiceProvider, key, c.fiscalEnv);
  assert(provider, 'Posrednik za eRačun nije odabran (Postavke → Fiskalizacija).');
  return { provider, env: c.fiscalEnv === 'PROD' ? 'PROD' : 'TEST', companyOib: c.oib };
}

/** Zapis u dnevnik posrednika (Postavke → Fiskalizacija); nikad ne baca. */
export async function log(companyId: string, ok: boolean, request: string, r: ProviderResult | null, error?: string | null) {
  try {
    await db.fiscalLog.create({
      data: { companyId, invoiceId: null, kind: 'INBOUND', ok, request: truncate(request), response: truncate(r?.raw ?? null), error: truncate(error ?? r?.error ?? null, 2000) },
    });
  } catch (e) {
    console.error('[inbound] dnevnik', e);
  }
}

// ---------------------------------------------------------------- odluka kupca

async function loadInvoice(companyId: string, id: string) {
  const si = await db.supplierInvoice.findFirst({
    where: { id, companyId },
    select: {
      id: true, internalNo: true, number: true, source: true, status: true, eInvoiceId: true, paidDate: true,
      category: true, note: true, issueDate: true, netAmount: true, vatAmount: true,
      supplier: { select: { id: true, name: true } },
    },
  });
  assert(si, 'Ulazni račun ne postoji.');
  return si;
}

/** Posrednik za eRačun zapis; ručni račun nema posrednika. */
async function providerForRow(companyId: string, si: { source: string; eInvoiceId: string | null }): Promise<EInvoiceProvider | null> {
  if (si.source !== 'EINVOICE' || !si.eInvoiceId) return null;
  const { provider } = await companyProvider(companyId);
  assert(provider.changeStatus, `Posrednik „${provider.code}" ne podržava promjenu statusa ulaznog računa.`);
  return provider;
}

/**
 * Prihvaćanje: eRačun se prvo prihvaća kod posrednika (status 5; „već je u tom
 * statusu" je uspjeh), zatim se u programu upisuje status i knjiži trošak.
 */
export async function acceptSupplierInvoice(actor: Actor, id: string, opts: { book?: boolean } = {}) {
  const si = await loadInvoice(actor.companyId, id);
  assert(si.status === 'RECEIVED', si.status === 'ACCEPTED' ? 'Račun je već prihvaćen.' : 'Odbijeni račun se ne može prihvatiti.');
  const provider = await providerForRow(actor.companyId, si);
  let already = false;
  if (provider) {
    const r = await provider.changeStatus!(si.eInvoiceId!, { status: 'ACCEPTED', note: '' });
    await log(actor.companyId, r.ok, `changestatus ${si.eInvoiceId} → ACCEPTED`, r);
    if (!r.ok) throw new DomainError(`Posrednik nije prihvatio promjenu statusa: ${r.error ?? 'nepoznata greška'}`);
    already = !!r.already;
  }
  const book = opts.book ?? true;
  await transaction(async (tx) => {
    const n = await tx.supplierInvoice.updateMany({
      where: { id, companyId: actor.companyId, status: 'RECEIVED' },
      data: { status: 'ACCEPTED', statusAt: new Date(), statusBy: actor.name, ...(provider ? { providerStatus: 'prihvaćen' } : {}) },
    });
    assert(n.count, 'Račun je u međuvremenu promijenjen — osvježite stranicu.');
    if (book) await bookExpense(tx, actor, si);
    await audit(tx, actor, {
      entity: 'supplierInvoice',
      entityId: id,
      action: 'accept',
      summary: `Ulazni račun ${si.internalNo} (${si.number}, ${si.supplier.name}) prihvaćen${provider ? (already ? ' — posrednik ga je već imao kao prihvaćen' : ' i javljen posredniku') : ''}${book ? ', knjižen trošak' : ''}`,
    });
  });
  return { already, reported: !!provider };
}

/** Trošak uz ulazni račun (kao kvačica „Knjiži kao trošak" na obrascu) — po pravilu „roba se knjiži jednom". */
async function bookExpense(tx: Tx, actor: Actor, si: Awaited<ReturnType<typeof loadInvoice>>) {
  await applyInvoiceExpense(tx, actor, si.id, true);
}

/**
 * Odbijanje: razlog je obvezan. eRačun: status 6 kod posrednika, pa prijava
 * odbijanja (eIzvještavanje, Porezna uprava); tek nakon oba uspjeha račun je u
 * programu odbijen. Ponovni pokušaj nakon djelomičnog uspjeha je siguran
 * („već je u statusu" se prihvaća). Knjiženi trošak se briše.
 */
export async function rejectSupplierInvoice(actor: Actor, id: string, reason: string) {
  const note = reason.replace(/\s+/g, ' ').trim();
  assert(note.length >= 3, 'Upišite razlog odbijanja.');
  assert(note.length <= 500, 'Razlog odbijanja je predug (najviše 500 znakova).');
  const si = await loadInvoice(actor.companyId, id);
  assert(si.status !== 'REJECTED', 'Račun je već odbijen.');
  assert(!si.paidDate, 'Plaćeni račun se ne može odbiti — prvo poništite plaćanje.');
  const provider = await providerForRow(actor.companyId, si);
  if (provider) {
    assert(provider.reportRejected, `Posrednik „${provider.code}" ne podržava prijavu odbijanja.`);
    const r = await provider.changeStatus!(si.eInvoiceId!, { status: 'REJECTED', note });
    await log(actor.companyId, r.ok, `changestatus ${si.eInvoiceId} → REJECTED: ${note}`, r);
    if (!r.ok) throw new DomainError(`Posrednik nije prihvatio odbijanje: ${r.error ?? 'nepoznata greška'}`);
    const rep = await provider.reportRejected({ documentId: si.eInvoiceId!, note, rejectionDate: today() });
    await log(actor.companyId, rep.ok, `ereporting/rejected ${si.eInvoiceId}: ${note}`, rep);
    if (!rep.ok) {
      await db.supplierInvoice.updateMany({ where: { id, companyId: actor.companyId }, data: { providerStatus: 'odbijen — prijava PU nije uspjela' } });
      throw new DomainError(
        `Posrednik je račun označio kao odbijen, ali prijava odbijanja Poreznoj upravi nije uspjela: ${rep.error ?? 'nepoznata greška'}. Pokušajte ponovno — račun u programu još nije odbijen.`,
      );
    }
  }
  await transaction(async (tx) => {
    const n = await tx.supplierInvoice.updateMany({
      where: { id, companyId: actor.companyId, status: { not: 'REJECTED' }, paidDate: null },
      data: { status: 'REJECTED', rejectReason: note, statusAt: new Date(), statusBy: actor.name, ...(provider ? { providerStatus: 'odbijen' } : {}) },
    });
    assert(n.count, 'Račun je u međuvremenu promijenjen — osvježite stranicu.');
    // odbijen račun nije trošak ni obveza
    await tx.expense.deleteMany({ where: { supplierInvoiceId: id, companyId: actor.companyId } });
    await audit(tx, actor, {
      entity: 'supplierInvoice',
      entityId: id,
      action: 'reject',
      summary: `Ulazni račun ${si.internalNo} (${si.number}, ${si.supplier.name}) odbijen${provider ? ' i prijavljen posredniku i Poreznoj upravi' : ' (ručni — samo u programu)'}: ${note}`,
    });
  });
  return { reported: !!provider };
}

// ---------------------------------------------------------------- plaćanje

/**
 * Označavanje plaćenim (ili neplaćenim) u programu, pa za eRačune koji su upravo
 * plaćeni status 8 kod posrednika. Neuspjeh kod posrednika ne poništava plaćanje
 * — vraća se kao upozorenje (kao u starom programu).
 */
export async function markSupplierInvoicesPaid(actor: Actor, ids: string[], paidDate: string | null) {
  const before = await db.supplierInvoice.findMany({
    where: { id: { in: ids }, companyId: actor.companyId },
    select: { id: true, source: true, eInvoiceId: true, paidDate: true },
  });
  const count = await transaction((tx) => setSupplierInvoicesPaid(tx, actor, ids, paidDate));
  const warning = paidDate ? await reportPaid(actor, before.filter((r) => !r.paidDate), paidDate) : null;
  return { count, warning };
}

/** Status „plaćen" posredniku za eRačune; vraća upozorenje ili null. */
export async function reportPaid(actor: Actor, rows: Array<{ id: string; source: string; eInvoiceId: string | null }>, paidDate: string) {
  const eRows = rows.filter((r) => r.source === 'EINVOICE' && r.eInvoiceId);
  if (!eRows.length) return null;
  let provider: EInvoiceProvider;
  try {
    provider = (await companyProvider(actor.companyId)).provider;
  } catch (e) {
    return `Plaćanje je zabilježeno, ali posredniku nije javljeno: ${e instanceof Error ? e.message : e}`;
  }
  if (!provider.changeStatus) return `Plaćanje je zabilježeno, ali posrednik „${provider.code}" ne prima status plaćanja.`;
  const failed: string[] = [];
  for (const r of eRows) {
    const res = await provider.changeStatus(r.eInvoiceId!, { status: 'PAID', note: '', date: paidDate });
    await log(actor.companyId, res.ok, `changestatus ${r.eInvoiceId} → PAID (${paidDate})`, res);
    if (res.ok) await db.supplierInvoice.updateMany({ where: { id: r.id, companyId: actor.companyId }, data: { providerStatus: 'plaćen' } });
    else failed.push(res.error ?? 'nepoznata greška');
  }
  return failed.length
    ? `Plaćanje je zabilježeno u programu, ali posrednik nije prihvatio status „plaćen" za ${failed.length} eRačun(a): ${[...new Set(failed)].slice(0, 3).join('; ')}`
    : null;
}

// ---------------------------------------------------------------- PDF posrednika

/**
 * „PDF posrednika" na zahtjev: izvorni dokument se ponovno dohvaća od posrednika
 * i iz njega se uzima ugrađeni PDF (AdditionalDocumentReference). PDF se sprema
 * kao prilog računa (ako već nije) i vraća se njegov id.
 */
export async function fetchProviderPdf(actor: Actor, id: string): Promise<{ attachmentId: string; created: boolean }> {
  const si = await db.supplierInvoice.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, internalNo: true, number: true, source: true, eInvoiceId: true } });
  assert(si, 'Ulazni račun ne postoji.');
  assert(si.source === 'EINVOICE' && si.eInvoiceId, 'PDF posrednika postoji samo za eRačune preuzete od posrednika.');
  const { provider } = await companyProvider(actor.companyId);
  assert(provider.documentXml, `Posrednik „${provider.code}" ne vraća izvorni dokument.`);
  const r = await provider.documentXml(si.eInvoiceId);
  await log(actor.companyId, r.ok, `document ${si.eInvoiceId} (PDF)`, r);
  if (!r.ok || !r.xml) throw new DomainError(`Posrednik nije vratio dokument: ${r.error ?? 'nepoznata greška'}`);
  const parsed = parseUbl(r.xml);
  const pdf = parsed ? ublPdf(parsed) : null;
  if (!pdf) throw new DomainError('Dobavljač u eRačun nije ugradio PDF — posrednik ga nema za ovaj dokument.');
  const bytes = Buffer.from(pdf.base64, 'base64');
  assert(bytes.byteLength > 0 && bytes.byteLength <= 10 * 1024 * 1024 && sniffMime(bytes) === 'application/pdf', 'Ugrađeni dokument nije ispravan PDF (ili je veći od 10 MB).');
  const fileName = /\.pdf$/i.test(pdf.fileName) ? pdf.fileName.slice(-120) : `${si.number.replace(/[^\w.-]+/g, '-').slice(0, 80) || si.internalNo}.pdf`;
  return transaction(async (tx) => {
    const same = await tx.attachment.findFirst({ where: { companyId: actor.companyId, entity: 'supplierInvoice', entityId: si.id, mime: 'application/pdf', size: bytes.byteLength }, select: { id: true } });
    if (same) return { attachmentId: same.id, created: false };
    const a = await tx.attachment.create({
      data: { companyId: actor.companyId, entity: 'supplierInvoice', entityId: si.id, fileName, mime: 'application/pdf', size: bytes.byteLength, data: bytes, createdBy: actor.name },
      select: { id: true },
    });
    await audit(tx, actor, { entity: 'supplierInvoice', entityId: si.id, action: 'pdf', summary: `Ulazni račun ${si.internalNo}: preuzet PDF posrednika` });
    return { attachmentId: a.id, created: true };
  });
}
