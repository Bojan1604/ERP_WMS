/**
 * Stanje padajućeg odabira s pretragom (Combobox, MultiSelectFilter) — čista logika, bez Reacta,
 * da se može testirati (tests/ui-combobox.test.ts).
 *
 * Pretraga na poslužitelju kasni (odgoda 200 ms + mreža): svaki upit dobiva redni broj (`seq`),
 * a odgovor se prihvaća samo ako nosi redni broj TRENUTNOG upita — zastarjeli odgovori se odbacuju.
 * Enter dok se rezultat za trenutni upit još čeka ne bira stari rezultat nego se pamti (`pendingEnter`)
 * i prvi rezultat trenutnog upita odabire se čim stigne.
 */
import { fold } from '@/lib/fold';

export interface ComboItem {
  value: string;
  label: string;
  hint?: string;
}

export interface ComboState<T extends ComboItem = ComboItem> {
  open: boolean;
  q: string;
  /** Redni broj trenutnog upita; odgovor s drugim brojem je zastario. */
  seq: number;
  /** Rezultati poslužitelja za upit `seq` (null = još nisu stigli za ovo otvaranje). */
  remote: T[] | null;
  /** Čeka se odgovor poslužitelja za trenutni upit. */
  loading: boolean;
  active: number;
  /** Enter pritisnut dok se čekao odgovor — odaberi prvi rezultat kad stigne. */
  pendingEnter: boolean;
  /** Odabir koji komponenta treba predati van (`onChange`); novi objekt pri svakom odabiru. */
  selection: { option: T | null } | null;
}

export type ComboAction<T extends ComboItem = ComboItem> =
  | { type: 'open'; remote: boolean }
  | { type: 'close' }
  | { type: 'query'; q: string; remote: boolean }
  | { type: 'results'; seq: number; options: T[] }
  | { type: 'move'; delta: number; count: number }
  | { type: 'hover'; index: number }
  /** `list` = trenutno prikazani popis (lokalno filtriran ili rezultati poslužitelja). */
  | { type: 'enter'; list: T[] }
  | { type: 'pick'; option: T | null };

export function initialComboState<T extends ComboItem = ComboItem>(): ComboState<T> {
  return { open: false, q: '', seq: 0, remote: null, loading: false, active: 0, pendingEnter: false, selection: null };
}

/** Zatvoren popis: upit se briše (sljedeće otvaranje počinje čisto), zastarjeli odgovori se odbacuju. */
function closed<T extends ComboItem>(s: ComboState<T>, selection: ComboState<T>['selection'] = null): ComboState<T> {
  return { ...s, open: false, q: '', seq: s.seq + 1, remote: null, loading: false, active: 0, pendingEnter: false, selection };
}

export function comboReducer<T extends ComboItem>(s: ComboState<T>, a: ComboAction<T>): ComboState<T> {
  switch (a.type) {
    case 'open':
      if (s.open) return s;
      return { ...s, open: true, q: '', seq: s.seq + 1, remote: null, loading: a.remote, active: 0, pendingEnter: false, selection: null };
    case 'close':
      return s.open ? closed(s) : s;
    case 'query':
      if (a.q === s.q) return s;
      return { ...s, q: a.q, seq: s.seq + 1, loading: a.remote, active: 0, pendingEnter: false };
    case 'results': {
      // zastario (upit se u međuvremenu promijenio ili je popis zatvoren)
      if (!s.open || a.seq !== s.seq) return s;
      const next = { ...s, remote: a.options, loading: false, active: 0 };
      if (s.pendingEnter) return a.options.length ? closed(next, { option: a.options[0] }) : { ...next, pendingEnter: false };
      return next;
    }
    case 'move': {
      if (!a.count) return s;
      return { ...s, active: Math.max(0, Math.min(s.active + a.delta, a.count - 1)) };
    }
    case 'hover':
      return { ...s, active: a.index };
    case 'enter': {
      if (!s.open) return s;
      // rezultat za trenutni upit još nije stigao — nikad ne biraj stari
      if (s.loading) return { ...s, pendingEnter: true };
      const o = a.list[s.active] ?? a.list[0];
      return o ? closed(s, { option: o }) : s;
    }
    case 'pick':
      return closed(s, { option: a.option });
  }
}

/** Lokalno filtriranje (bez poslužitelja): bez dijakritika i velikih slova, najviše `limit` opcija. */
export function filterOptions<T extends ComboItem>(options: T[], q: string, limit = 200): T[] {
  const t = fold(q.trim());
  const src = t ? options.filter((o) => fold(`${o.label} ${o.hint ?? ''}`).includes(t)) : options;
  return src.slice(0, limit);
}
