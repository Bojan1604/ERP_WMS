'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { db, transaction } from '@/server/db';
import { audit } from '@/server/audit';
import { plain } from '@/server/plain';
import { zId, zIds, zOptText } from '@/server/zod';
import { photoBytes, withPhotos, zPhotos } from '@/server/services/attachments';
import { createReceiveRequest } from '@/server/services/receive-requests';
import { MAX_RECEIVE } from '@/domain/warehouse';
import { looksLikeSerial, ocrTokens, ocrVariants } from '@/domain/warehouse-list';
import { lookupScanItems, scanItemView, scanItemsByIds, type ScanItemView, type ScanVia } from '@/server/queries/stocktake';
import { canSeeCost } from '@/domain/permissions';

// nabavna cijena samo uz pravo `costs` — odgovor akcije vidi svatko s pravom pregleda skladišta
const toDevice = (i: ScanItemView) => plain(i);
export type ScanDevice = ReturnType<typeof toDevice>;
export type LookupResult = { code: string; via: ScanVia | null; items: ScanDevice[] };

/** Pročitani kod → uređaj(i). Samo čitanje, bez osvježavanja prikaza. */
export const lookupScanAction = action(
  { module: 'warehouse', level: 'view' },
  z.object({ code: z.string().trim().min(1, 'Prazan kod').max(500) }),
  async ({ code }, user) => {
    const r = await lookupScanItems(db, user.companyId, code, canSeeCost(user.perms));
    const data: LookupResult = { code, via: r.via, items: r.items.map(toDevice) };
    return { data, revalidate: [] };
  },
);

/**
 * OCR naljepnice → kodovi za skeniranje: riječi koje (uz tipične zamjene slovo ↔
 * znamenka) odgovaraju serijskom broju u bazi, pa riječi koje izgledaju kao
 * serijski broj, a nema ih (nova roba — korisnik ih provjeri). Jedan indeksirani upit.
 */
export const ocrMatchAction = action({ module: 'warehouse', level: 'view' }, z.object({ text: z.string().max(20_000) }), async ({ text }, user) => {
  const tokens = ocrTokens(text);
  const variants = new Map<string, string>();
  for (const t of tokens) for (const v of ocrVariants(t)) if (!variants.has(v)) variants.set(v, t);
  const found = variants.size
    ? await db.item.findMany({ where: { companyId: user.companyId, serial: { in: [...variants.keys()] } }, select: { serial: true }, take: 200 })
    : [];
  const matched = [...new Set(found.map((f) => f.serial))];
  const usedTokens = new Set(found.map((f) => variants.get(f.serial)));
  const unknown = tokens.filter((t) => !usedTokens.has(t) && looksLikeSerial(t));
  return { data: { matched, unknown: unknown.slice(0, 20), tokens: tokens.length }, revalidate: [] };
});

/** Svježe stanje skeniranih uređaja (nakon radnje nad njima). */
export const refreshScanAction = action({ module: 'warehouse', level: 'view' }, z.object({ ids: zIds }), async ({ ids }, user) => {
  const rows = await scanItemsByIds(user.companyId, ids.slice(0, 2000));
  return { data: rows.map((i) => toDevice(scanItemView(i, canSeeCost(user.perms)))), revalidate: [] };
});

/**
 * „Pošalji na zaprimanje" (razina operativno): nepoznati serijski brojevi i
 * poznati uređaji izvan skladišta idu administratoru; uređaji ne nastaju dok
 * on ne zaprimi robu. Uz zahtjev neobavezne slike naljepnica.
 */
export const sendReceiveRequestAction = action(
  { module: 'warehouse', level: 'ops' },
  withPhotos(
    z.object({
      serials: z.array(z.string().trim().min(1).max(120)).max(MAX_RECEIVE),
      returning: zIds,
      warehouseId: zId,
      note: zOptText,
      photos: zPhotos,
    }),
  ),
  async ({ photos, ...input }, user) => {
    const files = await photoBytes(photos);
    return transaction(async (tx) => {
      const returning = new Set(input.returning);
      const r = await createReceiveRequest(tx, user, {
        ...input,
        // cilj slike: id poznatog uređaja ili skenirani kod nepoznatog
        photos: files.map((f) => ({
          itemId: f.target && returning.has(f.target) ? f.target : null,
          code: f.target && !returning.has(f.target) ? f.target : null,
          fileName: f.target ? `naljepnica ${f.target.replace(/[\\/]/g, '-')}` : null,
          data: f.data,
        })),
      });
      await audit(tx, user, {
        entity: 'approvalRequest',
        entityId: r.id,
        action: 'create',
        summary: `Zahtjev za zaprimanje — novih ${r.serials}, povrat ${r.returning}${r.photos ? `, slika ${r.photos}` : ''}`,
      });
      return { message: 'Poslano na zaprimanje — administrator će provjeriti i zaprimiti robu.', data: { id: r.id } };
    });
  },
);
