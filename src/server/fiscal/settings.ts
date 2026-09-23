import 'server-only';
import { Prisma } from '@prisma/client';
import type { Tx } from '../db';
import { audit } from '../audit';
import { assert } from '../errors';
import type { Actor } from '../services/items';
import { certWarnings } from '@/domain/fiscal';
import { parseP12 } from './cert';
import { encryptSecret } from './crypto';

export interface FiscalSettingsInput {
  fiscalEnabled: boolean;
  fiscalEnv: 'TEST' | 'PROD';
  fiscalSequenceMode: 'P' | 'N';
  eInvoiceProvider: 'none' | 'demo' | 'eposlovanje' | 'moj-eracun';
  /** Novi API ključ; null = ne mijenja se. */
  apiKey: string | null;
  clearApiKey: boolean;
}

export async function saveFiscalSettings(tx: Tx, actor: Actor, input: FiscalSettingsInput) {
  const before = await tx.company.findUniqueOrThrow({
    where: { id: actor.companyId },
    select: { fiscalEnabled: true, fiscalEnv: true, fiscalSequenceMode: true, eInvoiceProvider: true, fiscalCert: true, eInvoiceApiKey: true },
  });
  if (input.fiscalEnabled && input.fiscalEnv === 'PROD') {
    assert(before.fiscalCert, 'Za produkciju prvo učitajte fiskalizacijski certifikat.');
  }
  const data: Prisma.CompanyUpdateInput = {
    fiscalEnabled: input.fiscalEnabled,
    fiscalEnv: input.fiscalEnv,
    fiscalSequenceMode: input.fiscalSequenceMode,
    eInvoiceProvider: input.eInvoiceProvider,
  };
  if (input.apiKey) data.eInvoiceApiKey = encryptSecret(input.apiKey);
  else if (input.clearApiKey) data.eInvoiceApiKey = null;
  await tx.company.update({ where: { id: actor.companyId }, data });

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ['fiscalEnabled', 'fiscalEnv', 'fiscalSequenceMode', 'eInvoiceProvider'] as const) {
    if (before[k] !== input[k]) changes[k] = { from: before[k], to: input[k] };
  }
  if (input.apiKey) changes.eInvoiceApiKey = { from: before.eInvoiceApiKey ? 'postavljen' : null, to: 'novi ključ' };
  else if (input.clearApiKey && before.eInvoiceApiKey) changes.eInvoiceApiKey = { from: 'postavljen', to: null };
  if (Object.keys(changes).length) {
    await audit(tx, actor, { entity: 'company', entityId: actor.companyId, action: 'fiscal-settings', summary: 'Postavke fiskalizacije izmijenjene', diff: changes as object });
  }
}

/** Učitavanje FINA certifikata: provjera otvaranjem, spremanje datoteke i šifrirane lozinke. Vraća upozorenja. */
export async function uploadFiscalCert(tx: Tx, actor: Actor, file: Uint8Array, password: string) {
  assert(file.length > 0 && file.length < 200_000, 'Datoteka certifikata je prazna ili prevelika.');
  const parsed = parseP12(file, password);
  const company = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { oib: true } });
  await tx.company.update({
    where: { id: actor.companyId },
    data: {
      fiscalCert: Uint8Array.from(file),
      fiscalCertPassword: encryptSecret(password),
      fiscalCertInfo: parsed.info as unknown as Prisma.InputJsonValue,
    },
  });
  await audit(tx, actor, {
    entity: 'company',
    entityId: actor.companyId,
    action: 'fiscal-cert',
    summary: `Učitan fiskalizacijski certifikat (${parsed.info.subject}, vrijedi do ${parsed.info.validTo.slice(0, 10)})`,
  });
  return { info: parsed.info, warnings: certWarnings(parsed.info, company.oib) };
}

export async function removeFiscalCert(tx: Tx, actor: Actor) {
  const c = await tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { fiscalEnabled: true, fiscalEnv: true } });
  assert(!(c.fiscalEnabled && c.fiscalEnv === 'PROD'), 'Certifikat se ne može ukloniti dok je fiskalizacija uključena u produkciji.');
  await tx.company.update({ where: { id: actor.companyId }, data: { fiscalCert: null, fiscalCertPassword: null, fiscalCertInfo: Prisma.DbNull } });
  await audit(tx, actor, { entity: 'company', entityId: actor.companyId, action: 'fiscal-cert', summary: 'Fiskalizacijski certifikat uklonjen' });
}
