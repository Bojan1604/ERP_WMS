import 'server-only';
import { z } from 'zod';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import type { Actor } from './items';
import { can, canSeeCost, type Level, type Module, type PermissionMap } from '@/domain/permissions';
import {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_DOC_BYTES, ATTACHMENT_MAX_PER_ENTITY, ATTACHMENT_MAX_PER_REQUEST, safeFileName, sniffMime,
} from '@/domain/attachments';

/**
 * Prilozi uz zapise (slike naljepnica, PDF). Sadržaj je u bazi (Attachment.data),
 * pa ide u istu transakciju i sigurnosnu kopiju kao i sam zapis.
 */

/**
 * Koje vrste zapisa primaju priloge: modul i razina za pregled/dodavanje/brisanje,
 * najveći broj priloga po zapisu i najveća veličina jedne datoteke. `label` je
 * naziv zapisa u dnevniku („Prilog uz ugovor…").
 */
export const ATTACHMENT_ENTITIES = {
  item: { module: 'warehouse', view: 'view', add: 'ops', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_BYTES, label: 'uređaj' },
  request: { module: 'warehouse', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_REQUEST, maxBytes: ATTACHMENT_MAX_BYTES, label: 'zahtjev' },
  contract: { module: 'rentals', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_DOC_BYTES, label: 'ugovor' },
  invoice: { module: 'sales', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_DOC_BYTES, label: 'račun' },
  supplierInvoice: { module: 'purchasing', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_DOC_BYTES, label: 'ulazni račun' },
  purchaseOrder: { module: 'purchasing', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_DOC_BYTES, label: 'narudžbenicu' },
  receipt: { module: 'purchasing', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_DOC_BYTES, label: 'primku' },
  expense: { module: 'expenses', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_DOC_BYTES, label: 'trošak' },
  serviceOrder: { module: 'service', view: 'view', add: 'edit', remove: 'edit', max: ATTACHMENT_MAX_PER_ENTITY, maxBytes: ATTACHMENT_MAX_DOC_BYTES, label: 'servisni nalog' },
} as const satisfies Record<
  string,
  { module: Module; view: Exclude<Level, 'none'>; add: Exclude<Level, 'none'>; remove: Exclude<Level, 'none'>; max: number; maxBytes: number; label: string }
>;

export type AttachmentEntity = keyof typeof ATTACHMENT_ENTITIES;

export const isAttachmentEntity = (e: string): e is AttachmentEntity => Object.hasOwn(ATTACHMENT_ENTITIES, e);

/** Postoji li zapis u firmi (id iz obrasca nikad bez te provjere). */
async function ensureEntity(tx: Tx, companyId: string, entity: AttachmentEntity, entityId: string) {
  const where = { id: entityId, companyId };
  const select = { id: true } as const;
  let found: { id: string } | null;
  switch (entity) {
    case 'item':
      found = await tx.item.findFirst({ where, select });
      break;
    case 'request':
      found = await tx.approvalRequest.findFirst({ where, select });
      break;
    case 'contract':
      found = await tx.contract.findFirst({ where, select });
      break;
    case 'invoice':
      found = await tx.invoice.findFirst({ where, select });
      break;
    case 'supplierInvoice':
      found = await tx.supplierInvoice.findFirst({ where, select });
      break;
    case 'purchaseOrder':
      found = await tx.purchaseOrder.findFirst({ where, select });
      break;
    case 'receipt':
      found = await tx.goodsReceipt.findFirst({ where, select });
      break;
    case 'expense':
      found = await tx.expense.findFirst({ where, select });
      break;
    case 'serviceOrder':
      found = await tx.serviceOrder.findFirst({ where, select });
      break;
  }
  assert(found, 'Zapis kojem se dodaje prilog ne postoji.');
}

/**
 * Izvorni dokumenti koje korisnik ne smije obrisati kroz priloge: XML preuzetog
 * eRačuna (ulazni račun) — on je zakonski izvornik.
 */
export const isProtectedAttachment = (a: { entity: string; mime: string }) => a.entity === 'supplierInvoice' && a.mime === 'application/xml';

export interface NewAttachment {
  entity: AttachmentEntity;
  entityId: string;
  fileName: string | null;
  data: Uint8Array<ArrayBuffer>;
}

export const attachmentMeta = { id: true, entity: true, entityId: true, fileName: true, mime: true, size: true, public: true, createdAt: true, createdBy: true } as const;

