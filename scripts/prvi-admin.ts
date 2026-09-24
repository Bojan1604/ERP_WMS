/**
 * Prva firma i administrator na praznoj produkcijskoj bazi (bez demo podataka).
 *
 *   docker compose exec app npx tsx --conditions=react-server scripts/prvi-admin.ts
 *
 * Pita naziv i OIB firme, ime i e-adresu administratora; lozinku sam izmisli i
 * ispiše je jednom — promijenite je nakon prve prijave (Postavke → Korisnici).
 * Ako u bazi već postoji korisnik, ne radi ništa (ne smije pregaziti prave podatke).
 */
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { bootstrapCompany } from '../src/server/services/company';
import { isValidOib } from '../src/domain/tax';

const db = new PrismaClient();

async function main() {
  const users = await db.user.count();
  if (users > 0) {
    console.log(`U bazi već postoji ${users} korisnik(a) — skripta ne radi ništa. Nove korisnike dodajte u programu (Postavke → Korisnici).`);
    return;
  }
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string, check?: (v: string) => string | null): Promise<string> => {
    for (;;) {
      process.stdout.write(q);
      const next = await lines.next();
      if (next.done) throw new Error('\nPrekinuto — nije ništa spremljeno.');
      const v = String(next.value).trim();
      const err = check?.(v);
      if (!err) return v;
      console.log('  ' + err);
    }
  };
  const name = await ask('Naziv firme (kako ide na račun): ', (v) => (v ? null : 'Naziv je obavezan.'));
  const oib = await ask('OIB firme: ', (v) => (isValidOib(v) ? null : 'OIB nije ispravan (11 znamenaka s kontrolnom znamenkom).'));
  const adminName = await ask('Ime i prezime administratora: ', (v) => (v ? null : 'Ime je obavezno.'));
  const email = (await ask('E-adresa administratora (za prijavu): ', (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Neispravna e-adresa.'))).toLowerCase();
  rl.close();

  const password = randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  await db.$transaction(async (tx) => {
    const c = await tx.company.create({ data: { name, oib, vatId: `HR${oib}` } });
    await bootstrapCompany(tx, c.id);
    await tx.user.create({ data: { companyId: c.id, email, name: adminName, role: 'ADMIN', passwordHash } });
  });
  console.log('\nGotovo. Prijava:');
  console.log(`  e-adresa: ${email}`);
  console.log(`  lozinka:  ${password}`);
  console.log('Lozinku promijenite nakon prve prijave (Postavke → Korisnici → vaš korisnik → Nova lozinka).');
  console.log('Zatim ispunite Postavke → Firma (adresa, IBAN, oznaka prostora i uređaja) i Postavke → Fiskalizacija.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
