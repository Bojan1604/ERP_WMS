import 'server-only';
import { Prisma } from '@prisma/client';
import { db, transaction, type Tx } from '../db';
import { DomainError, assert } from '../errors';
import { audit } from '../audit';
import { nextDocNumber } from '../numbering';
import type { Actor } from './items';
import { companyProvider, log } from './inbound';
import { parseUbl, signedAmounts, ublPdf, type ParsedUbl } from '@/domain/ubl-parse';
import type { IncomingDoc } from '@/domain/einvoice-inbound';
import { sniffMime } from '@/domain/attachments';
import { fromISO, today } from '@/domain/dates';

// =============================================================================
//  Preuzimanje primljenih eRačuna od informacijskog posrednika (Fiskalizacija 2.0).
//  Mrežni pozivi idu izvan transakcije; svaki novi dokument se upisuje u svojoj.
// =============================================================================

/** Najviše dokumenata po jednom preuzimanju. */
export const INBOUND_FETCH_LIMIT = 200;
/** Istodobnih dohvata XML-a. */
const XML_CONCURRENCY = 4;
/** Veći XML se ne sprema (zaštita baze); PDF prilog ima ograničenje priloga. */
const XML_MAX_BYTES = 20 * 1024 * 1024;
const PDF_MAX_BYTES = 10 * 1024 * 1024;

export interface FetchResult {
  found: number;
  created: number;
  existing: number;
  failed: number;
  errors: string[];
  demo: boolean;
}

/**
 * Preuzimanje primljenih eRačuna: novi (po id-u posrednika) se čitaju iz XML-a
 * i upisuju kao ulazni računi u statusu „zaprimljen", s XML-om i PDF-om kao
 * prilozima. Dokument čiji se XML ne može dohvatiti ili pročitati se preskače
 * (sljedeće preuzimanje ga pokušava ponovno).
 */
export async function fetchIncoming(actor: Actor, limit = INBOUND_FETCH_LIMIT): Promise<FetchResult> {
  const { provider, env, companyOib } = await companyProvider(actor.companyId);
  assert(provider.incoming && provider.documentXml, `Posrednik „${provider.code}" ne podržava preuzimanje ulaznih računa.`);
  const take = Math.max(1, Math.min(limit, INBOUND_FETCH_LIMIT));
  const r = await provider.incoming({ limit: take, offset: 0 });
  await log(actor.companyId, r.ok, `document/incoming?limit=${take}`, r);
  if (!r.ok) throw new DomainError(`Preuzimanje nije uspjelo: ${r.error ?? 'posrednik nije odgovorio'}`);

  // isti id može doći dvaput u istom odgovoru
  const docs = [...new Map((r.docs ?? []).map((d) => [d.id, d])).values()].slice(0, take);
  const out: FetchResult = { found: docs.length, created: 0, existing: 0, failed: 0, errors: [], demo: !!r.demo };
  const known = docs.length
    ? await db.supplierInvoice.findMany({
        where: { companyId: actor.companyId, eInvoiceId: { in: docs.map((d) => d.id) } },
        select: { id: true, eInvoiceId: true, status: true, providerStatus: true },
      })
    : [];
  const byId = new Map(known.map((k) => [k.eInvoiceId!, k]));
  out.existing = known.length;

  // svježi status posrednika za već upisane, dok čekaju odluku (samo za prikaz); nakon odluke vrijedi
  // status koji je posrednik potvrdio na promjenu (popis ulaznih zna kasniti)
  for (const d of docs) {
    const k = byId.get(d.id);
    if (k && k.status === 'RECEIVED' && d.status && d.status !== k.providerStatus) {
      await db.supplierInvoice.updateMany({ where: { id: k.id, companyId: actor.companyId }, data: { providerStatus: d.status } });
    }
  }

  const fresh = docs.filter((d) => !byId.has(d.id));
  for (let i = 0; i < fresh.length; i += XML_CONCURRENCY) {
    const part = fresh.slice(i, i + XML_CONCURRENCY);
    const xmls = await Promise.all(part.map((d) => provider.documentXml!(d.id)));
    for (let j = 0; j < part.length; j++) {
      const d = part[j];
      const x = xmls[j];
      const label = d.number && d.number !== d.id ? `${d.number} (${d.id})` : d.id;
      if (!x.ok || !x.xml) {
        await log(actor.companyId, false, `document/get/${d.id}`, x);
        out.failed++;
        out.errors.push(`${label}: XML nije dostupan — ${x.error ?? 'nepoznata greška'}`);
        continue;
      }
      const parsed = parseUbl(x.xml);
      if (!parsed) {
        out.failed++;
        out.errors.push(`${label}: XML nije UBL račun ni odobrenje.`);
        continue;
      }
      if (Buffer.byteLength(x.xml, 'utf8') > XML_MAX_BYTES) {
        out.failed++;
        out.errors.push(`${label}: XML je veći od ${XML_MAX_BYTES / 1024 / 1024} MB.`);
        continue;
      }
      try {
        await transaction((tx) => createFromEInvoice(tx, actor, { doc: d, xml: x.xml!, parsed, env, companyOib }));
        out.created++;
      } catch (e) {
        // istodobno preuzimanje je već upisalo isti dokument
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          out.existing++;
          continue;
        }
        out.failed++;
        out.errors.push(`${label}: ${e instanceof DomainError ? e.message : 'upis nije uspio'}`);
        if (!(e instanceof DomainError)) console.error('[inbound] upis', d.id, e);
      }
    }
  }

  await transaction((tx) =>
    audit(tx, actor, {
      entity: 'supplierInvoice',
      action: 'fetch',
      summary: `Preuzimanje eRačuna${out.demo ? ' (demo)' : ''}: ${out.found} kod posrednika, ${out.created} novih, ${out.existing} već upisanih${out.failed ? `, ${out.failed} neuspjelih` : ''}`,
      diff: out.errors.length ? { errors: out.errors.slice(0, 20) } : undefined,
    }),
  );
  return out;
}

