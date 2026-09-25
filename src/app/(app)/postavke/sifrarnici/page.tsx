import type { ReactNode } from 'react';
import { pageAccess } from '@/server/auth';
import { db } from '@/server/db';
import { can } from '@/domain/permissions';
import { num } from '@/domain/money';
import { STATUS_KIND_LABEL } from '@/server/services/items';
import { PageHeader } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { LookupEditor, type ColumnDef, type FieldDef, type LookupRow } from '@/components/settings/lookup-editor';
import { deleteLookupAction, saveLookupAction, setActiveAction } from './actions';

export const metadata = { title: 'Šifrarnici' };

const TABS = [
  { key: 'skladista', label: 'Skladišta' },
  { key: 'kategorije', label: 'Kategorije' },
  { key: 'modeli', label: 'Modeli' },
  { key: 'statusi', label: 'Statusi uređaja' },
  { key: 'usluge', label: 'Usluge' },
  { key: 'troskovi', label: 'Kategorije troškova' },
] as const;

const COLOR_OPTIONS = [
  { value: 'gray', label: 'Siva' },
  { value: 'green', label: 'Zelena' },
  { value: 'blue', label: 'Plava' },
  { value: 'purple', label: 'Ljubičasta' },
  { value: 'red', label: 'Crvena' },
  { value: 'amber', label: 'Jantarna' },
  { value: 'teal', label: 'Tirkizna' },
  { value: 'orange', label: 'Narančasta' },
];
const nOrNull = (v: { toNumber(): number } | null) => (v === null ? null : num(v));

