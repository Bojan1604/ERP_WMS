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
import { findItemsByCode, scanItemsByIds, type ScanItem, type ScanVia } from '@/server/queries/stocktake';

const toDevice = (i: ScanItem) => plain(i);
export type ScanDevice = ReturnType<typeof toDevice>;
export type LookupResult = { code: string; via: ScanVia | null; items: ScanDevice[] };

/** Pročitani kod → uređaj(i). Samo čitanje, bez osvježavanja prikaza. */
export const lookupScanAction = action(
  { module: 'warehouse', level: 'view' },
  z.object({ code: z.string().trim().min(1, 'Prazan kod').max(500) }),
  async ({ code }, user) => {
    const r = await findItemsByCode(db, user.companyId, code);
    const data: LookupResult = { code, via: r.via, items: r.items.map(toDevice) };
    return { data, revalidate: [] };
  },
);

/** Svježe stanje skeniranih uređaja (nakon radnje nad njima). */
export const refreshScanAction = action({ module: 'warehouse', level: 'view' }, z.object({ ids: zIds }), async ({ ids }, user) => {
  const rows = await scanItemsByIds(user.companyId, ids.slice(0, 2000));
  return { data: rows.map(toDevice), revalidate: [] };
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