/** Dobavljač po OIB-u (pa PDV ID-u); ako ga nema, otvara se novi partner-dobavljač. */
export async function matchSupplier(tx: Tx, actor: Actor, p: ParsedUbl['supplier'], fallbackName: string) {
  const ids = [p.oib, p.oib ? `HR${p.oib}` : '', p.vatId].filter(Boolean);
  const found = ids.length
    ? await tx.partner.findFirst({
        where: { companyId: actor.companyId, OR: [{ oib: { in: ids } }, ...(p.vatId ? [{ vatId: { equals: p.vatId, mode: 'insensitive' as const } }] : [])] },
        orderBy: [{ isSupplier: 'desc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, isSupplier: true },
      })
    : null;
  if (found) {
    if (!found.isSupplier) await tx.partner.update({ where: { id: found.id }, data: { isSupplier: true } });
    return { id: found.id, name: found.name, created: false };
  }
  const name = (p.name || fallbackName || `Dobavljač ${p.oib || p.vatId || ''}`).trim().slice(0, 200);
  const c = await tx.partner.create({
    data: {
      companyId: actor.companyId,
      name,
      oib: p.oib || null,
      vatId: p.vatId || null,
      address: p.address || null,
      zip: p.zip || null,
      city: p.city || null,
      country: p.country || 'HR',
      isSupplier: true,
      isCustomer: false,
      note: 'Otvoren iz primljenog eRačuna.',
    },
    select: { id: true, name: true },
  });
  await audit(tx, actor, { entity: 'partner', entityId: c.id, action: 'create', summary: `Dobavljač ${c.name} otvoren iz primljenog eRačuna` });
  return { ...c, created: true };
}

export interface NewEInvoice {
  doc: IncomingDoc;
  xml: string;
  parsed: ParsedUbl;
  env: string;
  companyOib: string | null;
}

/** Upis jednog primljenog eRačuna (u transakciji pozivatelja). */
export async function createFromEInvoice(tx: Tx, actor: Actor, n: NewEInvoice) {
  const { doc, parsed } = n;
  const supplier = await matchSupplier(tx, actor, { ...parsed.supplier, oib: parsed.supplier.oib || doc.supplierOib }, doc.supplierName);
  const issueDate = parsed.issueDate || doc.issueDate || doc.insertedOn || today();
  assert(/^\d{4}-\d{2}-\d{2}$/.test(issueDate), 'Neispravan datum računa.');
  const number = (parsed.number || doc.number || doc.id).slice(0, 100);
  const amounts = signedAmounts(parsed);

  // upozorenja za korisnika (vidljiva u napomeni): tuđi kupac, druga valuta, mogući duplikat ručnog upisa
  const notes: string[] = [];
  if (parsed.credit) notes.push('Knjižno odobrenje (iznosi su negativni).');
  if (parsed.customer.oib && n.companyOib && parsed.customer.oib !== n.companyOib) {
    notes.push(`Upozorenje: OIB kupca na računu (${parsed.customer.oib}) nije OIB firme.`);
  }
  if (parsed.currency && parsed.currency !== 'EUR') notes.push(`Valuta dokumenta: ${parsed.currency}.`);
  const dup = await tx.supplierInvoice.findFirst({
    where: { companyId: actor.companyId, supplierId: supplier.id, number },
    select: { internalNo: true },
  });
  if (dup) notes.push(`Mogući duplikat: isti broj računa tog dobavljača već je upisan (${dup.internalNo}).`);
  if (parsed.note) notes.push(parsed.note.slice(0, 1000));

  const internalNo = await nextDocNumber(tx, actor.companyId, 'SUPPLIER_INVOICE', Number(issueDate.slice(0, 4)));
  const si = await tx.supplierInvoice.create({
    data: {
      companyId: actor.companyId,
      internalNo,
      number,
      supplierId: supplier.id,
      issueDate: fromISO(issueDate),
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate) ? fromISO(parsed.dueDate) : null,
      netAmount: amounts.net,
      vatAmount: amounts.vat,
      total: amounts.total,
      note: notes.join('\n') || null,
      source: 'EINVOICE',
      status: 'RECEIVED',
      eInvoiceId: doc.id,
      eInvoiceEnv: n.env,
      providerStatus: doc.status || null,
    },
    select: { id: true, internalNo: true },
  });

  // izvorni XML je pravni original eRačuna — čuva se uz račun (ide i u ZIP za knjigovođu)
  const stem = number.replace(/[^\w.-]+/g, '-').slice(0, 80) || si.internalNo;
  const xmlBytes = Buffer.from(n.xml, 'utf8');
  await tx.attachment.create({
    data: {
      companyId: actor.companyId,
      entity: 'supplierInvoice',
      entityId: si.id,
      fileName: `eRacun-${stem}.xml`,
      mime: 'application/xml',
      size: xmlBytes.byteLength,
      data: xmlBytes,
      createdBy: actor.name,
    },
  });
  const pdf = ublPdf(parsed);
  if (pdf) {
    const bytes = Buffer.from(pdf.base64, 'base64');
    // samo stvarni PDF (po sadržaju), razumne veličine
    if (bytes.byteLength > 0 && bytes.byteLength <= PDF_MAX_BYTES && sniffMime(bytes) === 'application/pdf') {
      await tx.attachment.create({
        data: {
          companyId: actor.companyId,
          entity: 'supplierInvoice',
          entityId: si.id,
          fileName: /\.pdf$/i.test(pdf.fileName) ? pdf.fileName.slice(-120) : `${stem}.pdf`,
          mime: 'application/pdf',
          size: bytes.byteLength,
          data: bytes,
          createdBy: actor.name,
        },
      });
    }
  }

  await audit(tx, actor, {
    entity: 'supplierInvoice',
    entityId: si.id,
    action: 'receive',
    summary: `eRačun ${number} (${supplier.name}) preuzet kao ${si.internalNo}${supplier.created ? ' — dobavljač otvoren' : ''}`,
    diff: { eInvoiceId: doc.id, total: amounts.total },
  });
  return si;
}
