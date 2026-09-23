import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env';

/**
 * Šifriranje tajni u bazi (lozinka certifikata, API ključ posrednika):
 * AES-256-GCM, ključ izveden iz AUTH_SECRET (scrypt). Oblik: `v1:<base64(iv|tag|šifrat)>`.
 * Promjena AUTH_SECRET-a znači da se certifikat i ključ moraju ponovno upisati.
 */
let key: Buffer | null = null;
const keyFor = () => (key ??= scryptSync(env().AUTH_SECRET, 'erp-wms/fiscal-secrets/v1', 32));

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFor(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith('v1:')) throw new Error('Nepoznat oblik šifrirane vrijednosti.');
  const raw = Buffer.from(stored.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFor(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
