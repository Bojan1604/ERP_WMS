import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import forge from 'node-forge';
import { SignedXml } from 'xml-crypto';
import {
  cisAmount,
  cisDateTime,
  certWarnings,
  fiscalQrUrl,
  fiscalReadiness,
  fiscalRoute,
  missingForCis,
  zkiDateTime,
  zkiInput,
} from '../src/domain/fiscal';
import { computeZki } from '../src/server/fiscal/zki';
import { buildRacunZahtjev, parseCisResponse, signXml, type RacunData } from '../src/server/fiscal/cis';
import { oibFromAttrs, parseP12 } from '../src/server/fiscal/cert';
import { decryptSecret, encryptSecret } from '../src/server/fiscal/crypto';

const OIB = '12345678903'; // ispravna kontrolna znamenka
const company = { fiscalEnabled: true, eInvoiceProvider: 'demo' };

test('put fiskalizacije po načinu plaćanja i kupcu', () => {
  const b2b = { country: 'HR', oib: '69435151530' };
  assert.equal(fiscalRoute({ paymentMethod: 'CASH', company, partner: b2b }), 'CIS');
  assert.equal(fiscalRoute({ paymentMethod: 'CARD', company, partner: b2b }), 'CIS');
  assert.equal(fiscalRoute({ paymentMethod: 'OTHER', company, partner: b2b }), 'CIS');
  assert.equal(fiscalRoute({ paymentMethod: 'CASH', company: { ...company, fiscalEnabled: false }, partner: b2b }), 'NONE');
  assert.equal(fiscalRoute({ paymentMethod: 'TRANSFER', company, partner: b2b }), 'EINVOICE');
  assert.equal(fiscalRoute({ paymentMethod: 'TRANSFER', company: { ...company, eInvoiceProvider: 'none' }, partner: b2b }), 'NONE');
  // krajnji kupac u RH (bez OIB-a) → CIS i za transakcijski račun
  assert.equal(fiscalRoute({ paymentMethod: 'TRANSFER', company, partner: { country: 'HR', oib: null } }), 'CIS');
  assert.equal(fiscalRoute({ paymentMethod: 'TRANSFER', company, partner: { country: 'DE', oib: null } }), 'NONE');
});

test('oblikovanje datuma i iznosa za CIS', () => {
  // 5. 3. 2026. 10:15:07 po zagrebačkom vremenu (CET = UTC+1)
  const d = new Date('2026-03-05T09:15:07Z');
  assert.equal(zkiDateTime(d), '05.03.2026 10:15:07');
  assert.equal(cisDateTime(d), '05.03.2026T10:15:07');
  // ljetno vrijeme (CEST = UTC+2), ponoć
  assert.equal(zkiDateTime(new Date('2026-07-01T22:00:00Z')), '02.07.2026 00:00:00');
  assert.equal(cisAmount(123.4), '123.40');
  assert.equal(cisAmount(1.005), '1.01');
  assert.equal(cisAmount(-10), '-10.00');
  assert.equal(cisAmount(-0.001), '0.00');
});

test('ulaz za ZKI i QR poveznica', () => {
  const issuedAt = new Date('2026-03-05T09:15:07Z');
  assert.equal(
    zkiInput({ oib: OIB, issuedAt, seq: 12, premises: 'PP1', device: '1', total: 125 }),
    `${OIB}05.03.2026 10:15:0712PP11125.00`,
  );
  const jir = '12345678-1234-1234-1234-123456789012';
  assert.equal(fiscalQrUrl({ jir, zki: 'x', issuedAt, total: 1250.5 }), `https://porezna.gov.hr/rn?jir=${jir}&datv=20260305_1015&izn=1250,50`);
  assert.equal(fiscalQrUrl({ zki: 'abc', issuedAt, total: 10 }), 'https://porezna.gov.hr/rn?zki=abc&datv=20260305_1015&izn=10,00');
  assert.equal(fiscalQrUrl({ issuedAt, total: 10 }), null);
});

