import { defaultKpd } from '@/domain/sales-lines';
import { r2 } from '@/domain/money';
import type { CompanyDefaults, DeviceOpt, EditorLine, ModelOpt } from './types';

/**
 * Pomoćne funkcije editora stavki (račun i ponuda): uređaj → stavka, zadana
 * KPD šifra, promjena vrste stavke (prodaja ↔ najam) i preračun iznosa najma
 * (mjesečno × broj mjeseci naplate).
 */

export type LineType = 'SALE' | 'RENT';

let seq = 0;
/** Ključ retka u editoru (stabilan za React, ne ide u bazu). */
export const lineKey = () => `l${Date.now().toString(36)}${(seq++).toString(36)}`;

export const isRentLine = (l: Pick<EditorLine, 'lineType'>, docType: string) => (l.lineType ?? (docType === 'RENT' ? 'RENT' : 'SALE')) === 'RENT';

/** Zadana KPD šifra za stavku (model / usluga / postavke firme). */
export function autoKpd(
  l: Pick<EditorLine, 'kind' | 'modelId' | 'serviceId'>,
  lineType: 'SALE' | 'RENT' | 'SERVICE',
  company: CompanyDefaults,
  models: ModelOpt[],
  serviceKpd?: string | null,
): string {
  const m = l.modelId ? models.find((x) => x.id === l.modelId) : undefined;
  return defaultKpd({ lineType, kind: l.kind, serviceKpd, modelKpd: m?.kpd, modelKpdRent: m?.kpdRent, company }) ?? '';
}

/** Uređaj iz birača → stavka (prodaja ili najam s mjesečnom cijenom × `months`). */
export function deviceToLine(d: DeviceOpt, opts: { lineType: LineType; months: number; company: CompanyDefaults; models: ModelOpt[]; docType?: string }): EditorLine {
  const rent = opts.lineType === 'RENT';
  const monthly = d.rent ?? 0;
  return {
    key: lineKey(),
    kind: 'DEVICE',
    itemId: d.id,
    modelId: d.modelId,
    description: rent ? `Najam ${d.model}` : d.model,
    unit: rent ? 'mj' : 'kom',
    kpd: autoKpd({ kind: 'DEVICE', modelId: d.modelId }, opts.lineType, opts.company, opts.models),
    qty: 1,
    unitPrice: rent ? r2(monthly * opts.months) : d.price,
    discountPct: 0,
    warrantyMonths: rent ? null : d.warrantyMonths,
    agreedPrice: rent ? d.rentSource === 'agreed' : d.priceSource === 'agreed',
    serial: d.serial,
    cost: d.cost,
    lineType: opts.docType && (opts.docType === 'RENT') === rent ? null : opts.lineType,
    ...(rent ? { monthly, months: opts.months } : {}),
    existing: d.rentSource === 'contract',
    suggestSale: d.price,
    suggestRent: d.rent ?? null,
  };
}

/**
 * Promjena vrste stavke: najam = mjesečna cijena (preporučena ili dosadašnja
 * cijena kao mjesečna) × mjeseci naplate; prodaja = prodajna cijena.
 * KPD se mijenja samo ako je bio zadani za staru vrstu.
 */
export function switchLineType(l: EditorLine, to: LineType, ctx: { docType: string; months: number; company: CompanyDefaults; models: ModelOpt[] }): EditorLine {
  const from: LineType = isRentLine(l, ctx.docType) ? 'RENT' : 'SALE';
  if (from === to) return l;
  const oldKpd = autoKpd(l, from, ctx.company, ctx.models);
  const kpd = !l.kpd || l.kpd === oldKpd ? autoKpd(l, to, ctx.company, ctx.models) : l.kpd;
  const lineType = (ctx.docType === 'RENT') === (to === 'RENT') ? null : to;
  if (to === 'RENT') {
    const monthly = l.suggestRent ?? l.unitPrice;
    const withPrefix = l.kind === 'DEVICE' || l.kind === 'MODEL' ? (/^najam\b/i.test(l.description) ? l.description : `Najam ${l.description}`) : l.description;
    return { ...l, lineType, kpd, monthly, months: ctx.months, unitPrice: r2(monthly * ctx.months), unit: l.unit === 'kom' ? 'mj' : l.unit, warrantyMonths: null, description: withPrefix, agreedPrice: false };
  }
  const price = l.suggestSale ?? (l.monthly ?? l.unitPrice);
  return {
    ...l,
    lineType,
    kpd,
    monthly: null,
    months: null,
    unitPrice: price,
    unit: l.unit === 'mj' ? 'kom' : l.unit,
    description: l.description.replace(/^Najam\s+/i, ''),
    agreedPrice: false,
  };
}

/** Učestalost naplate promijenjena: iznosi stavki najma = mjesečno × novi broj mjeseci. */
export function withRentMonths(lines: EditorLine[], docType: string, months: number): EditorLine[] {
  return lines.map((l) => {
    if (!isRentLine(l, docType)) return l;
    const monthly = l.monthly ?? l.unitPrice;
    return { ...l, monthly, months, unitPrice: r2(monthly * months) };
  });
}
