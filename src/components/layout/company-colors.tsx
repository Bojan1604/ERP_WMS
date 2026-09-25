import { companyColorsCss, type CompanyColors } from '@/domain/brand-colors';

/**
 * CSS varijable boja firme (naglasak, izbornik) za svijetlu i tamnu temu.
 * Zadane boje → ništa (vrijedi globals.css). CSS sadrži samo #rrggbb vrijednosti.
 */
export function CompanyColorsStyle({ colors }: { colors: CompanyColors }) {
  const css = companyColorsCss(colors);
  return css ? <style data-company-colors dangerouslySetInnerHTML={{ __html: css }} /> : null;
}