test('ZKI: MD5 heks RSA-SHA1 potpisa, deterministički', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const input = zkiInput({ oib: OIB, issuedAt: new Date('2026-03-05T09:15:07Z'), seq: 1, premises: 'PP1', device: '1', total: 99.99 });
  const a = computeZki(pem, input);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(computeZki(pem, input), a, 'PKCS#1 v1.5 potpis je deterministički');
  assert.notEqual(computeZki(pem, `${input}0`), a);
  // provjera da je potpis stvarno RSA-SHA1 nad ulazom
  const sig = createSign('RSA-SHA1').update(input).sign(pem);
  assert.ok(createVerify('RSA-SHA1').update(input).verify(publicKey, sig));
});

test('što nedostaje za CIS i spremnost', () => {
  assert.deepEqual(missingForCis({ companyOib: OIB, operatorOib: OIB, premises: 'PP1', device: '1', hasCert: false, env: 'TEST' }), []);
  const m = missingForCis({ companyOib: '1', operatorOib: null, premises: 'P-1', device: 'A', hasCert: false, env: 'PROD' });
  assert.equal(m.length, 5);
  const now = new Date('2026-09-01T00:00:00Z');
  const cert = { subject: 'CN=x', issuer: 'CN=Fina', validTo: '2026-09-15T00:00:00Z', oib: '69435151530' };
  const w = certWarnings(cert, OIB, now);
  assert.equal(w.length, 2); // drugi OIB + istječe
  const r = fiscalReadiness({
    company: { oib: OIB, fiscalEnabled: true, fiscalEnv: 'TEST', invoicePremises: 'PP1', invoiceDevice: '1', eInvoiceProvider: 'none', hasApiKey: false, cert: null },
    operators: [{ name: 'Ana', oib: OIB }, { name: 'Ivo', oib: null }],
    now,
  });
  assert.equal(r.find((x) => x.key === 'operators')?.ok, false);
  assert.match(r.find((x) => x.key === 'operators')?.hint ?? '', /Ivo/);
  assert.equal(r.find((x) => x.key === 'company-oib')?.ok, true);
});

