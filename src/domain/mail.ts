/**
 * E-pošta: predlošci naslova i teksta po vrsti poruke, zamjena varijabli i
 * mailto poveznica (kad SMTP nije podešen). Čisto — koriste ga poslužitelj
 * (server/mail), postavke (/postavke/posta) i dijalog slanja.
 */

import { r2 } from './money';

export const MAIL_TEMPLATE_KINDS = ['invoice', 'invoicePaid', 'advance', 'creditNote', 'storno', 'quote', 'proforma', 'delivery', 'service', 'accountant', 'reminder'] as const;
export type MailTemplateKind = (typeof MAIL_TEMPLATE_KINDS)[number];

export interface MailTemplate {
  subject: string;
  body: string;
}
export type MailTemplates = Record<MailTemplateKind, MailTemplate>;

export const MAIL_TEMPLATE_LABEL: Record<MailTemplateKind, string> = {
  invoice: 'Račun',
  invoicePaid: 'Plaćeni račun',
  advance: 'Račun za predujam',
  creditNote: 'Odobrenje',
  storno: 'Storno računa',
  quote: 'Ponuda',
  proforma: 'Predračun',
  delivery: 'Otpremnica',
  service: 'Servisni nalog',
  accountant: 'Knjigovođa (ZIP)',
  reminder: 'Opomena',
};

/** Varijable koje predložak smije koristiti (po vrsti) — za pomoć u postavkama. */
export const MAIL_VARIABLES: Record<MailTemplateKind, string[]> = {
  invoice: ['broj', 'kupac', 'iznos', 'datum', 'dospijece', 'firma'],
  invoicePaid: ['broj', 'kupac', 'iznos', 'datum', 'firma'],
  advance: ['broj', 'kupac', 'iznos', 'datum', 'firma'],
  creditNote: ['broj', 'kupac', 'iznos', 'datum', 'veza', 'firma'],
  storno: ['broj', 'kupac', 'iznos', 'datum', 'veza', 'firma'],
  quote: ['broj', 'kupac', 'iznos', 'datum', 'vrijedi', 'firma'],
  proforma: ['broj', 'kupac', 'iznos', 'datum', 'vrijedi', 'naslov', 'firma'],
  delivery: ['broj', 'kupac', 'datum', 'firma'],
  service: ['broj', 'kupac', 'status', 'datum', 'firma'],
  accountant: ['od', 'do', 'broj', 'popis', 'firma'],
  reminder: ['broj', 'kupac', 'iznos', 'datum', 'dospijece', 'firma'],
};

/** Zadani tekstovi (Postavke → E-pošta ih mijenja; prazno polje = zadano). */
export const MAIL_DEFAULTS: MailTemplates = {
  invoice: {
    subject: 'Račun {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo račun {broj} od {datum}, s rokom plaćanja {dospijece}.\nIznos za platiti: {iznos}.\n\nLijep pozdrav,\n{firma}',
  },
  invoicePaid: {
    subject: 'Račun {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo račun {broj} od {datum} na iznos {iznos}.\nRačun je plaćen — hvala na uplati.\n\nLijep pozdrav,\n{firma}',
  },
  advance: {
    subject: 'Račun za predujam {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo račun za predujam {broj} od {datum} na iznos {iznos}.\nPredujam će biti uračunat u konačni račun.\n\nLijep pozdrav,\n{firma}',
  },
  creditNote: {
    subject: 'Knjižno odobrenje {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo knjižno odobrenje {broj} od {datum} uz račun {veza}.\nIznos odobrenja: {iznos}.\n\nLijep pozdrav,\n{firma}',
  },
  storno: {
    subject: 'Storno računa {veza}',
    body: 'Poštovani,\n\nu prilogu šaljemo storno {broj} od {datum} kojim se poništava račun {veza}.\nIznos storna: {iznos}.\n\nLijep pozdrav,\n{firma}',
  },
  quote: {
    subject: 'Ponuda {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo ponudu {broj} od {datum}, koja vrijedi do {vrijedi}.\nUkupan iznos: {iznos}.\n\nStojimo na raspolaganju za sva pitanja.\n\nLijep pozdrav,\n{firma}',
  },
  proforma: {
    subject: '{naslov} {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo {naslov} {broj} od {datum} na iznos {iznos}.\nPodaci za plaćanje nalaze se na dokumentu; račun izdajemo po uplati.\n\nLijep pozdrav,\n{firma}',
  },
  delivery: {
    subject: 'Otpremnica uz račun {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo otpremnicu uz račun {broj} od {datum}.\n\nLijep pozdrav,\n{firma}',
  },
  service: {
    subject: 'Servisni nalog {broj}',
    body: 'Poštovani,\n\nu prilogu šaljemo servisni nalog {broj} (stanje: {status}).\n\nLijep pozdrav,\n{firma}',
  },
  accountant: {
    subject: 'Računi {od} – {do} · {firma}',
    body: 'Poštovani,\n\nu prilogu je ZIP s računima za razdoblje {od} – {do} ({broj} dokumenata):\n{popis}\n\nLijep pozdrav,\n{firma}',
  },
  reminder: {
    subject: 'Opomena — račun {broj}',
    body: 'Poštovani,\n\nprema našoj evidenciji račun {broj} od {datum}, s dospijećem {dospijece}, još nije plaćen.\nOtvoreni iznos: {iznos}.\n\nMolimo uplatu ili javite ako je račun već plaćen.\n\nLijep pozdrav,\n{firma}',
  },
};

