/**
 * Prilozi (slike naljepnica, PDF) — čista pravila bez baze i preglednika:
 * dopuštene vrste prepoznate po sadržaju, ograničenja veličine i broja,
 * smanjivanje slike i uparivanje pročitanog koda sa serijskim brojem.
 */

/** Najveća veličina jednog priloga (nakon smanjivanja na klijentu). */
export const ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
/** Najviše priloga po zapisu (uređaj). */
export const ATTACHMENT_MAX_PER_ENTITY = 10;
/** Zahtjev za zaprimanje nosi sliku naljepnice po serijskom broju, pa smije imati više. */
export const ATTACHMENT_MAX_PER_REQUEST = 30;
/** Duža stranica slike nakon smanjivanja (px). */
export const IMAGE_MAX_SIDE = 1600;
/** Vrijednost `accept` za odabir datoteke. */
export const ATTACHMENT_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

export type AttachmentMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
/** Jedine vrste koje se spremaju (i prikazuju u pregledniku). */
export const ATTACHMENT_MIMES: readonly AttachmentMime[] = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const EXT: Record<AttachmentMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/**
 * Vrsta datoteke po prvim bajtovima — ne vjerujemo nazivu ni zaglavlju koje
 * šalje preglednik (inače bi se kao „slika" mogao poslati HTML).
 */
export function sniffMime(b: Uint8Array): AttachmentMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

/**
 * Prilog iz uvezene datoteke (sigurnosna kopija): isti uvjeti kao pri slanju —
 * vrsta po sadržaju (ne po zapisu `mime` iz datoteke), neprazan i ne veći od
 * ograničenja. Vraća prepoznatu vrstu ili razlog odbijanja.
 */
export function checkAttachmentBytes(b: Uint8Array): { mime: AttachmentMime } | { error: string } {
  if (!b.byteLength) return { error: 'prazna datoteka' };
  if (b.byteLength > ATTACHMENT_MAX_BYTES) return { error: `veći od ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB` };
  const mime = sniffMime(b);
  return mime ? { mime } : { error: 'nije slika (JPEG, PNG, WebP) ni PDF' };
}

export const isImageMime = (mime: string) => mime.startsWith('image/');

/** Siguran naziv datoteke: bez putanje i kontrolnih znakova, s nastavkom koji odgovara vrsti. */
export function safeFileName(name: string | null | undefined, mime: AttachmentMime): string {
  const base = (name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"<>|?*:]/g, '')
    .replace(/\.[a-z0-9]{1,5}$/i, '')
    .trim()
    .slice(0, 100);
  return `${base || 'prilog'}.${EXT[mime]}`;
}

/** Dimenzije unutar kvadrata `max` uz očuvan omjer (nikad ne povećava). */
export function fitWithin(width: number, height: number, max = IMAGE_MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const normCode = (s: string) => s.trim().toUpperCase();

/**
 * Uparivanje pročitanih kodova sa slike s uređajima: točan serijski broj (bez
 * obzira na velika/mala slova) ima prednost, zatim serijski kao dio koda
 * (GS1, „S/N: …"). Vraća id uređaja ili null.
 */
export function pairCode(codes: string[], devices: Array<{ id: string; serial: string }>): string | null {
  const cs = codes.map(normCode).filter(Boolean);
  for (const c of cs) {
    const hit = devices.find((d) => normCode(d.serial) === c);
    if (hit) return hit.id;
  }
  // najdulji serijski koji je dio koda — kraći bi mogli biti slučajni podnizovi
  const sorted = [...devices].filter((d) => d.serial.trim().length >= 4).sort((a, b) => b.serial.length - a.serial.length);
  for (const c of cs) {
    const hit = sorted.find((d) => c.includes(normCode(d.serial)));
    if (hit) return hit.id;
  }
  return null;
}
