import {
  AppWindow, ArrowLeftRight, BarChart3, BookOpen, Boxes, Building, Building2, Calculator, CalendarClock, ClipboardCheck, ClipboardList, DatabaseBackup, FileSignature, FileText, FolderOpen, HardDrive, History, Inbox, LayoutDashboard, ListTree, Mail, MonitorSmartphone, Network, PackageCheck, PackagePlus, QrCode, Receipt, ScanLine, ShieldCheck, SlidersHorizontal, Smartphone, Stamp, Table2, TrendingUp, Truck, UserCog, Users, Wallet, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { NAV_ITEMS, type NavIconName, type NavItemDef } from './nav-items';

export { homeHref, navItemVisible } from './nav-items';

const ICONS: Record<NavIconName, LucideIcon> = { AppWindow, ArrowLeftRight, BarChart3, BookOpen, Boxes, Building, Building2, Calculator, CalendarClock, ClipboardCheck, ClipboardList, DatabaseBackup, FileSignature, FileText, FolderOpen, HardDrive, History, Inbox, LayoutDashboard, ListTree, Mail, MonitorSmartphone, Network, PackageCheck, PackagePlus, QrCode, Receipt, ScanLine, ShieldCheck, SlidersHorizontal, Smartphone, Stamp, Table2, TrendingUp, Truck, UserCog, Users, Wallet, Wrench };

export interface NavItem extends Omit<NavItemDef, 'icon'> {
  icon: LucideIcon;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Izbornik s ikonama (stavke u `nav-items.ts`). Ikone se uvoze pojedinačno (ne cijela biblioteka). */
export const NAV: NavGroup[] = NAV_ITEMS.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, icon: ICONS[i.icon] })) }));