/** Dodaje priloge jednom zapisu; vrsta se provjerava po sadržaju, ne po nazivu. */
export async function addAttachments(
  tx: Tx,
  actor: Actor,
  entity: AttachmentEntity,
  entityId: string,
  files: Array<{ fileName: string | null; data: Uint8Array<ArrayBuffer> }>,
  opts: { public?: boolean } = {},
) {
  if (!files.length) return [];
  await ensureEntity(tx, actor.companyId, entity, entityId);
  const have = await tx.attachment.count({ where: { companyId: actor.companyId, entity, entityId } });
  const { max, maxBytes } = ATTACHMENT_ENTITIES[entity];
  assert(have + files.length <= max, `Najviše ${max} priloga po zapisu${have ? ` (već ih ima ${have})` : ''}.`);
  const rows = files.map((f) => {
    assert(f.data.byteLength > 0, 'Prazna datoteka.');
    assert(f.data.byteLength <= maxBytes, `Datoteka „${f.fileName ?? ''}" je veća od ${maxBytes / 1024 / 1024} MB.`);
    const mime = sniffMime(f.data);
    assert(mime, `Datoteka „${f.fileName ?? ''}" nije slika (JPEG, PNG, WebP) ni PDF.`);
    return {
      companyId: actor.companyId,
      entity,
      entityId,
      fileName: safeFileName(f.fileName, mime),
      mime,
      size: f.data.byteLength,
      data: f.data,
      // vidljivo klijentu na portalu — samo prilozi servisnog naloga
      public: entity === 'serviceOrder' && !!opts.public,
      createdBy: actor.name,
    };
  });
  // createManyAndReturn bi vratio i sadržaj — ovako se vraćaju samo podaci o prilogu
  const out = [];
  for (const data of rows) out.push(await tx.attachment.create({ data, select: attachmentMeta }));
  return out;
}

export const addAttachment = (tx: Tx, actor: Actor, a: NewAttachment) => addAttachments(tx, actor, a.entity, a.entityId, [a]).then((r) => r[0]);

/** Prilog servisnog naloga vidljiv (ili ne) klijentu na portalu. */
export async function setAttachmentPublic(tx: Tx, actor: Actor, id: string, visible: boolean) {
  const a = await tx.attachment.findFirst({ where: { id, companyId: actor.companyId }, select: attachmentMeta });
  assert(a, 'Prilog ne postoji.');
  assert(a.entity === 'serviceOrder', 'Klijentu se mogu pokazati samo prilozi servisnog naloga.');
  if (a.public === visible) return a;
  await tx.attachment.update({ where: { id }, data: { public: visible } });
  await audit(tx, actor, { entity: 'attachment', entityId: id, action: visible ? 'public' : 'private', summary: `Prilog ${a.fileName} ${visible ? 'vidljiv' : 'skriven'} klijentu na portalu` });
  return { ...a, public: visible };
}

/** Brisanje priloga; vraća obrisani zapis (za dnevnik) — provjera prava je na pozivatelju (`canAttachment`). */
export async function deleteAttachment(tx: Tx, actor: Actor, id: string) {
  const a = await tx.attachment.findFirst({ where: { id, companyId: actor.companyId }, select: attachmentMeta });
  assert(a, 'Prilog ne postoji.');
  assert(!isProtectedAttachment(a), 'Izvorni XML eRačuna se ne može obrisati.');
  await tx.attachment.delete({ where: { id: a.id } });
  return a;
}

/** Popis priloga (bez sadržaja) za jedan ili više zapisa. */
export function listAttachments(tx: Pick<Tx, 'attachment'>, companyId: string, entity: AttachmentEntity, entityIds: string[]) {
  if (!entityIds.length) return Promise.resolve([]);
  return tx.attachment.findMany({
    where: { companyId, entity, entityId: entityIds.length === 1 ? entityIds[0] : { in: entityIds } },
    orderBy: { createdAt: 'asc' },
    select: attachmentMeta,
  });
}

/**
 * Broj priloga po zapisu — za oznaku (spajalica, „PDF") u popisima.
 * Jedan groupBy za cijelu stranicu popisa.
 */
export async function attachmentCounts(tx: Pick<Tx, 'attachment'>, companyId: string, entity: AttachmentEntity, entityIds: string[]): Promise<Map<string, number>> {
  if (!entityIds.length) return new Map();
  const rows = await tx.attachment.groupBy({ by: ['entityId'], where: { companyId, entity, entityId: { in: entityIds } }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.entityId, r._count._all]));
}