export default async function LookupsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await pageAccess('settings');
  const tab = (await searchParams).tab ?? 'skladista';
  const c = user.companyId;
  const canEdit = can(user.perms, 'settings', 'edit');
  const common = { canEdit, save: saveLookupAction, remove: deleteLookupAction };

  let body: ReactNode = null;

  if (tab === 'kategorije') {
    const [rows, models] = await Promise.all([
      db.category.findMany({ where: { companyId: c }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
      db.deviceModel.groupBy({ by: ['categoryId'], where: { companyId: c }, _count: { _all: true } }),
    ]);
    const cnt = new Map(models.map((m) => [m.categoryId, m._count._all]));
    body = (
      <LookupEditor
        {...common}
        entity="category"
        title="Kategorije"
        description="Grupe modela za izvještaje i filtre."
        columns={[{ key: 'name', label: 'Naziv' }, { key: 'models', label: 'Modela', format: 'int' }, { key: 'sort', label: 'Redoslijed', format: 'int' }]}
        fields={[{ name: 'name', label: 'Naziv', type: 'text', required: true }, { name: 'sort', label: 'Redoslijed', type: 'number' }]}
        defaults={{ name: '', sort: 0 }}
        rows={rows.map((r) => ({ id: r.id, values: { name: r.name, sort: r.sort }, cells: { name: r.name, sort: r.sort, models: cnt.get(r.id) ?? 0 } }))}
      />
    );
  } else if (tab === 'modeli') {
    const [rows, categories, stock] = await Promise.all([
      db.deviceModel.findMany({ where: { companyId: c }, orderBy: [{ active: 'desc' }, { brand: 'asc' }, { name: 'asc' }], include: { category: { select: { name: true } } } }),
      db.category.findMany({ where: { companyId: c }, orderBy: [{ sort: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
      db.item.groupBy({ by: ['modelId'], where: { companyId: c, state: 'IN_STOCK' }, _count: { _all: true } }),
    ]);
    const inStock = new Map(stock.map((s) => [s.modelId, s._count._all]));
    const fields: FieldDef[] = [
      { name: 'brand', label: 'Proizvođač', type: 'text' },
      { name: 'name', label: 'Naziv', type: 'text', required: true },
      { name: 'code', label: 'Šifra artikla', type: 'text' },
      { name: 'categoryId', label: 'Kategorija', type: 'select', options: categories.map((k) => ({ value: k.id, label: k.name })) },
      { name: 'salePrice', label: 'Prodajna cijena (bez PDV-a)', type: 'decimal', hint: 'Prazno = iz nabavne i marže' },
      { name: 'rentPrice', label: 'Najam mjesečno', type: 'decimal' },
      { name: 'marginPct', label: 'Bruto marža %', type: 'decimal', hint: 'Prazno = globalna marža' },
      { name: 'warrantyMonths', label: 'Jamstvo (mjeseci)', type: 'number', hint: 'Prazno = zadano iz postavki' },
      { name: 'minStock', label: 'Minimalna zaliha', type: 'number', hint: 'Upozorenje na nadzornoj ploči' },
      { name: 'kpd', label: 'KPD šifra', type: 'text', hint: 'Klasifikacija za eRačun (prodaja)' },
      { name: 'kpdRent', label: 'KPD za najam', type: 'text', hint: 'Prazno = KPD najma iz postavki firme' },
      { name: 'specs', label: 'Specifikacije', type: 'textarea', wide: true },
      { name: 'active', label: 'Aktivan (nudi se pri unosu)', type: 'checkbox' },
    ];
    const columns: ColumnDef[] = [
      { key: 'label', label: 'Model' },
      { key: 'code', label: 'Šifra', format: 'muted' },
      { key: 'category', label: 'Kategorija' },
      { key: 'salePrice', label: 'Prodajna', format: 'money' },
      { key: 'rentPrice', label: 'Najam/mj', format: 'money' },
      { key: 'marginPct', label: 'Marža', format: 'pct' },
      { key: 'warrantyMonths', label: 'Jamstvo', format: 'int' },
      { key: 'stock', label: 'Na skladištu', format: 'int' },
      { key: 'minStock', label: 'Min.', format: 'int' },
    ];
    body = (
      <LookupEditor
        {...common}
        setActive={setActiveAction}
        entity="model"
        title="Modeli"
        description="Artikli koji se prate po serijskom broju, s cijenama, maržom i jamstvom."
        columns={columns}
        fields={fields}
        defaults={{ brand: '', name: '', code: '', categoryId: '', salePrice: null, rentPrice: null, marginPct: null, warrantyMonths: null, minStock: 0, kpd: '', kpdRent: '', specs: '', active: true }}
        rows={rows.map<LookupRow>((m) => ({
          id: m.id,
          active: m.active,
          values: {
            brand: m.brand, name: m.name, code: m.code, categoryId: m.categoryId, salePrice: nOrNull(m.salePrice), rentPrice: nOrNull(m.rentPrice),
            marginPct: nOrNull(m.marginPct), warrantyMonths: m.warrantyMonths, minStock: m.minStock, kpd: m.kpd, kpdRent: m.kpdRent, specs: m.specs, active: m.active,
          },
          cells: {
            label: [m.brand, m.name].filter(Boolean).join(' '), code: m.code, category: m.category?.name ?? null, salePrice: nOrNull(m.salePrice),
            rentPrice: nOrNull(m.rentPrice), marginPct: nOrNull(m.marginPct), warrantyMonths: m.warrantyMonths, stock: inStock.get(m.id) ?? 0, minStock: m.minStock || null,
          },
        }))}
      />
    );
  } else if (tab === 'statusi') {
    const [rows, counts] = await Promise.all([
      db.itemStatus.findMany({ where: { companyId: c }, orderBy: [{ sort: 'asc' }, { name: 'asc' }] }),
      db.item.groupBy({ by: ['statusId'], where: { companyId: c }, _count: { _all: true } }),
    ]);
    const cnt = new Map(counts.map((r) => [r.statusId, r._count._all]));
    body = (
      <LookupEditor
        {...common}
        entity="status"
        title="Statusi uređaja"
        description="Svaki status pripada jednoj vrsti koju program koristi u logici. Sistemski statusi mogu se preimenovati i obojati, ali ne i obrisati ni promijeniti im vrstu."
        columns={[
          { key: 'name', label: 'Naziv', format: 'badge', colorKey: 'color' },
          { key: 'kind', label: 'Vrsta' },
          { key: 'items', label: 'Uređaja', format: 'int' },
          { key: 'sort', label: 'Redoslijed', format: 'int' },
        ]}
        fields={[
          { name: 'name', label: 'Naziv', type: 'text', required: true },
          { name: 'kind', label: 'Vrsta', type: 'select', required: true, lockedForSystem: true, options: Object.entries(STATUS_KIND_LABEL).map(([value, label]) => ({ value, label })) },
          { name: 'color', label: 'Boja', type: 'select', required: true, options: COLOR_OPTIONS },
          { name: 'sort', label: 'Redoslijed', type: 'number' },
        ]}
        defaults={{ name: '', kind: 'OTHER', color: 'gray', sort: 50 }}
        rows={rows.map((s) => ({
          id: s.id,
          system: s.system,
          values: { name: s.name, kind: s.kind, color: s.color, sort: s.sort },
          cells: { name: s.name, color: s.color, kind: STATUS_KIND_LABEL[s.kind], items: cnt.get(s.id) ?? 0, sort: s.sort },
        }))}
      />
    );
  } else if (tab === 'usluge') {
    const rows = await db.service.findMany({ where: { companyId: c }, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    body = (
      <LookupEditor
        {...common}
        setActive={setActiveAction}
        entity="service"
        title="Usluge"
        description="Stavke bez serijskog broja za račune i ponude (dostava, instalacija, servisni sat…)."
        columns={[{ key: 'name', label: 'Naziv' }, { key: 'unit', label: 'Jedinica', format: 'muted' }, { key: 'price', label: 'Cijena', format: 'money' }, { key: 'kpd', label: 'KPD', format: 'muted' }]}
        fields={[
          { name: 'name', label: 'Naziv', type: 'text', required: true },
          { name: 'unit', label: 'Jedinica mjere', type: 'text', required: true, placeholder: 'kom, h, km…' },
          { name: 'price', label: 'Cijena (bez PDV-a)', type: 'decimal' },
          { name: 'kpd', label: 'KPD šifra', type: 'text' },
          { name: 'active', label: 'Aktivna', type: 'checkbox' },
        ]}
        defaults={{ name: '', unit: 'kom', price: 0, kpd: '', active: true }}
        rows={rows.map((s) => ({
          id: s.id,
          active: s.active,
          values: { name: s.name, unit: s.unit, price: num(s.price), kpd: s.kpd, active: s.active },
          cells: { name: s.name, unit: s.unit, price: num(s.price), kpd: s.kpd },
        }))}
      />
    );
  } else if (tab === 'troskovi') {
    const [rows, counts] = await Promise.all([
      db.expenseCategory.findMany({ where: { companyId: c }, orderBy: { name: 'asc' } }),
      db.expense.groupBy({ by: ['categoryId'], where: { companyId: c }, _count: { _all: true } }),
    ]);
    const cnt = new Map(counts.map((r) => [r.categoryId, r._count._all]));
    body = (
      <LookupEditor
        {...common}
        entity="expenseCategory"
        title="Kategorije troškova"
        columns={[{ key: 'name', label: 'Naziv' }, { key: 'expenses', label: 'Troškova', format: 'int' }]}
        fields={[{ name: 'name', label: 'Naziv', type: 'text', required: true }]}
        defaults={{ name: '' }}
        rows={rows.map((r) => ({ id: r.id, values: { name: r.name }, cells: { name: r.name, expenses: cnt.get(r.id) ?? 0 } }))}
      />
    );
  } else {
    const [rows, counts] = await Promise.all([
      db.warehouse.findMany({ where: { companyId: c }, orderBy: [{ active: 'desc' }, { sort: 'asc' }, { name: 'asc' }] }),
      db.item.groupBy({ by: ['warehouseId'], where: { companyId: c, state: 'IN_STOCK' }, _count: { _all: true } }),
    ]);
    const cnt = new Map(counts.map((r) => [r.warehouseId, r._count._all]));
    body = (
      <LookupEditor
        {...common}
        setActive={setActiveAction}
        entity="warehouse"
        title="Skladišta"
        description="Lokacije na kojima se drže uređaji. Skladište s uređajima ne može se obrisati ni deaktivirati."
        columns={[{ key: 'name', label: 'Naziv' }, { key: 'address', label: 'Adresa', format: 'muted' }, { key: 'items', label: 'Na skladištu', format: 'int' }, { key: 'sort', label: 'Redoslijed', format: 'int' }]}
        fields={[
          { name: 'name', label: 'Naziv', type: 'text', required: true },
          { name: 'address', label: 'Adresa', type: 'text' },
          { name: 'sort', label: 'Redoslijed', type: 'number' },
          { name: 'active', label: 'Aktivno', type: 'checkbox' },
        ]}
        defaults={{ name: '', address: '', sort: 0, active: true }}
        rows={rows.map((w) => ({
          id: w.id,
          active: w.active,
          values: { name: w.name, address: w.address, sort: w.sort, active: w.active },
          cells: { name: w.name, address: w.address, items: cnt.get(w.id) ?? 0, sort: w.sort },
        }))}
      />
    );
  }

  return (
    <>
      <PageHeader title="Šifrarnici" subtitle="Skladišta, kategorije, modeli, statusi, usluge i kategorije troškova" />
      <Tabs param="tab" tabs={TABS.map((t) => ({ href: t.key === 'skladista' ? '/postavke/sifrarnici' : `/postavke/sifrarnici?tab=${t.key}`, label: t.label }))} />
      {body}
    </>
  );
}
