/**
 * HUB-3 2D barkod za plaćanje (PDF417). Sadržaj je 14 redaka odvojenih LF-om;
 * prazno polje je prazan redak, redci se ne smiju izostaviti.
 */
const cut = (s: unknown, n: number) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

export interface Hub3Input {
  amount: number;
  currency?: string;
  payer: { name?: string; address?: string; zip?: string; city?: string };
  payee: { name?: string; address?: string; zip?: string; city?: string };
  iban: string;
  model?: string;
  reference?: string;
  purpose?: string;
  description?: string;
}

export function hub3Text(i: Hub3Input): string {
  return [
    'HRVHUB30',
    cut(i.currency || 'EUR', 3),
    String(Math.round(Math.abs(i.amount) * 100)).padStart(15, '0'),
    cut(i.payer.name, 30),
    cut(i.payer.address, 27),
    cut([i.payer.zip, i.payer.city].filter(Boolean).join(' '), 27),
    cut(i.payee.name, 25),
    cut(i.payee.address, 25),
    cut([i.payee.zip, i.payee.city].filter(Boolean).join(' '), 27),
    cut(String(i.iban || '').replace(/\s+/g, ''), 21),
    cut(i.model || 'HR00', 4),
    cut(i.reference, 22),
    cut(i.purpose || 'OTHR', 4),
    cut(i.description, 35),
  ].join('\n');
}
