'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { FormError, useAction, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormGrid, Input, Select } from '@/components/ui/field';
import { Card } from '@/components/ui/misc';
import { LEVEL_LABEL, MODULES, ROLE_DEFAULTS, ROLE_LABEL, type Level, type Module, type RoleCode } from '@/domain/permissions';
import { cn } from '@/lib/cn';

export interface UserValue {
  id?: string;
  name: string;
  email: string;
  role: RoleCode;
  active: boolean;
  permissions: Partial<Record<string, Level>>;
}

const LEVELS: Level[] = ['none', 'view', 'ops', 'edit'];

export function UserForm({ value, save, isSelf }: { value: UserValue; save: ServerAction<Record<string, unknown>>; isSelf: boolean }) {
  const [v, setV] = useState({ ...value, password: '', password2: '' });
  const [perms, setPerms] = useState<Record<Module, Level>>(() => ({ ...ROLE_DEFAULTS[value.role], ...(value.permissions as Record<Module, Level>) }));
  const [localError, setLocalError] = useState<string | null>(null);
  const { run, pending, error, fields } = useAction(save, { onSuccess: () => setV((x) => ({ ...x, password: '', password2: '' })) });
  const defaults = ROLE_DEFAULTS[v.role];
  const admin = v.role === 'ADMIN';
  const overrides = (Object.keys(MODULES) as Module[]).filter((m) => !admin && perms[m] !== defaults[m]).length;

  const changeRole = (role: RoleCode) => {
    // pri promjeni uloge zadržavaju se samo postojeće iznimke
    const old = ROLE_DEFAULTS[v.role];
    const next = { ...ROLE_DEFAULTS[role] };
    for (const m of Object.keys(MODULES) as Module[]) if (perms[m] !== old[m]) next[m] = perms[m];
    setPerms(next);
    setV({ ...v, role });
  };

  const submit = () => {
    setLocalError(null);
    if (v.password || v.password2) {
      if (v.password.length < 8) return setLocalError('Lozinka mora imati barem 8 znakova.');
      if (v.password !== v.password2) return setLocalError('Lozinke se ne podudaraju.');
    } else if (!value.id) return setLocalError('Upišite lozinku za novog korisnika.');
    run({ id: value.id ?? null, name: v.name, email: v.email, role: v.role, active: v.active, password: v.password || null, permissions: perms });
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 xl:grid-cols-3">
        <Card title="Korisnik">
          <div className="space-y-3">
            <Field label="Ime i prezime" required error={fields.name}>
              <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required autoFocus={!value.id} />
            </Field>
            <Field label="E-adresa (prijava)" required error={fields.email}>
              <Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} required autoComplete="off" />
            </Field>
            <Field label="Uloga" hint={isSelf && value.role === 'ADMIN' ? 'Ne možete sami sebi oduzeti ulogu administratora.' : undefined}>
              <Select
                value={v.role}
                disabled={isSelf && value.role === 'ADMIN'}
                onChange={(e) => changeRole(e.target.value as RoleCode)}
                options={Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }))}
              />
            </Field>
            <Checkbox
              label="Aktivan (može se prijaviti)"
              checked={v.active}
              disabled={isSelf}
              onChange={(e) => setV({ ...v, active: e.target.checked })}
              title={isSelf ? 'Ne možete deaktivirati sami sebe' : undefined}
            />
            {!v.active && value.active && <p className="text-xs text-warn">Nakon spremanja korisnik se odjavljuje sa svih uređaja.</p>}
          </div>
        </Card>
        <Card title={value.id ? 'Nova lozinka' : 'Lozinka'} className="xl:col-span-2">
          <FormGrid>
            <Field label="Lozinka" required={!value.id} hint={value.id ? 'Prazno = lozinka ostaje ista. Promjena odjavljuje korisnika sa svih uređaja.' : 'Najmanje 8 znakova.'} error={fields.password}>
              <Input type="password" value={v.password} onChange={(e) => setV({ ...v, password: e.target.value })} autoComplete="new-password" />
            </Field>
            <Field label="Ponovite lozinku">
              <Input type="password" value={v.password2} onChange={(e) => setV({ ...v, password2: e.target.value })} autoComplete="new-password" />
            </Field>
          </FormGrid>
        </Card>
      </div>

      <Card
        title="Prava po modulima"
        padded={false}
        actions={
          !admin && overrides > 0 ? (
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => setPerms({ ...defaults })}>
              Vrati prava uloge ({overrides})
            </Button>
          ) : null
        }
      >
        {admin && <p className="border-b border-line px-4 py-2.5 text-sm text-fg-3">Administrator ima puni pristup svim modulima — iznimke se ne primjenjuju.</p>}
        <div className="overflow-x-auto scroll-slim">
          <table className="data-table">
            <thead>
              <tr>
                <th>Modul</th>
                {LEVELS.map((l) => (
                  <th key={l} className="text-center!">
                    {LEVEL_LABEL[l]}
                  </th>
                ))}
                <th>Uloga „{ROLE_LABEL[v.role]}"</th>
              </tr>
            </thead>
            <tbody>
              {(Object.keys(MODULES) as Module[]).map((m) => {
                const cur = admin ? 'edit' : perms[m];
                const over = !admin && cur !== defaults[m];
                return (
                  <tr key={m} className={cn(over && '[&>td]:bg-warn-soft/60')}>
                    <td className="font-medium">
                      {MODULES[m]}
                      {over && <span className="ml-2 text-xs font-normal text-warn">iznimka</span>}
                    </td>
                    {LEVELS.map((l) => (
                      <td key={l} className="text-center">
                        <label className="inline-flex cursor-pointer items-center justify-center p-1">
                          <input
                            type="radio"
                            name={`perm-${m}`}
                            checked={cur === l}
                            disabled={admin}
                            onChange={() => setPerms({ ...perms, [m]: l })}
                            className="size-4 accent-[var(--color-brand)]"
                            aria-label={`${MODULES[m]}: ${LEVEL_LABEL[l]}`}
                          />
                          {defaults[m] === l && <span className="sr-only">(zadano)</span>}
                        </label>
                        {defaults[m] === l && !admin && <span className="block text-[10px] leading-none text-fg-4">zadano</span>}
                      </td>
                    ))}
                    <td className="text-sm text-fg-3">{LEVEL_LABEL[defaults[m]]}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2.5 text-xs text-fg-3">
          „Operativno" u skladištu daje pregled, označavanje i izlaz iz skladišta bez uređivanja; promjena statusa ide na odobrenje.
        </p>
      </Card>

      <FormError error={localError ?? error} />
      <Button type="submit" variant="primary" loading={pending}>
        {value.id ? 'Spremi korisnika' : 'Dodaj korisnika'}
      </Button>
    </form>
  );
}
