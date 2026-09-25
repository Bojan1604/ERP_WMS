import 'server-only';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';
import { Prisma, type Role } from '@prisma/client';
import type { Tx } from '../db';
import { audit } from '../audit';
import { AuthError, DomainError, assert } from '../errors';
import { bootstrapCompany } from './company';
import { wipeMdmData } from '../mdm/wipe';
import type { SessionUser } from '../auth';
import type { Actor } from './items';
import { canUseDanger } from '@/domain/permissions';

/**
 * Opasna zona (F11): brisanje prometa, brisanje svih podataka i vraćanje demo
 * podataka. Smije administrator ili korisnik s pravom „opasna zona"; svaka
 * radnja traži lozinku i upis točnog naziva firme. Sve u jednoj transakciji —
 * uspije u cijelosti ili se ništa ne briše.
 */
export type DangerActor = Pick<SessionUser, 'id' | 'name' | 'companyId' | 'role' | 'canDanger'>;

/** Provjera prava, lozinke i naziva firme (dvostruka potvrda). */
export async function confirmDanger(tx: Tx, actor: DangerActor, input: { password: string; companyName: string }) {
  if (!canUseDanger(actor)) throw new AuthError('Nemate pravo na opasnu zonu.', 403);
  const [u, c] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { passwordHash: true, canDanger: true, role: true } }),
    tx.company.findUniqueOrThrow({ where: { id: actor.companyId }, select: { name: true, isDemo: true } }),
  ]);
  // pravo se provjerava i u bazi (sesija može biti starija od oduzimanja prava)
  if (!canUseDanger(u)) throw new AuthError('Nemate pravo na opasnu zonu.', 403);
  assert(await bcrypt.compare(input.password, u.passwordHash), 'Lozinka nije ispravna.');
  assert(input.companyName.trim() === c.name, `Za potvrdu upišite točan naziv firme: „${c.name}".`);
  return c;
}

const del = (tx: Tx, table: string, companyId: string) => tx.$executeRaw`DELETE FROM ${Prisma.raw(`"${table}"`)} WHERE "companyId" = ${companyId}`;

/** Promet: dokumenti, uređaji, ugovori, servis, troškovi, nabava, dnevnici — redom koji poštuje strane ključeve. */
const TRANSACTION_TABLES = [
  'ApprovalRequest', 'Attachment', 'EmailLog', 'FiscalLog', 'ItemEvent', 'RentOverride',
  'Stocktake', // + StocktakeScan (kaskadno)
  'Transfer', // + TransferItem
  'ServiceOrder',
  'Expense',
  'SupplierInvoice',
  'Quote', // + QuoteLine
  'Invoice', // + InvoiceLine, Payment; Item.invoiceId → NULL
  'Contract', // + ContractItem, ReturnedContractItem
  'Package', // + PackageItem
  'Item', // MdmDevice.itemId → NULL
  'GoodsReceipt',
  'PurchaseOrder', // + PurchaseOrderLine
  'DocumentCounter',
  'AuditLog',
] as const;

export type DeleteCounts = Record<string, number>;

/**
 * „Obriši promet": ostaju partneri (i njihove dogovorene cijene), šifrarnici
 * (modeli, kategorije, statusi, skladišta, usluge, kategorije troškova),
 * korisnici, korisnici portala, postavke firme i MDM. Brojači dokumenata kreću
 * ispočetka. Zapis o brisanju ostaje u (inače ispražnjenom) dnevniku.
 */
export async function deleteTransactions(tx: Tx, actor: Actor): Promise<DeleteCounts> {
  const counts: DeleteCounts = {};
  for (const t of TRANSACTION_TABLES) counts[t] = await del(tx, t, actor.companyId);
  await audit(tx, actor, {
    entity: 'company', entityId: actor.companyId, action: 'wipe-transactions',
    summary: `Obrisan promet: ${counts.Item} uređaja, ${counts.Invoice} računa, ${counts.Contract} ugovora, ${counts.ServiceOrder} servisnih naloga, ${counts.Expense} troškova`,
    diff: counts,
  });
  return counts;
}

/**
 * „Obriši sve": promet + partneri, šifrarnici, ostali korisnici i svi MDM podaci
 * (organizacije, uređaji, profili, aplikacije, datoteke, vanjski korisnici MDM-a).
 * Ostaje firma s postavkama i korisnik koji briše. Sistemski statusi, zadano
 * skladište i kategorije troškova se ponovno stvaraju, da se u programu može odmah
 * raditi. `mdmFiles` = ključevi MDM datoteka na disku — pozivatelj ih briše
 * (`removeStoredFiles`) tek nakon potvrde transakcije.
 */
