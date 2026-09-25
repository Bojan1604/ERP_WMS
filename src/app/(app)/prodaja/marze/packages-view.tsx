import { TrendingUp } from 'lucide-react';
import { packages } from '@/server/queries/packages';
import type { MarginFilters } from '@/server/queries/margins';
import { Badge, Card, Empty, TableWrap } from '@/components/ui/misc';
import { PackageConvert, PackageDelete, PackageEditor } from '@/components/sales/package-controls';
import { eur, integer, pct } from '@/lib/format';
import { cn } from '@/lib/cn';

/** Marže → Paketi: kartice paketa s nabavnom, cijenom, profitom i maržom; uređivanje i izrada dokumenta za kupca. */
export async function PackagesView({
  companyId,
  f,
  edit,
  catalog,
  partners,
}: {
  companyId: string;
  f: MarginFilters;
  edit: boolean;
  catalog: React.ComponentProps<typeof PackageEditor>['catalog'];
  partners: Array<{ id: string; name: string }>;
}) {
  const rows = await packages(companyId, f);
  if (!rows.length) {
    return (
      <TableWrap>
        <Empty icon={<TrendingUp className="size-5" />} title="Nema paketa" description={'Paket grupira više uređaja i pokazuje ukupnu maržu — iz njega se izrađuje ponuda, predračun ili račun (gumb „+ Paket").'} />
      </TableWrap>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((p) => (
        <Card
          key={p.id}
          title={p.name}
          actions={
            <span className="flex items-center gap-1">
              <Badge>{integer(p.devices)} uređaja</Badge>
              {edit && (
                <>
                  <PackageEditor catalog={catalog} initial={{ id: p.id, name: p.name, price: p.ownPrice, note: p.note, items: p.items.filter((i) => i.available) }} />
                  <PackageDelete id={p.id} name={p.name} />
                </>
              )}
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-fg-3">Nabavna</p>
              <p className="tnum font-medium">{eur(p.cost)}</p>
            </div>
            <div>
              <p className="text-fg-3">Cijena paketa</p>
              <p className="tnum font-medium">
                {eur(p.price)}
                {p.ownPrice !== null && p.ownPrice !== p.suggested && <span className="ml-1 text-xs font-normal text-fg-3">(prijedlog {eur(p.suggested)})</span>}
              </p>
            </div>
            <div>
              <p className="text-fg-3">Profit</p>
              <p className={cn('tnum font-medium', p.profit >= 0 ? 'text-ok' : 'text-bad-strong')}>{eur(p.profit)}</p>
            </div>
            <div>
              <p className="text-fg-3">Bruto marža</p>
              <p className="tnum font-medium">{pct(p.margin)}</p>
            </div>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-fg-3">{p.models.join(' · ') || '—'}</p>
          {p.note && <p className="mt-1 text-xs text-fg-3">{p.note}</p>}
          {p.unavailable.length > 0 && (
            <p className="mt-2 text-xs text-bad-strong">Više nisu na skladištu: {p.unavailable.slice(0, 6).join(', ')}{p.unavailable.length > 6 ? ` i još ${p.unavailable.length - 6}` : ''} — uredite paket.</p>
          )}
          {edit && (
            <div className="mt-3 flex justify-end">
              <PackageConvert id={p.id} partners={partners} disabled={p.unavailable.length ? 'Neki uređaji više nisu na skladištu — uredite paket' : null} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
