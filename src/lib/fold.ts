/**
 * Usporedba bez dijakritika i velikih slova („slasticarnica" nalazi „Slastičarnica", „Mandrac" → „Mandrać").
 * Ista tablica zamjene vrijedi u pregledniku (`fold`) i u bazi (`translate(…)` u queries/partner-options.ts
 * i funkcijski trigram indeks u migraciji 0016_unaccent) — bez proširenja baze, radi na svakom PostgreSQL-u.
 * Promjena ovih nizova traži novu migraciju indeksa (izraz u upitu i u indeksu mora biti isti).
 */
export const FOLD_FROM = 'čćžšđČĆŽŠĐáàâäãåéèêëíìîïóòôöõúùûüýÿñçÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÝÑÇ';
export const FOLD_TO = 'cczsdCCZSDaaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC';

const MAP = new Map([...FOLD_FROM].map((c, i) => [c, FOLD_TO[i]]));

/** Mala slova, bez dijakritika (prema tablici iznad). */
export function fold(s: string): string {
  let out = '';
  for (const c of s) out += MAP.get(c) ?? c;
  return out.toLowerCase();
}
