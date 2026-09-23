import Link from 'next/link';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { env } from '@/server/env';
import { getCompany, modelLabel } from '@/server/queries/lookups';
import { PageHeader, Empty, Notice } from '@/components/ui/misc';
import { PrintButton } from '@/components/ui/print-button';
import { buttonClass } from '@/components/ui/button';
import { controlClass } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { integer } from '@/lib/format';
import { PrintUnclip } from '@/components/warehouse/print-unclip';
import { code128Svg, qrSvg } from './barcodes';

type Params = Record<string, string | string[] | undefined>;

const MAX_LABELS = 1000;

/** Formati: A4 arak 3 × 8 (70 × 37 mm) ili jedna naljepnica po stranici za pisač naljepnica. */
const FORMATS = {
  a4: { label: 'A4 arak 3 × 8 (70 × 37 mm)', w: 70, h: 37, sheet: true },
  '50x25': { label: 'Pisač naljepnica 50 × 25 mm', w: 50, h: 25, sheet: false },
  '62x29': { label: 'Pisač naljepnica 62 × 29 mm', w: 62, h: 29, sheet: false },
  '100x50': { label: 'Pisač naljepnica 100 × 50 mm', w: 100, h: 50, sheet: false },
} as const;
type FormatKey = keyof typeof FORMATS;

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');

