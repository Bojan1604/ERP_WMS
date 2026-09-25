/**
 * Provjere za zod `.refine` / `.preprocess` u datotekama akcija. Datoteke s `'use server'`
 * ne smiju sadržavati obične (ne-async) funkcije u izrazima, pa su ovdje kao imenovane.
 */
import { kpdValid } from '@/domain/sales-lines';

/** min ≤ v ≤ max */
export const inRange = (min: number, max: number) => (v: number) => v >= min && v <= max;
/** prazno ili min ≤ v ≤ max */
export const optInRange = (min: number, max: number) => (v: number | null | undefined) => v == null || (v >= min && v <= max);
/** prazno ili min ≤ v < max */
export const optBelow = (min: number, max: number) => (v: number | null | undefined) => v == null || (v >= min && v < max);
/** prazno ili v ≥ 0 */
export const optNonNegative = (v: number | null | undefined) => v == null || v >= 0;
export const nonNegative = (v: number) => v >= 0;
/** prazno ili ispravna KPD šifra (NN.NN.NN) */
export const optKpd = (v: string | null | undefined) => !v || kpdValid(v);
/** nova lozinka i ponovljena se podudaraju */
export const passwordsMatch = (v: { next: string; next2: string }) => v.next === v.next2;
/** '' / null → null, inače broj */
export const emptyToNumber = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));
/** model poziva na broj HR00–HR99 */
export const paymentModelOk = (v: string) => /^HR\d{2}$/i.test(v);
/** prazno ili OIB od 11 znamenki */
export const optOib = (v: string | null | undefined) => !v || /^\d{11}$/.test(v);
