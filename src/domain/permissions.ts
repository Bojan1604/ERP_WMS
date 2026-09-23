/**
 * Prava pristupa po modulu i razini. Razine rastu: none < view < ops < edit.
 * „ops" (operativno) u skladištu daje pregled, označavanje i izlaz iz
 * skladišta, bez uređivanja i brisanja; promjena statusa ide na odobrenje.
 * Iznimka zadana na korisniku ima prednost pred ulogom.
 */
export type RoleCode = 'ADMIN' | 'MANAGER' | 'SALES' | 'WAREHOUSE' | 'ACCOUNTANT';
export type Level = 'none' | 'view' | 'ops' | 'edit';

export const MODULES = {
  dashboard: 'Nadzorna ploča',
  warehouse: 'Skladište',
  sales: 'Prodaja i računi',
  rentals: 'Najam i ugovori',
  purchasing: 'Nabava',
  service: 'Servis (RMA)',
  expenses: 'Troškovi',
  partners: 'Partneri',
  reports: 'Izvještaji',
  settings: 'Postavke i šifrarnici',
  users: 'Korisnici',
} as const;

export type Module = keyof typeof MODULES;

const RANK: Record<Level, number> = { none: 0, view: 1, ops: 2, edit: 3 };

export const ROLE_LABEL: Record<RoleCode, string> = {
  ADMIN: 'Administrator',
  MANAGER: 'Voditelj',
  SALES: 'Prodaja',
  WAREHOUSE: 'Skladište',
  ACCOUNTANT: 'Knjigovodstvo',
};

const all = (level: Level) => Object.fromEntries(Object.keys(MODULES).map((m) => [m, level])) as Record<Module, Level>;

export const ROLE_DEFAULTS: Record<RoleCode, Record<Module, Level>> = {
  ADMIN: all('edit'),
  MANAGER: { ...all('edit'), users: 'none' },
  SALES: {
    ...all('none'),
    dashboard: 'view',
    warehouse: 'view',
    sales: 'edit',
    rentals: 'edit',
    service: 'edit',
    partners: 'edit',
    reports: 'view',
  },
  WAREHOUSE: {
    ...all('none'),
    dashboard: 'view',
    warehouse: 'ops',
    sales: 'view',
    service: 'edit',
    partners: 'view',
  },
  ACCOUNTANT: {
    ...all('view'),
    warehouse: 'view',
    expenses: 'edit',
    purchasing: 'edit',
    users: 'none',
    settings: 'none',
  },
};

export type PermissionMap = Record<Module, Level>;

export function resolvePermissions(role: RoleCode, overrides: Partial<Record<string, Level>> | null | undefined): PermissionMap {
  const base = { ...ROLE_DEFAULTS[role] };
  if (role === 'ADMIN') return base;
  for (const [k, v] of Object.entries(overrides ?? {})) {
    if (k in base && v && v in RANK) base[k as Module] = v;
  }
  return base;
}

export function can(perms: PermissionMap, module: Module, level: Exclude<Level, 'none'> = 'view'): boolean {
  return RANK[perms[module] ?? 'none'] >= RANK[level];
}

export const LEVEL_LABEL: Record<Level, string> = {
  none: 'Bez pristupa',
  view: 'Pregled',
  ops: 'Operativno',
  edit: 'Puni pristup',
};