export async function deleteEverything(tx: Tx, actor: Actor): Promise<DeleteCounts & { mdmFiles: string[] }> {
  const c = actor.companyId;
  const counts = await deleteTransactions(tx, actor);
  const mdm = await wipeMdmData(tx, c);
  Object.assign(counts, mdm.counts);
  for (const t of ['PriceAgreement', 'PortalUser', 'Partner', 'Service', 'ExpenseCategory', 'DeviceModel', 'Category', 'ItemStatus', 'Warehouse'] as const) {
    counts[t] = (counts[t] ?? 0) + (await del(tx, t, c));
  }
  // ostali korisnici ERP-a: kome je ovo trenutna firma, a ima pristup drugoj — prelazi u nju; ostali se brišu.
  // Korisnik s pravom opasne zone koji nije administrator ne briše administratore (ostaju s pristupom firmi).
  const me = await tx.user.findUnique({ where: { id: actor.id }, select: { role: true } });
  const keep: Role[] = me?.role === 'ADMIN' ? ['DISTRIBUTOR', 'CLIENT'] : ['DISTRIBUTOR', 'CLIENT', 'ADMIN'];
  const others = await tx.user.findMany({
    where: { id: { not: actor.id }, role: { notIn: keep }, OR: [{ companyId: c }, { companies: { some: { companyId: c } } }] },
    select: { id: true, companyId: true, companies: { where: { companyId: { not: c } }, select: { companyId: true }, take: 1 } },
  });
  let removed = 0;
  for (const u of others) {
    if (u.companyId !== c) continue;
    if (u.companies.length) await tx.user.update({ where: { id: u.id }, data: { companyId: u.companies[0].companyId } });
    else {
      await tx.user.delete({ where: { id: u.id } });
      removed++;
    }
  }
  await tx.userCompany.deleteMany({ where: { companyId: c, userId: { in: others.map((u) => u.id) } } });
  counts.User = removed;
  await bootstrapCompany(tx, c);
  await audit(tx, actor, {
    entity: 'company', entityId: c, action: 'wipe-all',
    summary: `Obrisani svi podaci firme (${removed} korisnika uklonjeno, ${mdm.counts.MdmDevice} MDM uređaja, ${mdm.storageKeys.length} MDM datoteka)`,
    diff: counts,
  });
  return Object.assign(counts, { mdmFiles: mdm.storageKeys });
}

/**
 * „Vrati demo podatke" — samo za demo firmu (Company.isDemo): pokreće isti
 * postupak kao `npm run db:seed` za TU firmu (id u SEED_DEMO_COMPANY_ID): briše je
 * i ponovno stvara s korisnicima admin@demo.hr … — svi se moraju ponovno prijaviti.
 */
export async function resetDemo(companyId: string): Promise<void> {
  const root = process.cwd();
  const tsx = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  try {
    await promisify(execFile)(tsx, ['--conditions=react-server', path.join(root, 'prisma', 'seed.ts')], {
      cwd: root, timeout: 10 * 60_000, env: { ...process.env, SEED_DEMO_COMPANY_ID: companyId }, maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n').filter(Boolean).slice(-1)[0] : String(e);
    throw new DomainError(`Vraćanje demo podataka nije uspjelo: ${msg}`);
  }
}

/**
 * Brisanje demo firme (seed): samo firma s oznakom isDemo. Korisnici kojima je ona
 * trenutna firma, a imaju pristup drugoj (npr. administrator koji je u nju prešao),
 * vraćaju se u drugu firmu; brišu se samo korisnici bez ijedne druge firme.
 * Vraća ključeve MDM datoteka za brisanje s diska nakon transakcije.
 */
export async function removeDemoCompany(tx: Tx, companyId: string): Promise<{ mdmFiles: string[]; removedUsers: number }> {
  const c = await tx.company.findUnique({ where: { id: companyId }, select: { isDemo: true } });
  assert(c?.isDemo, 'Brisati se smije samo demo firma.');
  const home = await tx.user.findMany({
    where: { companyId },
    select: { id: true, companies: { where: { companyId: { not: companyId } }, select: { companyId: true }, take: 1 } },
  });
  let removedUsers = 0;
  for (const u of home) {
    if (u.companies.length) {
      await tx.user.update({ where: { id: u.id }, data: { companyId: u.companies[0].companyId } });
      await tx.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
    } else {
      await tx.user.delete({ where: { id: u.id } });
      removedUsers++;
    }
  }
  await tx.userCompany.deleteMany({ where: { companyId } });
  for (const t of TRANSACTION_TABLES) await del(tx, t, companyId);
  const mdm = await wipeMdmData(tx, companyId);
  await tx.company.delete({ where: { id: companyId } });
  return { mdmFiles: mdm.storageKeys, removedUsers };
}

/** Demo firma je samo ona s oznakom isDemo (postavlja je `npm run db:seed`). */
export async function assertDemo(tx: Tx, companyId: string) {
  const c = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { isDemo: true } });
  assert(c.isDemo, 'Demo podaci se mogu vratiti samo u demo firmi.');
}
