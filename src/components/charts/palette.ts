/**
 * Kategorijska paleta grafova — fiksni redoslijed boja (nikad ciklički), zasebno
 * odabrani koraci za svijetlu i tamnu temu. Klase su pune (ne sastavljaju se),
 * da ih Tailwind pronađe.
 */
export const SLOT_FILL = [
  'fill-[#2a78d6] dark:fill-[#3987e5]',
  'fill-[#eb6834] dark:fill-[#d95926]',
  'fill-[#1baf7a] dark:fill-[#199e70]',
  'fill-[#eda100] dark:fill-[#c98500]',
  'fill-[#e87ba4] dark:fill-[#d55181]',
  'fill-[#008300] dark:fill-[#008300]',
  'fill-[#4a3aa7] dark:fill-[#9085e9]',
  'fill-[#e34948] dark:fill-[#e66767]',
] as const;

export const SLOT_STROKE = [
  'stroke-[#2a78d6] dark:stroke-[#3987e5]',
  'stroke-[#eb6834] dark:stroke-[#d95926]',
  'stroke-[#1baf7a] dark:stroke-[#199e70]',
  'stroke-[#eda100] dark:stroke-[#c98500]',
  'stroke-[#e87ba4] dark:stroke-[#d55181]',
  'stroke-[#008300] dark:stroke-[#008300]',
  'stroke-[#4a3aa7] dark:stroke-[#9085e9]',
  'stroke-[#e34948] dark:stroke-[#e66767]',
] as const;

export const SLOT_BG = [
  'bg-[#2a78d6] dark:bg-[#3987e5]',
  'bg-[#eb6834] dark:bg-[#d95926]',
  'bg-[#1baf7a] dark:bg-[#199e70]',
  'bg-[#eda100] dark:bg-[#c98500]',
  'bg-[#e87ba4] dark:bg-[#d55181]',
  'bg-[#008300] dark:bg-[#008300]',
  'bg-[#4a3aa7] dark:bg-[#9085e9]',
  'bg-[#e34948] dark:bg-[#e66767]',
] as const;

const compactFmt = new Intl.NumberFormat('hr-HR', { notation: 'compact', maximumFractionDigits: 1 });
export const compact = (v: number) => (v === 0 ? '0' : compactFmt.format(v));

/** „Lijepe" oznake osi: 0, 2.000, 4.000… */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) max = min + 1;
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
