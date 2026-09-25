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

// ---------------------------------------------------------------- odobravanje po retku

/** Odluka administratora za jedan skenirani (novi) kod: ispravljen serijski, model, preskoči. */
export interface ReceiveRowDecision {
  code: string;
  serial: string;
  modelId: string | null;
  skip: boolean;
}

/**
 * Provjera odluka po retku i grupiranje za primku (po modelu). Svaki kod iz
 * zahtjeva mora imati odluku; zaprimljeni redovi traže model i serijski broj,
 * a ispravljeni serijski brojevi ne smiju se ponoviti.
 */
export function planReceiveRows(requestSerials: string[], rows: ReceiveRowDecision[]): { byModel: Map<string, string[]>; received: number; skipped: number; serialFix: Record<string, string> } {
  const codes = new Set(requestSerials);
  const seenCodes = new Set<string>();
  for (const r of rows) {
    if (!codes.has(r.code)) throw new Error(`Kod „${r.code}" nije u zahtjevu.`);
    if (seenCodes.has(r.code)) throw new Error(`Kod „${r.code}" je naveden dvaput.`);
    seenCodes.add(r.code);
  }
  const missing = requestSerials.filter((c) => !seenCodes.has(c));
  if (missing.length) throw new Error(`Nedostaje odluka za kodove: ${missing.slice(0, 10).join(', ')}.`);
  const byModel = new Map<string, string[]>();
  const serials = new Set<string>();
  const serialFix: Record<string, string> = {};
  let skipped = 0;
  for (const r of rows) {
    if (r.skip) {
      skipped++;
      continue;
    }
    const serial = r.serial.replace(/\s+/g, '').trim();
    if (!serial) throw new Error(`Redak „${r.code}": upišite serijski broj ili ga preskočite.`);
    if (serial.length > 120) throw new Error(`Redak „${r.code}": serijski broj je predug.`);
    if (!r.modelId) throw new Error(`Redak „${serial}": odaberite model ili ga preskočite.`);
    if (serials.has(serial)) throw new Error(`Serijski broj ${serial} je upisan više puta.`);
    serials.add(serial);
    if (serial !== r.code) serialFix[r.code] = serial;
    byModel.set(r.modelId, [...(byModel.get(r.modelId) ?? []), serial]);
  }
  return { byModel, received: serials.size, skipped, serialFix };
}
