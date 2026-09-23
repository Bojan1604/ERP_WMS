'use server';

import { z } from 'zod';
import { action } from '@/server/action';
import { transaction } from '@/server/db';
import { DomainError } from '@/server/errors';
import { zBool, zOptText } from '@/server/zod';
import { removeFiscalCert, saveFiscalSettings, uploadFiscalCert } from '@/server/fiscal/settings';
import { retryPending, testConnection } from '@/server/fiscal';

const zSettings = z.object({
  fiscalEnabled: zBool,
  fiscalEnv: z.enum(['TEST', 'PROD']),
  fiscalSequenceMode: z.enum(['P', 'N']),
  eInvoiceProvider: z.enum(['none', 'demo', 'eposlovanje', 'moj-eracun']),
  apiKey: zOptText,
  clearApiKey: zBool,
});

export const saveFiscalSettingsAction = action({ module: 'settings', level: 'edit' }, zSettings, async (input, user) => {
  await transaction((tx) => saveFiscalSettings(tx, user, input));
  return { message: 'Postavke fiskalizacije su spremljene.' };
});

const zCert = z.object({
  file: z.instanceof(File, { message: 'Odaberite .p12 datoteku certifikata' }),
  password: z.string().min(1, 'Lozinka certifikata je obavezna'),
});

export const uploadFiscalCertAction = action({ module: 'settings', level: 'edit' }, zCert, async ({ file, password }, user) => {
  if (!file.size) throw new DomainError('Odaberite .p12 datoteku certifikata.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const r = await transaction((tx) => uploadFiscalCert(tx, user, bytes, password));
  return { message: `Certifikat je učitan (${r.info.oib ?? 'bez OIB-a'}, vrijedi do ${r.info.validTo.slice(0, 10)}).${r.warnings.length ? ` Upozorenje: ${r.warnings.join(' ')}` : ''}` };
});

export const removeFiscalCertAction = action({ module: 'settings', level: 'edit' }, z.object({}), async (_i, user) => {
  await transaction((tx) => removeFiscalCert(tx, user));
  return { message: 'Certifikat je uklonjen.' };
});

export const testFiscalConnectionAction = action({ module: 'settings', level: 'edit' }, z.object({}), async (_i, user) => {
  const r = await testConnection(user.companyId);
  const msg = [r.cis.message, r.provider?.message].filter(Boolean).join(' ');
  if (!r.cis.ok || (r.provider && !r.provider.ok)) throw new DomainError(msg);
  return { message: msg };
});

export const retryFiscalAction = action({ module: 'settings', level: 'edit' }, z.object({}), async (_i, user) => {
  const r = await retryPending(user, 50);
  if (!r.total) return { message: 'Nema računa koji čekaju fiskalizaciju.' };
  return {
    message: `Naknadna fiskalizacija: ${r.ok} uspješno, ${r.failed} neuspješno${r.skipped ? `, ${r.skipped} preskočeno` : ''} od ${r.total}.${r.stopped ? ` ${r.stopped[0].toUpperCase()}${r.stopped.slice(1)} — ostali čekaju.` : ''}${r.remaining ? ` Još čeka: ${r.remaining}.` : ''}`,
  };
});
