import { can, EXTERNAL_ROLES, type Level, type Module, type PermissionMap, type RoleCode } from '@/domain/permissions';

/**
 * Moduli čiji ekrani stvarno biraju partnera (PartnerCombobox / PartnerFilter) i najniža
 * razina na kojoj je odabir dostupan: filtri popisa → view; MDM ga ima samo u obrascu
 * organizacije (uređivanje) → edit. „costs" je tu jer stranica Marže (costs:view) ima filtar
 * kupaca; servis nema odabir partnera.
 */
export const PARTNER_SEARCH_MODULES: readonly [Module, Exclude<Level, 'none'>][] = [
  ['partners', 'view'], ['sales', 'view'], ['rentals', 'view'], ['purchasing', 'view'], ['expenses', 'view'],
  ['warehouse', 'view'], ['reports', 'view'], ['costs', 'view'], ['mdm', 'edit'],
];

/** Smije li korisnik pretraživati partnere (padajući odabiri). Vanjski (MDM) korisnici nikad. */
export const canSearchPartners = (u: { role: RoleCode; perms: PermissionMap }) =>
  !EXTERNAL_ROLES.includes(u.role) && PARTNER_SEARCH_MODULES.some(([m, level]) => can(u.perms, m, level));