/** Samopotpisani testni .p12 s OIB-om u subjektu. */
function makeP12(password: string) {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '0a1b2c';
  cert.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2028-01-01T00:00:00Z');
  const attrs = [
    { shortName: 'C', value: 'HR' },
    { shortName: 'O', value: `Demo Oprema d.o.o. HR${OIB}` },
    { shortName: 'CN', value: 'FISKAL 1' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer([{ shortName: 'C', value: 'HR' }, { shortName: 'O', value: 'Test CA' }, { shortName: 'CN', value: 'Test Fiskal CA' }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des' });
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

test('certifikat: .p12 → ključ, certifikat, OIB; pogrešna lozinka', () => {
  const p12 = makeP12('tajna');
  const c = parseP12(p12, 'tajna');
  assert.equal(c.info.oib, OIB);
  assert.match(c.info.subject, /CN=FISKAL 1/);
  assert.equal(c.serialDecimal, String(0x0a1b2c));
  assert.equal(c.info.validTo.slice(0, 10), '2028-01-01');
  assert.throws(() => parseP12(p12, 'kriva'), /lozinka|p12/i);
  assert.equal(oibFromAttrs([{ value: 'VATHR-69435151530' }]), '69435151530');
});

test('CIS: RacunZahtjev, potpis se može provjeriti, odgovor', () => {
  const c = parseP12(makeP12('x'), 'x');
  const data: RacunData = {
    oib: OIB,
    vatRegistered: true,
    issuedAt: new Date('2026-03-05T09:15:07Z'),
    seqMode: 'P',
    seq: 12,
    premises: 'PP1',
    device: '1',
    taxCategory: 'S',
    vatRate: 25,
    net: 100,
    vat: 25,
    charges: 0,
    total: 125,
    paymentMethod: 'CASH',
    operatorOib: OIB,
    zki: 'a'.repeat(32),
    lateDelivery: true,
    messageId: '00000000-0000-0000-0000-000000000001',
    sentAt: new Date('2026-03-05T09:15:08Z'),
  };
  const xml = buildRacunZahtjev(data);
  assert.match(xml, /<tns:DatVrijeme>05\.03\.2026T10:15:07<\/tns:DatVrijeme>/);
  assert.match(xml, /<tns:BrRac><tns:BrOznRac>12<\/tns:BrOznRac><tns:OznPosPr>PP1<\/tns:OznPosPr><tns:OznNapUr>1<\/tns:OznNapUr><\/tns:BrRac>/);
  assert.match(xml, /<tns:Porez><tns:Stopa>25\.00<\/tns:Stopa><tns:Osnovica>100\.00<\/tns:Osnovica><tns:Iznos>25\.00<\/tns:Iznos><\/tns:Porez>/);
  assert.match(xml, /<tns:NacinPlac>G<\/tns:NacinPlac>/);
  assert.match(xml, /<tns:NakDost>true<\/tns:NakDost>/);

  const signed = signXml(xml, c);
  assert.match(signed, /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
  assert.match(signed, /Reference URI="#RacunZahtjev"/);
  assert.match(signed, /<X509SerialNumber>\d+<\/X509SerialNumber>/);
  const v = new SignedXml({ publicCert: c.certPem });
  const doc = new DOMParser().parseFromString(signed, 'text/xml');
  v.loadSignature(doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0] as unknown as Node);
  assert.ok(v.checkSignature(signed), 'potpis mora biti valjan');
  // FISCAL_SIGNATURE=sha1 (primjeri iz specifikacije CIS-a)
  const signed1 = signXml(xml, c, 'sha1');
  assert.match(signed1, /SignatureMethod Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#rsa-sha1"/);
  assert.match(signed1, /DigestMethod Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#sha1"/);
  const v1 = new SignedXml({ publicCert: c.certPem });
  v1.loadSignature(new DOMParser().parseFromString(signed1, 'text/xml').getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0] as unknown as Node);
  assert.ok(v1.checkSignature(signed1), 'SHA1 potpis mora biti valjan');

  const ok = parseCisResponse(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><tns:RacunOdgovor xmlns:tns="http://www.apis-it.hr/fin/2012/types/f73"><tns:Jir>abc-123</tns:Jir></tns:RacunOdgovor></soap:Body></soap:Envelope>`,
  );
  assert.equal(ok.jir, 'abc-123');
  const bad = parseCisResponse(
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><tns:RacunOdgovor xmlns:tns="http://www.apis-it.hr/fin/2012/types/f73"><tns:Greske><tns:Greska><tns:SifraGreske>s004</tns:SifraGreske><tns:PorukaGreske>Neispravan digitalni potpis.</tns:PorukaGreske></tns:Greska></tns:Greske></tns:RacunOdgovor></soap:Body></soap:Envelope>`,
  );
  assert.equal(bad.jir, null);
  assert.deepEqual(bad.errors, [{ code: 's004', message: 'Neispravan digitalni potpis.' }]);
});

test('šifriranje tajni (AES-256-GCM)', () => {
  process.env.DATABASE_URL ||= 'postgresql://x';
  process.env.AUTH_SECRET ||= 'test-secret-0123456789abcdef0123456789abcdef';
  const e = encryptSecret('lozinka-123');
  assert.match(e, /^v1:/);
  assert.notEqual(encryptSecret('lozinka-123'), e, 'nasumični IV');
  assert.equal(decryptSecret(e), 'lozinka-123');
  assert.equal(decryptSecret(null), null);
  const tampered = `v1:${Buffer.from(Buffer.from(e.slice(3), 'base64').map((b, i) => (i === 30 ? b ^ 1 : b))).toString('base64')}`;
  assert.throws(() => decryptSecret(tampered));
});
