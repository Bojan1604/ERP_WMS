import { z } from 'zod';
import { parseNumber } from '@/domain/money';

/** Pomoćne sheme koje razumiju vrijednosti iz obrazaca (prazan niz = nema vrijednosti). */
const empty = (v: unknown) => v === '' || v === null || v === undefined;

export const zId = z.string().min(1);
export const zOptId = z.preprocess((v) => (empty(v) ? null : v), z.string().nullable());
export const zText = z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string());
export const zReq = (label = 'Polje') => z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(1, `${label} je obavezno`));
export const zOptText = z.preprocess((v) => (empty(v) ? null : typeof v === 'string' ? v.trim() || null : v), z.string().nullable());
export const zMoney = z.preprocess((v) => (empty(v) ? 0 : typeof v === 'string' ? parseNumber(v) : v), z.number());
export const zOptMoney = z.preprocess((v) => (empty(v) ? null : typeof v === 'string' ? parseNumber(v) : v), z.number().nullable());
export const zInt = z.preprocess((v) => (empty(v) ? 0 : Number(v)), z.number().int());
export const zOptInt = z.preprocess((v) => (empty(v) ? null : Number(v)), z.number().int().nullable());
export const zDate = z.preprocess((v) => (typeof v === 'string' ? v.slice(0, 10) : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Neispravan datum'));
export const zOptDate = z.preprocess((v) => (empty(v) ? null : typeof v === 'string' ? v.slice(0, 10) : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable());
export const zBool = z.preprocess((v) => v === true || v === 'on' || v === 'true' || v === '1', z.boolean());
export const zIds = z.preprocess((v) => (empty(v) ? [] : Array.isArray(v) ? v : [v]), z.array(z.string().min(1)));
