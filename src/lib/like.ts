/**
 * Prisma `contains`/`startsWith`/`endsWith` (i `equals` s `mode: 'insensitive'`) postaju
 * LIKE/ILIKE bez escapeanja — `%` i `_` iz pretrage bi bili zamjenski znakovi.
 * Escapeaju se da pretraga bude doslovna (PostgreSQL: zadani escape znak je `\`).
 */
export const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');
