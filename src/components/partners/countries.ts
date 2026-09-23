/** Najčešće države (ISO 3166-1 alfa-2) — susjedstvo i EU prvo. */
export const COUNTRIES: Array<{ value: string; label: string }> = [
  ['HR', 'Hrvatska'], ['SI', 'Slovenija'], ['BA', 'Bosna i Hercegovina'], ['RS', 'Srbija'], ['ME', 'Crna Gora'],
  ['MK', 'Sjeverna Makedonija'], ['AT', 'Austrija'], ['DE', 'Njemačka'], ['IT', 'Italija'], ['HU', 'Mađarska'],
  ['CZ', 'Češka'], ['SK', 'Slovačka'], ['PL', 'Poljska'], ['FR', 'Francuska'], ['NL', 'Nizozemska'],
  ['BE', 'Belgija'], ['LU', 'Luksemburg'], ['ES', 'Španjolska'], ['PT', 'Portugal'], ['IE', 'Irska'],
  ['DK', 'Danska'], ['SE', 'Švedska'], ['FI', 'Finska'], ['EE', 'Estonija'], ['LV', 'Latvija'],
  ['LT', 'Litva'], ['RO', 'Rumunjska'], ['BG', 'Bugarska'], ['GR', 'Grčka'], ['CY', 'Cipar'], ['MT', 'Malta'],
  ['CH', 'Švicarska'], ['NO', 'Norveška'], ['GB', 'Ujedinjeno Kraljevstvo'], ['AL', 'Albanija'], ['XK', 'Kosovo'],
  ['TR', 'Turska'], ['UA', 'Ukrajina'], ['US', 'Sjedinjene Američke Države'], ['CN', 'Kina'],
].map(([value, label]) => ({ value, label: `${label} (${value})` }));

export const countryName = (code: string | null | undefined) =>
  COUNTRIES.find((c) => c.value === code)?.label.replace(/ \(..\)$/, '') ?? code ?? '';
