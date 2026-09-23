'use client';

import { useState } from 'react';
import { Lock, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { ActionButton, FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea, type Option } from '@/components/ui/field';
import { Badge, COLOR_TONE, Empty, TableWrap } from '@/components/ui/misc';
import { amount, integer, pct } from '@/lib/format';
import { cn } from '@/lib/cn';

type Val = string | number | boolean | null;

export interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'number' | 'decimal' | 'select' | 'checkbox' | 'textarea';
  options?: Option[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  /** Širina u mreži od 2 stupca. */
  wide?: boolean;
  /** Polje je zaključano za sistemske zapise. */
  lockedForSystem?: boolean;
}

export interface ColumnDef {
  key: string;
  label: string;
  format?: 'text' | 'money' | 'int' | 'pct' | 'badge' | 'muted';
  /** Za format „badge": ključ boje u retku. */
  colorKey?: string;
}

export interface LookupRow {
  id: string;
  values: Record<string, Val>;
  cells: Record<string, Val>;
  system?: boolean;
  active?: boolean;
}

type Entity = 'warehouse' | 'category' | 'model' | 'status' | 'service' | 'expenseCategory';

const toInput = (v: Val) => (v === null || v === undefined ? '' : typeof v === 'number' ? String(v).replace('.', ',') : v);

/**
 * Tablica šifrarnika s uređivanjem u prozoru. Brisanje javlja jasnu poruku
 * kad je zapis u upotrebi; gdje postoji oznaka „aktivan" nudi se deaktivacija.
 */
export function LookupEditor({
  entity,
  title,
  description,
  columns,
  fields,
  rows,
  defaults,
  canEdit,
  save,
  remove,
  setActive,
}: {
  entity: Entity;
  title: string;
  description?: string;
  columns: ColumnDef[];
  fields: FieldDef[];
  rows: LookupRow[];
  defaults: Record<string, Val>;
  canEdit: boolean;
  save: ServerAction<{ entity: Entity; id: string | null; values: Record<string, Val>; applyRent?: boolean }>;
  remove: ServerAction<{ entity: Entity; id: string }>;
  setActive?: ServerAction<{ entity: 'warehouse' | 'model' | 'service'; id: string; active: boolean }>;
}) {
  const [edit, setEdit] = useState<{ id: string | null; system: boolean; values: Record<string, Val>; original: Record<string, Val> } | null>(null);
  const [applyRent, setApplyRent] = useState(false);
  const { run, pending, error, fields: errs } = useAction(save, { onSuccess: () => setEdit(null) });
  const hasActive = rows.some((r) => r.active !== undefined) || 'active' in defaults;

  const open = (row?: LookupRow) => {
    const values = row ? { ...row.values } : { ...defaults };
    setApplyRent(false);
    setEdit({ id: row?.id ?? null, system: !!row?.system, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'boolean' ? v : toInput(v)])), original: values });
  };
  const rentChanged = entity === 'model' && edit && String(edit.values.rentPrice ?? '') !== '' && String(edit.values.rentPrice) !== toInput(edit.original.rentPrice ?? null);

  const cell = (c: ColumnDef, r: LookupRow) => {
    const v = r.cells[c.key];
    if (v === null || v === undefined || v === '') return <span className="text-fg-4">—</span>;
    switch (c.format) {
      case 'money':
        return amount(Number(v));
      case 'int':
        return integer(Number(v));
      case 'pct':
        return pct(Number(v));
      case 'muted':
        return <span className="text-fg-3">{String(v)}</span>;
      case 'badge':
        return <Badge tone={COLOR_TONE[String(r.cells[c.colorKey ?? 'color'])] ?? 'neutral'}>{String(v)}</Badge>;
      default:
        return String(v);
    }
  };
  const numeric = (c: ColumnDef) => c.format === 'money' || c.format === 'int' || c.format === 'pct';

  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-md font-semibold">{title}</h2>
          {description && <p className="text-sm text-fg-3">{description}</p>}
        </div>
        {canEdit && (
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open()}>
            Dodaj
          </Button>
        )}
      </div>
      <TableWrap>
        {rows.length ? (
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} className={cn(numeric(c) && 'num')}>
                    {c.label}
                  </th>
                ))}
                {hasActive && <th>Aktivan</th>}
                {canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cn(r.active === false && 'opacity-60')}>
                  {columns.map((c, i) => (
                    <td key={c.key} className={cn(numeric(c) && 'num', i === 0 && 'font-medium')}>
                      {cell(c, r)}
                      {i === 0 && r.system && (
                        <span title="Sistemski zapis — ne briše se" className="ml-1.5 inline-flex align-middle text-fg-4">
                          <Lock className="size-3" />
                        </span>
                      )}
                    </td>
                  ))}
                  {hasActive && <td>{r.active === false ? <Badge>neaktivan</Badge> : <Badge tone="ok">da</Badge>}</td>}
                  {canEdit && (
                    <td className="w-px whitespace-nowrap text-right">
                      <Button size="sm" variant="ghost" aria-label="Uredi" title="Uredi" icon={<Pencil className="size-3.5" />} onClick={() => open(r)} />
                      {setActive && r.active !== undefined && (
                        <ActionButton
                          size="sm"
                          variant="ghost"
                          title={r.active ? 'Deaktiviraj' : 'Aktiviraj'}
                          aria-label={r.active ? 'Deaktiviraj' : 'Aktiviraj'}
                          icon={<Power className={cn('size-3.5', r.active ? 'text-ok' : 'text-fg-4')} />}
                          action={setActive}
                          input={{ entity: entity as 'warehouse' | 'model' | 'service', id: r.id, active: !r.active }}
                        />
                      )}
                      {!r.system && (
                        <ActionButton
                          size="sm"
                          variant="ghost"
                          title="Obriši"
                          aria-label="Obriši"
                          icon={<Trash2 className="size-3.5" />}
                          action={remove}
                          input={{ entity, id: r.id }}
                          confirmTitle="Brisanje"
                          confirmLabel="Obriši"
                          confirm={`Obrisati „${String(r.cells[columns[0].key])}"? Brisanje nije moguće ako se zapis negdje koristi.`}
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="Nema zapisa" description={canEdit ? 'Dodajte prvi zapis.' : undefined} />
        )}
      </TableWrap>

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? `Uredi — ${title.toLowerCase()}` : `Novi zapis — ${title.toLowerCase()}`}
        size={fields.length > 6 ? 'lg' : 'sm'}
        footer={
          <>
            <Button onClick={() => setEdit(null)}>Odustani</Button>
            <Button variant="primary" loading={pending} onClick={() => edit && run({ entity, id: edit.id, values: edit.values, applyRent: rentChanged ? applyRent : false })}>
              Spremi
            </Button>
          </>
        }
      >
        {edit && (
          <form
            className={cn('grid gap-3', fields.length > 6 && 'sm:grid-cols-2')}
            onSubmit={(e) => {
              e.preventDefault();
              run({ entity, id: edit.id, values: edit.values, applyRent: rentChanged ? applyRent : false });
            }}
          >
            {fields.map((f) => {
              const locked = f.lockedForSystem && edit.system;
              const v = edit.values[f.name];
              const set = (nv: Val) => setEdit({ ...edit, values: { ...edit.values, [f.name]: nv } });
              if (f.type === 'checkbox') {
                return <Checkbox key={f.name} label={f.label} checked={!!v} onChange={(e) => set(e.target.checked)} className={cn(fields.length > 6 && 'sm:col-span-2')} />;
              }
              return (
                <Field
                  key={f.name}
                  label={f.label}
                  required={f.required}
                  error={errs[`values.${f.name}`] ?? errs[f.name]}
                  hint={locked ? 'Sistemski status — vrsta se ne mijenja.' : f.hint}
                  className={cn(f.wide && fields.length > 6 && 'sm:col-span-2')}
                >
                  {f.type === 'select' ? (
                    <Select value={String(v ?? '')} onChange={(e) => set(e.target.value)} options={f.options ?? []} placeholder={f.required ? undefined : '—'} disabled={locked} />
                  ) : f.type === 'textarea' ? (
                    <Textarea value={String(v ?? '')} onChange={(e) => set(e.target.value)} rows={3} />
                  ) : (
                    <Input
                      value={String(v ?? '')}
                      onChange={(e) => set(e.target.value)}
                      inputMode={f.type === 'decimal' ? 'decimal' : f.type === 'number' ? 'numeric' : undefined}
                      className={cn((f.type === 'decimal' || f.type === 'number') && 'text-right')}
                      placeholder={f.placeholder}
                      autoFocus={f === fields[0]}
                    />
                  )}
                </Field>
              );
            })}
            {rentChanged && (
              <div className={cn('rounded-md bg-brand-soft px-3 py-2', fields.length > 6 && 'sm:col-span-2')}>
                <Checkbox checked={applyRent} onChange={(e) => setApplyRent(e.target.checked)} label="Primijeni novi najam na uređaje ovog modela bez vlastite cijene najma" />
              </div>
            )}
            <div className={cn(fields.length > 6 && 'sm:col-span-2')}>
              <FormError error={error} />
            </div>
            <button type="submit" className="hidden" />
          </form>
        )}
      </Dialog>
    </>
  );
}
