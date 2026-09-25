import { can, type Module, type PermissionMap } from '@/domain/permissions';

/**
 * Stavke izbornika bez ikona (čisti podaci — smije ih uvesti i poslužitelj, npr. `pageAccess`
 * za početnu stranicu). Ikone po nazivu dodaje `nav.ts`.
 */
export interface NavItemDef {
  href: string;
  label: string;
  icon: NavIconName;
  module: Module;
  level?: 'view' | 'ops' | 'edit';
  /** Samo za ulogu administratora (stranica to i sama provjerava). */
  adminOnly?: boolean;
  /** Administrator ili korisnik s pravom na opasnu zonu (User.canDanger). */
  dangerOnly?: boolean;
}

export interface NavGroupDef {
  label: string;
  items: NavItemDef[];
}

export type NavIconName = 'AppWindow' | 'ArrowLeftRight' | 'BarChart3' | 'BookOpen' | 'Boxes' | 'Building' | 'Building2' | 'Calculator' | 'CalendarClock' | 'ClipboardCheck' | 'ClipboardList' | 'DatabaseBackup' | 'FileSignature' | 'FileText' | 'FolderOpen' | 'HardDrive' | 'History' | 'Inbox' | 'LayoutDashboard' | 'ListTree' | 'Mail' | 'MonitorSmartphone' | 'Network' | 'PackageCheck' | 'PackagePlus' | 'QrCode' | 'Receipt' | 'ScanLine' | 'ShieldCheck' | 'SlidersHorizontal' | 'Smartphone' | 'Stamp' | 'Table2' | 'TrendingUp' | 'Truck' | 'UserCog' | 'Users' | 'Wallet' | 'Wrench';

