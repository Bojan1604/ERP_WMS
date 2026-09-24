'use client';

import { useState, type ReactNode } from 'react';
import type { Platform } from '@/domain/mdm';
import { cn } from '@/lib/cn';
import { ConfigApps } from './config-apps';
import { ConfigLockdown, ConfigNetwork, ConfigSystem } from './config-settings';
import { previewJson, type EditorConfig, type LibraryApp } from './config-model';

export interface ExtraTab {
  key: string;
  label: string;
  content: ReactNode;
}

/**
 * Uređivač konfiguracije s karticama: Aplikacije, Zaključani način, Mreža,
 * Sustav i JSON pregled. Isti za profil i za izmjene pojedinog uređaja.
 */
export function ConfigEditor({
  value,
  onChange,
  platform,
  library,
  readOnly,
  inherited,
  leading = [],
  trailing = [],
}: {
  value: EditorConfig;
  onChange: (v: EditorConfig) => void;
  platform: Platform;
  library: LibraryApp[];
  readOnly?: boolean;
  inherited?: string[];
  leading?: ExtraTab[];
  trailing?: ExtraTab[];
}) {
  const settingsProps = { value: value.settings, onChange: (settings: EditorConfig['settings']) => onChange({ ...value, settings }), platform, readOnly };
  const tabs: ExtraTab[] = [
    ...leading,
    { key: 'apps', label: `Aplikacije (${value.apps.length})`, content: <ConfigApps value={value.apps} onChange={(apps) => onChange({ ...value, apps })} library={library} readOnly={readOnly} inherited={inherited} /> },
    { key: 'lock', label: 'Zaključani način', content: <ConfigLockdown {...settingsProps} /> },
    { key: 'net', label: `Mreža (${value.settings.wifi.length})`, content: <ConfigNetwork {...settingsProps} /> },
    { key: 'sys', label: 'Sustav', content: <ConfigSystem {...settingsProps} /> },
    ...trailing,
    {
      key: 'json',
      label: 'JSON',
      content: (
        <div>
          <p className="mb-2 text-sm text-fg-3">Ovo dobiva agent na uređaju (lozinke su ovdje skrivene). Promjene su vidljive i prije spremanja.</p>
          <pre className="max-h-[60vh] overflow-auto scroll-slim rounded-lg bg-muted p-3 font-mono text-xs">{previewJson(value, library)}</pre>
        </div>
      ),
    },
  ];
  const [tab, setTab] = useState(tabs[0].key);
  const active = tabs.find((t) => t.key === tab) ?? tabs[0];
  return (
    <div>
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line scroll-slim" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === active.key}
            onClick={() => setTab(t.key)}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-base', t.key === active.key ? 'border-brand font-medium text-fg' : 'border-transparent text-fg-3 hover:text-fg')}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {active.content}
    </div>
  );
}
