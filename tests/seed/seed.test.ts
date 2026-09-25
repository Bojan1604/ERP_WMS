/**
 * Demo podaci na praznoj bazi: `npm run setup` (migracije + seed) mora proći na svježoj bazi
 * i dati dosljedne podatke (redni broj prati datum, nema budućih datuma, KPD na stavkama,
 * prijava admin@demo.hr / admin123). Ponovno pokretanje seeda (Vrati demo podatke) također prolazi.
 *
 *   npm run test:seed      (baza SEED_TEST_DATABASE_URL, zadano wms_seedtest — stvara se i briše)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { today } from '../../src/domain/dates';

const url = new URL(process.env.SEED_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/wms_seedtest?schema=public');
const dbName = url.pathname.slice(1);
// test briše i ponovno stvara bazu — samo baza s „seedtest" u nazivu
assert.match(dbName, /seedtest/, `SEED_TEST_DATABASE_URL mora imati „seedtest" u nazivu baze (sada: ${dbName}).`);
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
adminUrl.search = '';

const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
const env = { ...process.env, DATABASE_URL: url.toString() };
const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { env, stdio: 'pipe', encoding: 'utf8', timeout: 600_000 });

async function recreate(drop = true) {
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  if (!drop) return;
  await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
}

after(async () => {
  await recreate(false);
  await admin.$disconnect();
});

test('seed na praznoj bazi: migracije + demo firma, dosljedni podaci, prijava radi', { timeout: 900_000 }, async () => {
  await recreate();
  run('npx', ['prisma', 'migrate', 'deploy']);
  const out = run('npx', ['tsx', '--conditions=react-server', 'prisma/seed.ts']);
  assert.match(out, /Demo firma spremna/);

  const db = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const u = await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.hr' }, include: { company: true } });
    assert.ok(u.active);
    assert.ok(await bcrypt.compare('admin123', u.passwordHash), 'demo lozinka ne odgovara');
    assert.ok(u.company.isDemo);

    const issued = await db.invoice.count({ where: { companyId: u.companyId, status: 'ISSUED' } });
    assert.ok(issued > 50, `premalo izdanih računa (${issued})`);
    // redni broj prati datum izdavanja
    const [{ n: outOfOrder }] = await db.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM (
        SELECT date, lag(date) OVER (PARTITION BY "companyId", year ORDER BY seq) AS prev FROM "Invoice" WHERE status = 'ISSUED'
      ) x WHERE prev > date`;
    assert.equal(outOfOrder, 0, 'redni brojevi računa ne prate datume');
    const future = await db.invoice.count({ where: { status: 'ISSUED', date: { gt: new Date(`${today()}T00:00:00Z`) } } });
    assert.equal(future, 0, 'izdani račun s budućim datumom');
    const noKpd = await db.invoiceLine.count({ where: { kpd: null, invoice: { status: 'ISSUED', kind: 'INVOICE' } } });
    assert.equal(noKpd, 0, 'stavke izdanih računa bez KPD-a');
    assert.ok((await db.contract.count({ where: { companyId: u.companyId } })) > 0);
    assert.ok((await db.item.count({ where: { companyId: u.companyId, state: 'RENTED' } })) > 0);
  } finally {
    await db.$disconnect();
  }

  // ponovno pokretanje (Vrati demo podatke / npm run db:seed nad postojećom demo firmom)
  assert.match(run('npx', ['tsx', '--conditions=react-server', 'prisma/seed.ts']), /Demo firma spremna/);
});