/**
 * Predložak i iznos za slanje izdanog računa prema vrsti i stanju: odobrenje i storno
 * imaju svoje predloške (iznos bez predznaka), račun za predujam svoj, plaćeni račun
 * zahvaljuje na uplati, a otvoreni račun navodi otvoreni iznos (ne ukupni).
 */
export function invoiceMailTemplate(inv: {
  kind: 'INVOICE' | 'ADVANCE' | 'STORNO' | 'CREDIT_NOTE';
  stornoed: boolean;
  total: number;
  advance: number;
  open: number;
}): { template: MailTemplateKind; amount: number } {
  if (inv.kind === 'CREDIT_NOTE') return { template: 'creditNote', amount: Math.abs(inv.total) };
  if (inv.kind === 'STORNO') return { template: 'storno', amount: Math.abs(inv.total) };
  if (inv.kind === 'ADVANCE') return { template: 'advance', amount: inv.total };
  if (inv.open > 0.005 || inv.stornoed) return { template: 'invoice', amount: inv.open };
  // otvoreno 0: plaćen (ili podmiren predujmom/odobrenjem) — iznos računa umanjen za predujam
  return { template: 'invoicePaid', amount: Math.max(0, r2(inv.total - inv.advance)) };
}

/** Spremljeni predlošci (JSON iz Company.mailTemplates) + zadani za ono što nedostaje ili je prazno. */
export function readTemplates(stored: unknown): MailTemplates {
  const src = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const out = {} as MailTemplates;
  for (const k of MAIL_TEMPLATE_KINDS) {
    const t = src[k] && typeof src[k] === 'object' ? (src[k] as Partial<MailTemplate>) : {};
    out[k] = {
      subject: typeof t.subject === 'string' && t.subject.trim() ? t.subject : MAIL_DEFAULTS[k].subject,
      body: typeof t.body === 'string' && t.body.trim() ? t.body : MAIL_DEFAULTS[k].body,
    };
  }
  return out;
}

/** Zamjena {varijabli}; nepoznate ostaju prazne. „{rok}" je sinonim za „{dospijece}". */
export function fillTemplate(tpl: string, vars: Record<string, string | number | null | undefined>): string {
  const src = String(tpl ?? '');
  return src.replace(/\{(\w+)\}/g, (m: string, k: string, at: number) => {
    const v = vars[k] ?? (k === 'rok' ? vars.dospijece : k === 'dospijeće' ? vars.dospijece : undefined);
    const out = v === null || v === undefined ? '' : String(v);
    // datum „25.09.2026." ispred točke u predlošku („…{dospijece}.") — bez dvostruke točke
    return out.endsWith('.') && src[at + m.length] === '.' ? out.slice(0, -1) : out;
  });
}

/** Adrese odvojene zarezom/točka-zarezom → očišćen popis. */
export const splitAddresses = (v: string | null | undefined) =>
  String(v ?? '')
    .split(/[,;]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** mailto: poveznica (bez privitka — preglednik ga ne može dodati sam). */
export function mailtoHref(p: { to: string; cc?: string | null; subject: string; body: string }): string {
  const q: string[] = [];
  if (p.cc?.trim()) q.push(`cc=${encodeURIComponent(splitAddresses(p.cc).join(','))}`);
  q.push(`subject=${encodeURIComponent(p.subject)}`);
  // mailto tijelo: CRLF po RFC 6068
  q.push(`body=${encodeURIComponent(p.body.replace(/\r?\n/g, '\r\n'))}`);
  return `mailto:${splitAddresses(p.to).map((a) => encodeURIComponent(a).replace(/%40/g, '@')).join(',')}?${q.join('&')}`;
}