/** Prilog sa sadržajem — samo unutar firme. */
export function readAttachment(tx: Pick<Tx, 'attachment'>, companyId: string, id: string) {
  return tx.attachment.findFirst({ where: { id, companyId }, select: { ...attachmentMeta, data: true } });
}

/**
 * Kopija priloga na drugi zapis (npr. slika naljepnice iz zahtjeva → uređaj).
 * Sadržaj se kopira u bazi, bez prijenosa kroz aplikaciju.
 */
export async function copyAttachment(tx: Tx, actor: Actor, id: string, entity: AttachmentEntity, entityId: string, fileName: string) {
  const src = await tx.attachment.findFirst({ where: { id, companyId: actor.companyId }, select: { id: true, mime: true } });
  if (!src) return 0;
  const have = await tx.attachment.count({ where: { companyId: actor.companyId, entity, entityId } });
  if (have >= ATTACHMENT_ENTITIES[entity].max) return 0;
  const name = safeFileName(fileName, src.mime as Parameters<typeof safeFileName>[1]);
  return tx.$executeRaw`
    INSERT INTO "Attachment" ("id", "companyId", "entity", "entityId", "fileName", "mime", "size", "data", "createdBy", "createdAt")
    SELECT ${cuidLike()}, "companyId", ${entity}, ${entityId}, ${name}, "mime", "size", "data", ${actor.name}, now()
    FROM "Attachment" WHERE "id" = ${src.id} AND "companyId" = ${actor.companyId}`;
}

/** Id za zapis stvoren izravnim SQL-om (Prisma cuid() radi samo kroz klijent). */
function cuidLike() {
  return `c${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Smije li korisnik s pravima `perms` pregledati/dodati/brisati priloge vrste `entity`. */
/**
 * Dokumenti s nabavnim cijenama (narudžbenica, primka, ulazni račun za robu) — njihovi
 * prilozi (ponuda/račun dobavljača) otkrivaju nabavnu vrijednost, pa ih bez prava
 * „nabavne cijene i marže" nitko ne vidi ni ne preuzima.
 */
export async function attachmentsHideCost(tx: Pick<Tx, 'supplierInvoice'>, companyId: string, perms: PermissionMap, entity: AttachmentEntity, entityId: string) {
  if (canSeeCost(perms)) return false;
  if (entity === 'purchaseOrder' || entity === 'receipt') return true;
  if (entity !== 'supplierInvoice') return false;
  const si = await tx.supplierInvoice.findFirst({ where: { id: entityId, companyId }, select: { goodsInvoice: true } });
  return !!si?.goodsInvoice;
}

export function canAttachment(perms: PermissionMap, entity: AttachmentEntity, what: 'view' | 'add' | 'remove') {
  const rule = ATTACHMENT_ENTITIES[entity];
  return can(perms, rule.module, rule[what]);
}

// ---------------------------------------------------------------- slike uz server akciju (FormData)

const toArr = (v: unknown) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Slike poslane uz akciju: datoteka i zapis na koji se odnosi (uređaj, serijski…). */
export const zPhotos = z
  .array(z.object({ file: z.custom<Blob>((v) => v instanceof Blob, 'Neispravna datoteka'), target: z.string().nullable() }))
  .max(200, 'Previše slika odjednom')
  .default([]);

/**
 * Akcija koja prima slike: klijent šalje FormData s poljem `json` (obični podaci)
 * i parovima `photo` + `photoFor` (vidi `photoForm` na klijentu). Obični objekt
 * bez slika također prolazi.
 */
export function withPhotos<S extends z.ZodTypeAny>(schema: S) {
  return z.preprocess((raw) => {
    if (!raw || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).json !== 'string') return raw;
    const o = raw as Record<string, unknown>;
    let data: unknown;
    try {
      data = JSON.parse(o.json as string);
    } catch {
      return raw;
    }
    const files = toArr(o.photo);
    const fors = toArr(o.photoFor);
    return { ...(data as object), photos: files.map((file, i) => ({ file, target: typeof fors[i] === 'string' && fors[i] ? fors[i] : null })) };
  }, schema);
}

/** Sadržaj poslanih slika (provjera veličine prije čitanja). */
export async function photoBytes(photos: Array<{ file: Blob; target: string | null }>) {
  return Promise.all(
    photos.map(async (p) => {
      assert(p.file.size <= ATTACHMENT_MAX_BYTES, `Slika je veća od ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB.`);
      return { target: p.target, fileName: (p.file as File).name || null, data: new Uint8Array(await p.file.arrayBuffer()) };
    }),
  );
}
