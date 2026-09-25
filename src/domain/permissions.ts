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
  /** Vidi nabavne cijene, maržu i profit (ekrani, izvozi, izvještaji). Samo razina „view". */
  costs: 'Nabavne cijene i marže',
  /** Dnevnik promjena (/postavke/dnevnik). Samo razina „view". */
  log: 'Dnevnik promjena',
} as const;
// Napomena: zasebno pravo za ugovore nije uvedeno — ugovori ostaju pod „rentals" (najam i ugovori).

export type Module = keyof typeof MODULES;

const RANK: Record<Level, number> = { none: 0, view: 1, ops: 2, edit: 3 };

/** Razine koje modul razlikuje (ostali: sve četiri). Viša razina od dopuštene svodi se na najvišu dopuštenu. */
export const MODULE_LEVELS: Partial<Record<Module, readonly Level[]>> = {
  costs: ['none', 'view'],
  log: ['none', 'view'],
};

export const levelsOf = (m: Module): readonly Level[] => MODULE_LEVELS[m] ?? ['none', 'view', 'ops', 'edit'];

/** Razina svedena na dopuštene za modul (npr. „edit" na costs → „view"). */
function clampLevel(m: Module, l: Level): Level {
  const allowed = levelsOf(m);
  if (allowed.includes(l)) return l;
  return [...allowed].reverse().find((a) => RANK[a] <= RANK[l]) ?? 'none';
}

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

const all = (level: Level) => Object.fromEntries(Object.keys(MODULES).map((m) => [m, clampLevel(m as Module, level)])) as Record<Module, Level>;

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
  // knjigovođa knjiži ulazne račune i troškove, pa vidi i nabavne cijene; dnevnik promjena ne
  ACCOUNTANT: {
    ...all('view'),
    log: 'none',
    warehouse: 'view',
    expenses: 'edit',
    purchasing: 'edit',
    // Knjigovođa: označavanje „poslano knjigovođi" traži izvještaje na razini „ops"
    reports: 'ops',
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
    if (k in base && v && v in RANK) base[k as Module] = clampLevel(k as Module, v);
  }
  return base;
}

/** Smije li korisnik vidjeti nabavne cijene, maržu i profit. Ekrani i izvozi ih bez toga skrivaju. */
export const canSeeCost = (perms: PermissionMap) => can(perms, 'costs', 'view');

/** Smije li korisnik u opasnu zonu (brisanje prometa/podataka): administrator uvijek, ostali uz User.canDanger. */
export const canUseDanger = (u: { role: RoleCode; canDanger?: boolean | null }) => u.role === 'ADMIN' || !!u.canDanger;

export function can(perms: PermissionMap, module: Module, level: Exclude<Level, 'none'> = 'view'): boolean {
  return RANK[perms[module] ?? 'none'] >= RANK[level];
}

export const LEVEL_LABEL: Record<Level, string> = {
  none: 'Bez pristupa',
  view: 'Pregled',
  ops: 'Operativno',
  edit: 'Puni pristup',
};

/**
 * Ide li promjena statusa uređaja na odobrenje (F8). Postavka korisnika ima
 * prednost: true = uvijek na odobrenje (osim administratora), false = nikad;
 * null = pravilo firme — korisnik bez punog prava na skladište ide na odobrenje
 * ako je u firmi uključeno „promjena statusa na odobrenje".
 */
export function needsStatusApproval(
  u: { role: RoleCode; perms: PermissionMap; requireApproval?: boolean | null },
  companyRequiresApproval: boolean,
): boolean {
  if (u.role === 'ADMIN') return false;
  if (u.requireApproval === true) return true;
  if (u.requireApproval === false) return false;
  return !can(u.perms, 'warehouse', 'edit') && companyRequiresApproval;
}
