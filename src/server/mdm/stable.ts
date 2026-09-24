/** JSON s ključevima objekata poredanima abecedno — usporedba neovisna o redoslijedu ključeva (jsonb ga ne čuva). */
export const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** Jednake JSON vrijednosti bez obzira na redoslijed ključeva (undefined = null). */
export const sameJson = (a: unknown, b: unknown) => stable(a ?? null) === stable(b ?? null);
