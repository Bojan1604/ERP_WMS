import 'server-only';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

/**
 * ZKI (zaštitni kod izdavatelja): MD5 (hex, 32 znaka) RSA-SHA1 potpisa
 * (PKCS#1 v1.5) niza iz `zkiInput` privatnim ključem fiskalizacijskog certifikata.
 */
export function computeZki(privateKeyPem: string, input: string): string {
  const signature = createSign('RSA-SHA1').update(input, 'utf8').sign(privateKeyPem);
  return createHash('md5').update(signature).digest('hex');
}

let demo: { privateKeyPem: string; publicKeyPem: string } | null = null;

/** Demo ključ (generira se jednom po procesu) — ZKI pravog oblika, ali bez vrijednosti pred Poreznom. */
export function demoKey() {
  if (!demo) {
    const k = generateKeyPairSync('rsa', { modulusLength: 2048 });
    demo = {
      privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  }
  return demo;
}
