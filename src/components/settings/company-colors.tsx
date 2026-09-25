'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { Check, LayoutDashboard, Palette, RotateCcw, Warehouse, Wrench } from 'lucide-react';
import { useAction, type ServerAction } from '@/components/ui/action';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Badge, Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import {
  COLOR_PRESETS, DEFAULT_BRAND_COLOR, DEFAULT_MENU_COLOR, SURFACES, deriveTheme, normalizeHex, tokenStyle, type ThemeName, type ThemeTokens,
} from '@/domain/brand-colors';

export interface CompanyColorsValue {
  brandColor: string | null;
  menuColor: string | null;
}

/** Svijetle podloge i tekst za pregled svijetle teme kad je stranica u tamnoj temi (iste vrijednosti kao globals.css). */
const LIGHT_BASE: Record<string, string> = {
  '--color-canvas': SURFACES.light.canvas, '--color-panel': SURFACES.light.panel, '--color-panel-2': SURFACES.light.panel2,
  '--color-muted': SURFACES.light.muted, '--color-line': '#e2e5df', '--color-line-strong': '#cfd4cc',
  '--color-fg': '#1b2420', '--color-fg-2': '#4a5550', '--color-fg-3': '#646c68', '--color-fg-4': '#6b736f',
  colorScheme: 'light',
};

