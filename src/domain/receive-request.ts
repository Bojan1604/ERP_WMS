/**
 * Zahtjev za zaprimanje robe (skladištar s operativnom razinom → administrator).
 * Čisti dio: oblik podataka zahtjeva i koji se poznati uređaji mogu vratiti na stanje.
 */
import type { StateKind } from './warehouse';

/** Poznati uređaji koji se zahtjevom vraćaju na skladište (sve osim onih koji su već tamo ili su otpisani). */
export const BACK_TO_STOCK_STATES: StateKind[] = ['RESERVED', 'SOLD', 'RENTED', 'SERVICE', 'RETURNING', 'OTHER'];

export interface RequestPhoto {
  /** Id priloga (Attachment, entity 'request'). */
  id: string;
  /** Skenirani kod / serijski broj na koji se slika odnosi (null = općenita slika). */
  code: string | null;
  /** Poznati uređaj na koji se slika odnosi. */
  itemId: string | null;
}

export interface ReceiveRequestPayload {
  /** Nepoznati serijski brojevi — novi uređaji. */
  serials: string[];
  /** Id-evi poznatih uređaja izvan skladišta koji se vraćaju na stanje. */
  returning: string[];
  warehouseId: string;
  note: string | null;
  photos: RequestPhoto[];
  requesterId: string | null;
  /** Podnositelj je vidio odbijanje („U redu"). */
  ack?: boolean;
}

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Tolerantno čitanje JSON-a iz baze (stari ili ručno mijenjani zapisi ne smiju srušiti stranicu). */
export function readReceivePayload(p: unknown): ReceiveRequestPayload {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const photos = Array.isArray(o.photos)
    ? o.photos
        .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : null))
        .filter((x): x is Record<string, unknown> => !!x && typeof x.id === 'string')
        .map((x) => ({ id: x.id as string, code: typeof x.code === 'string' ? x.code : null, itemId: typeof x.itemId === 'string' ? x.itemId : null }))
    : [];
  return {
    serials: strs(o.serials),
    returning: strs(o.returning),
    warehouseId: typeof o.warehouseId === 'string' ? o.warehouseId : '',
    note: typeof o.note === 'string' ? o.note : null,
    photos,
    requesterId: typeof o.requesterId === 'string' ? o.requesterId : null,
    ack: o.ack === true,
  };
}
