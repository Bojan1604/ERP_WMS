import 'server-only';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { CIS_URL, cisAmount, cisDateTime, type PaymentMethodCode, CIS_PAYMENT_CODE } from '@/domain/fiscal';
import { xmlEscape as esc } from '@/domain/ubl';
import type { ParsedCert } from './cert';

/**
 * CIS (Fiskalizacija 1.0): RacunZahtjev potpisan XML-DSig-om (enveloped,
 * exclusive c14n, algoritam: CIS_SIGNATURE), u SOAP omotnici, HTTPS POST na CIS. TLS je
 * običan (poslužiteljski certifikat CIS-a izdaje FINA); klijent se dokazuje
 * potpisom poruke. Ako Node ne vjeruje FINA-inom lancu, postavite
 * FISCAL_CA_FILE (PEM) ili NODE_EXTRA_CA_CERTS.
 */

export const NS = 'http://www.apis-it.hr/fin/2012/types/f73';

export type FiscalSignature = 'sha1' | 'sha256';

const SIGNATURE_ALGORITHMS: Record<FiscalSignature, { signature: string; digest: string }> = {
  sha1: { signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1', digest: 'http://www.w3.org/2000/09/xmldsig#sha1' },
  sha256: { signature: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', digest: 'http://www.w3.org/2001/04/xmlenc#sha256' },
};

/**
 * Algoritam XML potpisa poruke za CIS — jedino mjesto gdje se bira.
 * Primjeri u Tehničkoj specifikaciji Fiskalizacije 1.x koriste RSA-SHA1 /
 * SHA1 (potpis i sažetak); iz koda i stare verzije ne može se utvrditi
 * zahtijeva li trenutno objavljena verzija SHA1 ili prihvaća i SHA-256, pa
 * zadano ostaje SHA-256, a `FISCAL_SIGNATURE=sha1` prebacuje na SHA1.
 * Prije produkcije provjeriti na cistest.apis-it.hr („Testiraj vezu" + izdati
 * probni račun): greška s004 „Neispravan digitalni potpis" znači pogrešan izbor.
 * (ZKI je neovisan o ovome — uvijek RSA-SHA1 + MD5, vidi zki.ts.)
 */
export const CIS_SIGNATURE: FiscalSignature = process.env.FISCAL_SIGNATURE?.trim().toLowerCase() === 'sha1' ? 'sha1' : 'sha256';

export interface RacunData {
  oib: string;
  vatRegistered: boolean;
  issuedAt: Date;
  /** P = redni broj na razini prostora, N = na razini uređaja. */
  seqMode: 'P' | 'N';
  seq: number;
  premises: string;
  device: string;
  taxCategory: string;
  vatRate: number;
  net: number;
  vat: number;
  charges: number;
  total: number;
  paymentMethod: PaymentMethodCode;
  operatorOib: string;
  zki: string;
  lateDelivery: boolean;
  /** Vrijeme slanja poruke (zaglavlje). */
  sentAt?: Date;
  messageId?: string;
}

/** Nepotpisani RacunZahtjev. */
export function buildRacunZahtjev(r: RacunData): string {
  const tag = (n: string, v: string) => `<tns:${n}>${esc(v)}</tns:${n}>`;
  let tax = '';
  if (r.vatRegistered && r.taxCategory === 'S') {
    tax = `<tns:Pdv><tns:Porez>${tag('Stopa', cisAmount(r.vatRate))}${tag('Osnovica', cisAmount(r.net))}${tag('Iznos', cisAmount(r.vat))}</tns:Porez></tns:Pdv>`;
  } else if (['E', 'Z', 'K', 'G'].includes(r.taxCategory)) {
    tax = tag('IznosOslobPdv', cisAmount(r.net));
  } else if (r.net !== 0) {
    // izvan sustava PDV-a, prijenos porezne obveze
    tax = tag('IznosNePodlOpor', cisAmount(r.net));
  }
  const naknade = r.charges ? `<tns:Naknade><tns:Naknada>${tag('NazivN', 'Naknade')}${tag('IznosN', cisAmount(r.charges))}</tns:Naknada></tns:Naknade>` : '';
  return (
    `<tns:RacunZahtjev xmlns:tns="${NS}" Id="RacunZahtjev">` +
    `<tns:Zaglavlje>${tag('IdPoruke', r.messageId ?? randomUUID())}${tag('DatumVrijeme', cisDateTime(r.sentAt ?? new Date()))}</tns:Zaglavlje>` +
    `<tns:Racun>` +
    tag('Oib', r.oib) +
    tag('USustPdv', r.vatRegistered ? 'true' : 'false') +
    tag('DatVrijeme', cisDateTime(r.issuedAt)) +
    tag('OznSlijed', r.seqMode) +
    `<tns:BrRac>${tag('BrOznRac', String(r.seq))}${tag('OznPosPr', r.premises)}${tag('OznNapUr', r.device)}</tns:BrRac>` +
    tax +
    naknade +
    tag('IznosUkupno', cisAmount(r.total)) +
    tag('NacinPlac', CIS_PAYMENT_CODE[r.paymentMethod]) +
    tag('OibOper', r.operatorOib) +
    tag('ZastKod', r.zki) +
    tag('NakDost', r.lateDelivery ? 'true' : 'false') +
    `</tns:Racun></tns:RacunZahtjev>`
  );
}

/** Echo poruka za provjeru veze. */
export const buildEcho = (text = 'Provjera veze') => `<tns:EchoRequest xmlns:tns="${NS}">${esc(text)}</tns:EchoRequest>`;

/** XML-DSig potpis korijenskog elementa (Id) — Signature ide kao zadnje dijete. */
export function signXml(
  xml: string,
  cert: Pick<ParsedCert, 'privateKeyPem' | 'certPem' | 'certBase64' | 'issuerName' | 'serialDecimal'>,
  algorithm: FiscalSignature = CIS_SIGNATURE,
): string {
  const alg = SIGNATURE_ALGORITHMS[algorithm];
  const sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certPem,
    signatureAlgorithm: alg.signature,
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${cert.certBase64}</X509Certificate>` +
      `<X509IssuerSerial><X509IssuerName>${esc(cert.issuerName)}</X509IssuerName><X509SerialNumber>${cert.serialDecimal}</X509SerialNumber></X509IssuerSerial></X509Data>`,
  });
  sig.addReference({
    xpath: '/*',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: alg.digest,
  });
  sig.computeSignature(xml, { location: { reference: '/*', action: 'append' } });
  return sig.getSignedXml();
}

export const soapEnvelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

let ca: Buffer | undefined | null = null;
function extraCa() {
  if (ca === null) {
    const f = process.env.FISCAL_CA_FILE;
    ca = f ? readFileSync(f) : undefined;
  }
  return ca;
}

/** HTTPS POST SOAP poruke na CIS s vremenskim ograničenjem; vraća tijelo odgovora (i kod greške 500 — SOAP Fault). */
export function postToCis(env: 'TEST' | 'PROD', envelope: string, op: 'racuni' | 'echo' = 'racuni', timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  const url = new URL(CIS_URL[env]);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `http://e-porezna.porezna-uprava.hr/fiskalizacija/2012/services/FiskalizacijaService/${op}`, 'Content-Length': Buffer.byteLength(envelope) },
        ...(extraCa() ? { ca: extraCa() } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`CIS ne odgovara (${timeoutMs / 1000} s)`)));
    req.on('error', reject);
    req.end(envelope);
  });
}

export interface CisResult {
  jir: string | null;
  errors: Array<{ code: string; message: string }>;
  echo?: string | null;
}

/** Čita odgovor CIS-a: JIR ili popis grešaka (Greske/Greska ili SOAP Fault). */
export function parseCisResponse(body: string): CisResult {
  const doc = new DOMParser().parseFromString(body, 'text/xml');
  const byLocal = (name: string) => Array.from(doc.getElementsByTagNameNS('*', name));
  const text = (name: string) => byLocal(name)[0]?.textContent?.trim() ?? null;
  const errors = byLocal('Greska').map((g) => ({
    code: Array.from(g.getElementsByTagNameNS('*', 'SifraGreske'))[0]?.textContent?.trim() ?? '',
    message: Array.from(g.getElementsByTagNameNS('*', 'PorukaGreske'))[0]?.textContent?.trim() ?? '',
  }));
  const fault = text('faultstring');
  if (fault) errors.push({ code: 'SOAP', message: fault });
  return { jir: text('Jir'), errors, echo: text('EchoResponse') };
}