/** Postavke → Firma: boja naglaska i lijevog izbornika, s pregledom u obje teme. */
export function CompanyColorsCard({ value, save, canEdit }: { value: CompanyColorsValue; save: ServerAction<CompanyColorsValue>; canEdit: boolean }) {
  const [brand, setBrand] = useState(value.brandColor ?? DEFAULT_BRAND_COLOR);
  const [menu, setMenu] = useState(value.menuColor ?? DEFAULT_MENU_COLOR);
  const { run, pending } = useAction(save);
  const theme = useMemo(() => deriveTheme({ brandColor: brand, menuColor: menu }), [brand, menu]);
  const saved = (value.brandColor ?? DEFAULT_BRAND_COLOR) === brand && (value.menuColor ?? DEFAULT_MENU_COLOR) === menu;
  const isDefault = brand === DEFAULT_BRAND_COLOR && menu === DEFAULT_MENU_COLOR;
  const adjusted = theme.light.brand !== brand;

  const reset = () => {
    setBrand(DEFAULT_BRAND_COLOR);
    setMenu(DEFAULT_MENU_COLOR);
    void run({ brandColor: null, menuColor: null });
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Palette className="size-4 text-fg-3" /> Boje firme
        </span>
      }
      actions={
        canEdit && (
          <>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={reset} disabled={pending || (isDefault && !value.brandColor && !value.menuColor)}>
              Vrati zadane
            </Button>
            <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} loading={pending} disabled={saved} onClick={() => void run({ brandColor: brand, menuColor: menu })}>
              Spremi boje
            </Button>
          </>
        )
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]" data-company-colors-card>
        <div className="space-y-4">
          <ColorField id="brandColor" label="Boja naglaska (gumbi, poveznice, oznake)" value={brand} onChange={setBrand} disabled={!canEdit} />
          <ColorField id="menuColor" label="Boja izbornika (lijevi izbornik)" value={menu} onChange={setMenu} disabled={!canEdit} />
          <div>
            <p className="mb-1.5 text-sm font-medium text-fg-2">Gotove kombinacije</p>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-2">
              {COLOR_PRESETS.map((p) => {
                const on = p.brand === brand && p.menu === menu;
                return (
                  <button
                    key={p.name}
                    type="button"
                    disabled={!canEdit}
                    onClick={() => {
                      setBrand(p.brand);
                      setMenu(p.menu);
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors disabled:opacity-60',
                      on ? 'border-brand bg-brand-soft text-fg' : 'border-line hover:bg-muted',
                    )}
                    aria-pressed={on}
                  >
                    <span className="flex shrink-0 overflow-hidden rounded ring-1 ring-black/10">
                      <span className="block size-4" style={{ background: p.menu }} />
                      <span className="block size-4" style={{ background: p.brand }} />
                    </span>
                    <span className="truncate">{p.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-fg-3">
            Boje se automatski prilagođavaju za čitljivost (kontrast teksta po WCAG-u) u svijetloj i tamnoj temi.
            {adjusted && (
              <>
                {' '}Naglasak je u svijetloj temi potamnjen na <span className="font-mono">{theme.light.brand}</span>.
              </>
            )}
          </p>
        </div>
        <div className="grid min-w-0 gap-3 xl:grid-cols-2">
          <Preview name="light" tokens={theme.light} />
          <Preview name="dark" tokens={theme.dark} />
        </div>
      </div>
    </Card>
  );
}

function ColorField({ id, label, value, onChange, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const [text, setText] = useState(value);
  const [last, setLast] = useState(value);
  // vanjska promjena (gotova kombinacija, „Vrati zadane") osvježava tekstno polje
  if (value !== last) {
    setLast(value);
    setText(value);
  }
  const invalid = !normalizeHex(text);
  return (
    <div>
      <label htmlFor={`${id}-hex`} className="mb-1 block text-sm font-medium text-fg-2">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
          className="h-8 w-12 shrink-0 cursor-pointer rounded-md border border-line-strong bg-panel p-0.5 disabled:cursor-default"
        />
        <Input
          id={`${id}-hex`}
          name={id}
          value={text}
          disabled={disabled}
          maxLength={7}
          spellCheck={false}
          className={cn('w-28 font-mono', invalid && 'border-bad')}
          onChange={(e) => {
            setText(e.target.value);
            const hex = normalizeHex(e.target.value);
            if (hex && e.target.value.replace('#', '').length === 6) onChange(hex);
          }}
          onBlur={() => {
            const hex = normalizeHex(text);
            if (hex) onChange(hex);
            setText(hex ?? value);
          }}
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-bad">Upišite boju oblika #rrggbb.</p>}
    </div>
  );
}

/** Umanjeni prikaz aplikacije u zadanoj temi, s izvedenim bojama. */
function Preview({ name, tokens }: { name: ThemeName; tokens: ThemeTokens }) {
  const style = { ...(name === 'light' ? LIGHT_BASE : {}), ...tokenStyle(tokens) } as CSSProperties;
  return (
    <figure className="min-w-0" data-preview={name}>
      <figcaption className="mb-1 text-xs font-medium uppercase tracking-wider text-fg-3">{name === 'light' ? 'Svijetla tema' : 'Tamna tema'}</figcaption>
      <div data-theme={name} style={style} className="flex h-56 overflow-hidden rounded-lg border border-line bg-canvas text-fg" aria-hidden>
        <div className="flex w-36 shrink-0 flex-col bg-nav px-1.5 py-2">
          <div className="mb-2 flex items-center gap-1.5 px-1">
            <span className="grid size-6 place-items-center rounded-md bg-brand text-white">
              <Warehouse className="size-3.5" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-nav-fg-strong">ERP · WMS</span>
              <span className="block truncate text-[0.625rem] leading-3 text-nav-fg-2">Moja firma</span>
            </span>
          </div>
          <span className="px-1.5 pb-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-nav-fg-2">Rad</span>
          <span className="flex h-6 items-center gap-1.5 rounded bg-brand px-1.5 text-sm text-white">
            <LayoutDashboard className="size-3.5" /> Nadzorna ploča
          </span>
          <span className="flex h-6 items-center gap-1.5 rounded bg-nav-2 px-1.5 text-sm text-nav-fg-strong">
            <Warehouse className="size-3.5 text-nav-fg-2" /> Skladište
          </span>
          <span className="flex h-6 items-center gap-1.5 rounded px-1.5 text-sm text-nav-fg">
            <Wrench className="size-3.5 text-nav-fg-2" /> Servis
          </span>
        </div>
        <div className="min-w-0 flex-1 p-2.5">
          <div className="rounded-md bg-panel p-2.5 shadow-[var(--shadow-panel)]">
            <p className="text-sm font-semibold">Račun R-2026-0042</p>
            <p className="mt-0.5 text-xs text-fg-3">
              Kupac: <span className="link underline-offset-2 hover:underline">Primjer d.o.o.</span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Badge tone="brand">Najam</Badge>
              <Badge tone="neutral">Nacrt</Badge>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" tabIndex={-1}>
                Izdaj račun
              </Button>
              <Button size="sm" variant="subtle" tabIndex={-1}>
                Pregled
              </Button>
            </div>
          </div>
          <div className="mt-2 rounded-md bg-brand-soft px-2.5 py-1.5 text-xs text-fg">Označeni redak u tablici</div>
        </div>
      </div>
    </figure>
  );
}