export default async function LabelsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const user = await pageAccess('warehouse', 'view');
  const sp = await searchParams;
  const format: FormatKey = (str(sp.format) in FORMATS ? str(sp.format) : 'a4') as FormatKey;
  const f = FORMATS[format];
  // QR (poveznica na karticu uređaja) zadano na većim naljepnicama; na 50 × 25 mm bi suzio barkod
  const qr = sp.qr === '1' || (sp.qr === undefined && f.w >= 62);
  const copies = Math.min(5, Math.max(1, Number(str(sp.kopije)) || 1));
  const ids = str(sp.ids).split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_LABELS);
  const receiptId = str(sp.receipt) || null;

  const select = { id: true, serial: true, dupNote: true, model: { select: { brand: true, name: true, code: true } } } as const;
  const [items, receipt, company] = await Promise.all([
    ids.length
      ? db.item.findMany({ where: { companyId: user.companyId, id: { in: ids } }, select })
      : receiptId
        ? db.item.findMany({ where: { companyId: user.companyId, receiptId }, select, orderBy: { serial: 'asc' }, take: MAX_LABELS })
        : Promise.resolve([]),
    receiptId ? db.goodsReceipt.findFirst({ where: { id: receiptId, companyId: user.companyId }, select: { number: true } }) : null,
    getCompany(user.companyId),
  ]);
  // redoslijed kao u odabiru
  if (ids.length) items.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  // adresa iz postavki poslužitelja, nikad iz zaglavlja zahtjeva (Host/X-Forwarded-Host može podmetnuti klijent ili posrednik);
  // bez APP_URL QR nosi samo putanju — skener u aplikaciji karticu prepoznaje po putanji (itemIdFromLink)
  const origin = env().APP_URL?.replace(/\/+$/, '') ?? '';

  const labels = items.flatMap((it) => {
    const one = {
      key: it.id,
      serial: it.serial,
      dupNote: it.dupNote,
      model: modelLabel(it.model),
      code: it.model.code,
      bar: code128Svg(it.serial),
      qr: qr ? qrSvg(`${origin}/skladiste/${it.id}`) : null,
    };
    return Array.from({ length: copies }, (_, i) => ({ ...one, key: `${it.id}-${i}` }));
  });
  const pages: (typeof labels)[] = [];
  if (f.sheet) for (let i = 0; i < labels.length; i += 24) pages.push(labels.slice(i, i + 24));

  const hidden = { ids: ids.join(','), receipt: receiptId ?? '' };
  const printCss = f.sheet
    ? `@media print { @page { size: A4; margin: 0; } .label-sheet { box-shadow: none !important; margin: 0 !important; break-after: page; } .label-sheet:last-child { break-after: auto; } }`
    : `@media print { @page { size: ${f.w}mm ${f.h}mm; margin: 0; } .label-roll { display: block !important; gap: 0 !important; padding: 0 !important; background: none !important; } .label-one { outline: none !important; break-after: page; } .label-one:last-child { break-after: auto; } }`;

  return (
    <>
      <style>{printCss}</style>
      <PrintUnclip />
      <div className="no-print">
        <PageHeader
          back={
            <Link prefetch={false} href="/skladiste" className="hover:text-fg">
              ← Skladište
            </Link>
          }
          title="Naljepnice"
          subtitle={`${integer(labels.length)} naljepnica${receipt ? ` · primka ${receipt.number}` : ''} · ${f.label}`}
          actions={labels.length ? <PrintButton label="Ispiši" /> : null}
        />
        <form method="get" className="mb-4 flex flex-wrap items-end gap-2">
          {hidden.ids && <input type="hidden" name="ids" value={hidden.ids} />}
          {hidden.receipt && <input type="hidden" name="receipt" value={hidden.receipt} />}
          <label className="min-w-0 max-sm:w-full">
            <span className="mb-1 block text-sm text-fg-2">Format</span>
            <select name="format" defaultValue={format} className={cn(controlClass, 'h-8')}>
              {Object.entries(FORMATS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-sm text-fg-2">QR kod</span>
            <select name="qr" defaultValue={qr ? '1' : '0'} className={cn(controlClass, 'h-8')}>
              <option value="1">Da (poveznica na karticu)</option>
              <option value="0">Ne</option>
            </select>
          </label>
          <label>
            <span className="mb-1 block text-sm text-fg-2">Kopija</span>
            <input type="number" name="kopije" min={1} max={5} defaultValue={copies} className={cn(controlClass, 'h-8 w-20')} />
          </label>
          <button type="submit" className={buttonClass('secondary')}>
            Primijeni
          </button>
        </form>
        {items.length === MAX_LABELS && <Notice tone="warn">Prikazano je prvih {MAX_LABELS} uređaja.</Notice>}
        {!f.sheet && labels.length > 0 && (
          <p className="mb-3 text-sm text-fg-3">
            U dijalogu ispisa odaberite pisač naljepnica, veličinu papira {f.w} × {f.h} mm, bez margina i mjerilo 100 %.
          </p>
        )}
      </div>

      {!labels.length ? (
        <div className="rounded-lg bg-panel shadow-[var(--shadow-panel)]">
          <Empty title="Nema odabranih uređaja" description="Označite uređaje u popisu skladišta ili skeniranju i odaberite „Naljepnice“." />
        </div>
      ) : f.sheet ? (
        <div className="print-area overflow-x-auto scroll-slim print:overflow-visible">
          {pages.map((pg, i) => (
            <div
              key={i}
              className="label-sheet mx-auto mb-6 grid bg-white text-black shadow-[var(--shadow-panel)]"
              style={{ width: '210mm', height: '297mm', gridTemplateColumns: 'repeat(3, 70mm)', gridAutoRows: '37mm', alignContent: 'start', paddingTop: '0.5mm' }}
            >
              {pg.map((l) => (
                <LabelBox key={l.key} l={l} w={f.w} h={f.h} company={company.name} className="outline-dashed outline-1 outline-black/10 print:outline-none" />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="print-area label-roll flex flex-wrap gap-3 overflow-x-auto">
          {labels.map((l) => (
            <LabelBox key={l.key} l={l} w={f.w} h={f.h} company={company.name} className="label-one bg-white text-black outline outline-1 outline-black/20" />
          ))}
        </div>
      )}
    </>
  );
}

interface LabelData {
  serial: string;
  dupNote: string | null;
  model: string;
  code: string | null;
  bar: string | null;
  qr: string | null;
}

/** Jedna naljepnica: model, Code 128 serijskog, serijski tekstom i po želji QR. Mjere u mm radi točnog ispisa. */
function LabelBox({ l, w, h, company, className }: { l: LabelData; w: number; h: number; company: string; className?: string }) {
  const pad = w <= 50 ? 1.5 : 2.5;
  const qrSize = l.qr ? Math.min(h - 2 * pad, w * 0.34) : 0;
  const small = w <= 50;
  return (
    <div className={cn('flex overflow-hidden', className)} style={{ width: `${w}mm`, height: `${h}mm`, padding: `${pad}mm`, gap: `${pad}mm`, breakInside: 'avoid' }}>
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <div className="truncate font-semibold leading-tight" style={{ fontSize: small ? '6.5pt' : '8pt' }}>
          {l.model}
          {l.code ? <span className="font-normal"> · {l.code}</span> : null}
        </div>
        {l.bar ? (
          <div className="min-h-0 flex-1 [&>svg]:size-full" style={{ margin: '0.8mm 0' }} dangerouslySetInnerHTML={{ __html: l.bar }} />
        ) : (
          <div className="flex-1" />
        )}
        <div className="truncate text-center font-mono font-semibold leading-none" style={{ fontSize: small ? '7.5pt' : '9pt' }}>
          {l.serial}
          {l.dupNote ? <span className="font-normal"> ({l.dupNote})</span> : null}
        </div>
        {!small && <div className="truncate text-center leading-tight text-black/60" style={{ fontSize: '5.5pt', marginTop: '0.5mm' }}>{company}</div>}
      </div>
      {l.qr && <div className="shrink-0 self-center [&>svg]:size-full" style={{ width: `${qrSize}mm`, height: `${qrSize}mm` }} dangerouslySetInnerHTML={{ __html: l.qr }} />}
    </div>
  );
}