/** Izbornik; stavke bez prava se ne prikazuju. */
export const NAV_ITEMS: NavGroupDef[] = [
  {
    label: '',
    items: [{ href: '/', label: 'Nadzorna ploča', icon: 'LayoutDashboard', module: 'dashboard' }],
  },
  {
    label: 'Skladište',
    items: [
      { href: '/skladiste', label: 'Uređaji', icon: 'Boxes', module: 'warehouse' },
      { href: '/skladiste/skeniranje', label: 'Skeniranje', icon: 'ScanLine', module: 'warehouse' },
      { href: '/skladiste/zaprimanje', label: 'Zaprimanje', icon: 'PackagePlus', module: 'warehouse', level: 'edit' },
      { href: '/skladiste/izlaz', label: 'Izlaz i povrat', icon: 'ArrowLeftRight', module: 'warehouse' },
      { href: '/skladiste/medjuskladisnice', label: 'Međuskladišnice', icon: 'Truck', module: 'warehouse' },
      { href: '/skladiste/inventura', label: 'Inventura', icon: 'ClipboardCheck', module: 'warehouse' },
      { href: '/skladiste/odobrenja', label: 'Odobrenja', icon: 'ShieldCheck', module: 'warehouse' },
    ],
  },
  {
    label: 'Prodaja',
    items: [
      { href: '/prodaja/racuni', label: 'Računi', icon: 'Receipt', module: 'sales' },
      { href: '/prodaja/ponude', label: 'Ponude', icon: 'FileText', module: 'sales' },
      { href: '/prodaja/marze', label: 'Marže i profit', icon: 'TrendingUp', module: 'costs' },
    ],
  },
  {
    label: 'Najam',
    items: [
      { href: '/najam/ugovori', label: 'Ugovori', icon: 'FileSignature', module: 'rentals' },
      { href: '/najam/rate', label: 'Rate za izdati', icon: 'CalendarClock', module: 'rentals' },
      { href: '/najam/pregled', label: 'Pregled najma', icon: 'Table2', module: 'rentals' },
    ],
  },
  {
    label: 'Nabava',
    items: [
      { href: '/nabava/narudzbenice', label: 'Narudžbenice', icon: 'ClipboardList', module: 'purchasing' },
      { href: '/nabava/primke', label: 'Primke', icon: 'PackageCheck', module: 'purchasing' },
      { href: '/nabava/ulazni', label: 'Ulazni računi', icon: 'Inbox', module: 'purchasing' },
    ],
  },
  {
    label: 'Poslovanje',
    items: [
      { href: '/servis', label: 'Servis (RMA)', icon: 'Wrench', module: 'service' },
      { href: '/troskovi', label: 'Troškovi', icon: 'Wallet', module: 'expenses' },
      { href: '/partneri', label: 'Partneri', icon: 'Users', module: 'partners' },
      { href: '/izvjestaji', label: 'Izvještaji', icon: 'BarChart3', module: 'reports' },
      { href: '/knjigovodja', label: 'Knjigovođa', icon: 'Calculator', module: 'reports' },
    ],
  },
  {
    label: 'MDM',
    items: [
      { href: '/mdm', label: 'Pregled uređaja', icon: 'MonitorSmartphone', module: 'mdm' },
      { href: '/mdm/uredaji', label: 'Uređaji', icon: 'Smartphone', module: 'mdm' },
      { href: '/mdm/upis', label: 'Upis uređaja', icon: 'QrCode', module: 'mdm', level: 'edit' },
      { href: '/mdm/profili', label: 'Konfiguracije', icon: 'SlidersHorizontal', module: 'mdm' },
      { href: '/mdm/aplikacije', label: 'Aplikacije', icon: 'AppWindow', module: 'mdm' },
      { href: '/mdm/datoteke', label: 'Datoteke', icon: 'FolderOpen', module: 'mdm' },
      { href: '/mdm/organizacije', label: 'Distributeri i klijenti', icon: 'Network', module: 'mdm', level: 'edit' },
      { href: '/mdm/dokumenti', label: 'Dokumenti i mreža', icon: 'BookOpen', module: 'mdm' },
    ],
  },
  {
    label: 'Sustav',
    items: [
      { href: '/postavke', label: 'Firma', icon: 'Building2', module: 'settings' },
      { href: '/postavke/sifrarnici', label: 'Šifrarnici', icon: 'ListTree', module: 'settings' },
      { href: '/postavke/fiskalizacija', label: 'Fiskalizacija', icon: 'Stamp', module: 'settings' },
      { href: '/postavke/posta', label: 'E-pošta', icon: 'Mail', module: 'settings' },
      { href: '/postavke/uvoz', label: 'Uvoz i izvoz', icon: 'DatabaseBackup', module: 'settings', level: 'edit', adminOnly: true },
      { href: '/postavke/podaci', label: 'Podaci i kopije', icon: 'HardDrive', module: 'settings', dangerOnly: true },
      { href: '/postavke/firme', label: 'Firme', icon: 'Building', module: 'settings', adminOnly: true },
      { href: '/postavke/korisnici', label: 'Korisnici', icon: 'UserCog', module: 'users' },
      { href: '/postavke/dnevnik', label: 'Dnevnik promjena', icon: 'History', module: 'log' },
    ],
  },
];

export interface NavViewer {
  perms: PermissionMap;
  isAdmin: boolean;
  canDanger: boolean;
}

/** Je li stavka izbornika dostupna korisniku (isti uvjet kao u bočnom izborniku). */
export const navItemVisible = (i: Pick<NavItemDef, 'module' | 'level' | 'adminOnly' | 'dangerOnly'>, u: NavViewer) =>
  can(u.perms, i.module, i.level ?? 'view') && (!i.adminOnly || u.isAdmin) && (!i.dangerOnly || u.isAdmin || u.canDanger);

/**
 * Početna stranica korisnika: prva dopuštena stavka izbornika (redoslijedom izbornika).
 * Tko nema nijednu, dobiva „Moj račun" (tamo su odjava, lozinka i 2FA).
 */
export function homeHref(u: NavViewer): string {
  for (const g of NAV_ITEMS) for (const i of g.items) if (navItemVisible(i, u)) return i.href;
  return '/postavke/moj-racun';
}
