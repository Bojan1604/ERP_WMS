/**
 * Prava pristupa po modulu i razini. Razine rastu: none < view < ops < edit.
 * „ops" (operativno) u skladištu daje pregled, označavanje i izlaz iz
 * skladišta, bez uređivanja i brisanja; promjena statusa ide na odobrenje.
 * Iznimka zadana na korisniku ima prednost pred ulogom.
 */
export type RoleCode = 'ADMIN' | 'MANAGER' | 'SALES' | 'WAREHOUSE' | 'ACCOUNTANT' | 'DISTRIBUTOR' | 'CLIENT';
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
  mdm: 'MDM — upravljanje uređajima',
} as const;

export type Module = keyof typeof MODULES;

const RANK: Record<Level, number> = { none: 0, view: 1, ops: 2, edit: 3 };

export const ROLE_LABEL: Record<RoleCode, string> = {
  ADMIN: 'Administrator',
  MANAGER: 'Voditelj',
  SALES: 'Prodaja',
  WAREHOUSE: 'Skladište',
  ACCOUNTANT: 'Knjigovodstvo',
  DISTRIBUTOR: 'Distributer (MDM)',
  CLIENT: 'Klijent (MDM)',
};

/** Vanjski korisnici — vide samo MDM svoje organizacije, nikad ERP. */
export const EXTERNAL_ROLES: RoleCode[] = ['DISTRIBUTOR', 'CLIENT'];
export const isExternalRole = (r: RoleCode) => EXTERNAL_ROLES.includes(r);

const all = (level: Level) => Object.fromEntries(Object.keys(MODULES).map((m) => [m, level])) as Record<Module, Level>;

export const ROLE_DEFAULTS: Record<RoleCode, Record<Module, Level>> = {
  ADMIN: all('edit'),
  MANAGER: { ...all('edit'), users: 'none' },
  SALES: {
    ...all('none'),
    mdm: 'view',
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
    mdm: 'view',
  },
  ACCOUNTANT: {
    ...all('view'),
    warehouse: 'view',
    expenses: 'edit',
    purchasing: 'edit',
    users: 'none',
    settings: 'none',
    mdm: 'none',
  },
  // distributer upravlja uređajima svojih klijenata; klijent ih vidi i radi osnovne radnje
  DISTRIBUTOR: { ...all('none'), mdm: 'edit' },
  CLIENT: { ...all('none'), mdm: 'ops' },
};

export type PermissionMap = Record<Module, Level>;

export function resolvePermissions(role: RoleCode, overrides: Partial<Record<string, Level>> | null | undefined): PermissionMap {
  const base = { ...ROLE_DEFAULTS[role] };
  if (role === 'ADMIN') return base;
  // vanjskim korisnicima iznimke ne mogu otvoriti ERP module
  if (isExternalRole(role)) {
    const mdm = overrides?.mdm;
    if (mdm && mdm in RANK) base.mdm = mdm;
    return base;
  }
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
