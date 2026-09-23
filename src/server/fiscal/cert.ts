import 'server-only';
import forge from 'node-forge';
import type { CertSummary } from '@/domain/fiscal';
import { DomainError } from '../errors';
import { decryptSecret } from './crypto';

export interface ParsedCert {
  privateKeyPem: string;
  certPem: string;
  /** Base64 DER certifikata za <X509Certificate>. */
  certBase64: string;
  /** Izdavatelj u obliku RFC 2253 (za <X509IssuerName>). */
  issuerName: string;
  /** Serijski broj decimalno (za <X509SerialNumber>). */
  serialDecimal: string;
  info: CertSummary;
}

type Attr = { shortName?: string; name?: string; type?: string; value: unknown };

const dn = (attrs: Attr[]) =>
  attrs
    .map((a) => `${a.shortName ?? a.name ?? a.type}=${String(a.value)}`)
    .reverse()
    .join(',');

/** OIB iz subjekta: FINA ga stavlja u O („Firma d.o.o. HR12345678901"), serialNumber ili organizationIdentifier („VATHR-…"). */
export function oibFromAttrs(attrs: Attr[]): string | null {
  const values = attrs.map((a) => String(a.value));
  for (const v of values) {
    const m = /(?:^|\D)(?:VATHR-|HR)?(\d{11})(?:\D|$)/.exec(v);
    if (m) return m[1];
  }
  return null;
}

/** Čita .p12 (PKCS#12): privatni ključ i certifikat koji mu odgovara. Baca DomainError s porukom za korisnika. */
export function parseP12(data: Buffer | Uint8Array, password: string): ParsedCert {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(data).toString('binary')));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/mac|password|invalid/i.test(msg)) throw new DomainError('Certifikat se ne može otvoriti — pogrešna lozinka ili datoteka nije .p12.');
    throw new DomainError(`Datoteka nije ispravan .p12 certifikat (${msg}).`);
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new DomainError('U .p12 datoteci nema privatnog ključa.');
  const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  // certifikat koji pripada ključu (datoteka može sadržavati i lanac izdavatelja)
  const cert = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n)) ?? certs[0];
  if (!cert) throw new DomainError('U .p12 datoteci nema certifikata.');

  const subjectAttrs = cert.subject.attributes as Attr[];
  const issuerAttrs = cert.issuer.attributes as Attr[];
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const serialHex = cert.serialNumber.replace(/^0+/, '') || '0';
  return {
    privateKeyPem: forge.pki.privateKeyToPem(key),
    certPem: forge.pki.certificateToPem(cert),
    certBase64: forge.util.encode64(der),
    issuerName: dn(issuerAttrs),
    serialDecimal: BigInt(`0x${serialHex}`).toString(10),
    info: {
      subject: dn(subjectAttrs),
      issuer: dn(issuerAttrs),
      validFrom: cert.validity.notBefore.toISOString(),
      validTo: cert.validity.notAfter.toISOString(),
      oib: oibFromAttrs(subjectAttrs),
      serial: serialHex,
    },
  };
}

// raspakirani certifikati po firmi — PBKDF u .p12 je spor, ne raditi ga za svaki račun
const cache = new Map<string, { stamp: string; cert: ParsedCert }>();

/** Certifikat firme iz baze (ili null ako nije učitan). */
export function companyCert(company: { id: string; fiscalCert: Uint8Array | null; fiscalCertPassword: string | null; updatedAt?: Date }): ParsedCert | null {
  if (!company.fiscalCert || !company.fiscalCertPassword) return null;
  const stamp = `${company.fiscalCertPassword}|${company.fiscalCert.length}`;
  const hit = cache.get(company.id);
  if (hit && hit.stamp === stamp) return hit.cert;
  const cert = parseP12(company.fiscalCert, decryptSecret(company.fiscalCertPassword) ?? '');
  cache.set(company.id, { stamp, cert });
  return cert;
}
