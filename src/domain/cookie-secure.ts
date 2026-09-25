/**
 * Treba li kolačić prijave imati oznaku Secure. Preglednik ne sprema Secure kolačić
 * preko običnog http-a (osim na localhostu) — npr. mobitel na http://192.168.x.x:3000
 * bi se nakon svakog klika vratio na prijavu. Zato Secure samo kad je veza stvarno HTTPS
 * (Next i Caddy postavljaju X-Forwarded-Proto). COOKIE_SECURE=true|false nadjačava.
 */
export function cookieSecure(override: string | undefined, forwardedProto: string | null | undefined): boolean {
  if (override === 'true') return true;
  if (override === 'false') return false;
  return (forwardedProto ?? '').split(',')[0].trim().toLowerCase() === 'https';
}
