import type { Module } from '@/domain/permissions';

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  module: Module;
  level?: 'view' | 'ops' | 'edit';
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Izbornik; stavke bez prava se ne prikazuju. Ikone su imena iz lucide-react. */
export const NAV: NavGroup[] = [
  {
    label: '',
    items: [{ href: '/', label: 'Nadzorna ploča', icon: 'LayoutDashboard', module: 'dashboard' }],
  },
  {
    label: 'Skladište',
    items: [
      { href: '/skladiste', label: 'Uređaji', icon: 'Boxes', module: 'warehouse' },
      { href: '/skladiste/zaprimanje', label: 'Zaprimanje', icon: 'PackagePlus', module: 'warehouse', level: 'edit' },
      { href: '/skladiste/izlaz', label: 'Izlaz i povrat', icon: 'ArrowLeftRight', module: 'warehouse' },
      { href: '/skladiste/medjuskladisnice', label: 'Međuskladišnice', icon: 'Truck', module: 'warehouse' },
      { href: '/skladiste/odobrenja', label: 'Odobrenja', icon: 'ShieldCheck', module: 'warehouse' },
    ],
  },
  {
    label: 'Prodaja',
    items: [
      { href: '/prodaja/racuni', label: 'Računi', icon: 'Receipt', module: 'sales' },
      { href: '/prodaja/ponude', label: 'Ponude', icon: 'FileText', module: 'sales' },
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
    ],
  },
  {
    label: 'Sustav',
    items: [
      { href: '/postavke', label: 'Firma', icon: 'Building2', module: 'settings' },
      { href: '/postavke/sifrarnici', label: 'Šifrarnici', icon: 'ListTree', module: 'settings' },
      { href: '/postavke/korisnici', label: 'Korisnici', icon: 'UserCog', module: 'users' },
      { href: '/postavke/dnevnik', label: 'Dnevnik promjena', icon: 'History', module: 'settings' },
    ],
  },
];
