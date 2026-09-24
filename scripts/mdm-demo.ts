/**
 * Demo podaci za MDM portal u demo firmi: distributeri, klijenti, lokacije,
 * vanjski korisnici i nekoliko uređaja koji čekaju upis. Upisane uređaje s
 * telemetrijom stvara simulator agenta (scripts/mdm-agent-sim.mjs).
 * Skripta je idempotentna — ponovno pokretanje ne stvara duplikate.
 *
 *   npx tsx --conditions=react-server scripts/mdm-demo.ts
 *
 * Prijave (lozinka admin123): distributor@demo.hr, distributor2@demo.hr, klijent@demo.hr
 */
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient, type MdmOrgType, type MdmPlatform, type Role } from '@prisma/client';

const db = new PrismaClient();

interface OrgSpec {
  name: string;
  city: string;
  oib: string;
  sites: string[];
  customers?: OrgSpec[];
}

const TREE: OrgSpec[] = [
  {
    name: 'Kasa Servis d.o.o.',
    city: 'Zagreb',
    oib: '11111111119',
    sites: [],
    customers: [
      { name: 'Restoran Maslina', city: 'Zagreb', oib: '22222222226', sites: ['Maslina — Centar', 'Maslina — Jarun'] },
      { name: 'Caffe bar Luka', city: 'Zadar', oib: '33333333333', sites: ['Luka — Riva'] },
      { name: 'Hotel Panorama', city: 'Opatija', oib: '44444444440', sites: ['Recepcija', 'Restoran', 'Bar na bazenu'] },
    ],
  },
  {
    name: 'Adria POS d.o.o.',
    city: 'Split',
    oib: '55555555557',
    sites: ['Servis Split'],
    customers: [
      { name: 'Pekara Klas', city: 'Split', oib: '66666666664', sites: ['Klas — Bačvice', 'Klas — Znjan'] },
      { name: 'Trgovina Sunce', city: 'Makarska', oib: '77777777771', sites: ['Sunce — Makarska'] },
    ],
  },
];

const USERS: Array<{ email: string; name: string; role: Role; org: string }> = [
  { email: 'distributor@demo.hr', name: 'Dario Distributer', role: 'DISTRIBUTOR', org: 'Kasa Servis d.o.o.' },
  { email: 'distributor2@demo.hr', name: 'Ante Adria', role: 'DISTRIBUTOR', org: 'Adria POS d.o.o.' },
  { email: 'klijent@demo.hr', name: 'Klara Klijent', role: 'CLIENT', org: 'Restoran Maslina' },
];

const PENDING: Array<{ hw: string; platform: MdmPlatform; name: string; manufacturer: string; model: string; serial: string; os: string; code: string }> = [
  { hw: 'demo-pending-1', platform: 'ANDROID', name: 'SUNMI V2s', manufacturer: 'SUNMI', model: 'V2s', serial: 'VB21DEMO0001', os: 'Android 11', code: '482913' },
  { hw: 'demo-pending-2', platform: 'ANDROID', name: 'Zebra TC21', manufacturer: 'Zebra', model: 'TC21', serial: '21045DEMO0002', os: 'Android 13', code: '593027' },
  { hw: 'demo-pending-3', platform: 'WINDOWS', name: 'POS-BLAGAJNA-3', manufacturer: 'HP', model: 'Engage One', serial: 'CZC1DEMO003', os: 'Windows 11 IoT Enterprise 23H2', code: '716450' },
];

async function org(companyId: string, spec: OrgSpec, type: MdmOrgType, parentId: string | null) {
  const existing = await db.mdmOrg.findFirst({ where: { companyId, name: spec.name } });
  const o = existing ?? (await db.mdmOrg.create({ data: { companyId, type, parentId, name: spec.name, city: spec.city, oib: spec.oib, email: `info@${spec.name.toLowerCase().replace(/[^a-z]+/g, '')}.hr` } }));
  for (const name of spec.sites) {
    if (!(await db.mdmSite.findFirst({ where: { orgId: o.id, name } }))) await db.mdmSite.create({ data: { orgId: o.id, name } });
  }
  return o;
}

async function main() {
  const admin = await db.user.findUnique({ where: { email: 'admin@demo.hr' }, select: { companyId: true } });
  if (!admin) throw new Error('Demo firma ne postoji (admin@demo.hr) — prvo pokrenite npm run db:seed.');
  const companyId = admin.companyId;
  const orgIds = new Map<string, string>();

  for (const d of TREE) {
    const dist = await org(companyId, d, 'DISTRIBUTOR', null);
    orgIds.set(d.name, dist.id);
    for (const c of d.customers ?? []) orgIds.set(c.name, (await org(companyId, c, 'CUSTOMER', dist.id)).id);
  }

  // jedan klijent povezan s ERP partnerom (vidi samo vlasnik)
  const partner = await db.partner.findFirst({ where: { companyId, isCustomer: true }, orderBy: { name: 'asc' }, select: { id: true } });
  if (partner) await db.mdmOrg.updateMany({ where: { id: orgIds.get('Restoran Maslina'), partnerId: null }, data: { partnerId: partner.id } });

  const passwordHash = await bcrypt.hash('admin123', 10);
  for (const u of USERS) {
    const mdmOrgId = orgIds.get(u.org)!;
    const found = await db.user.findUnique({ where: { email: u.email } });
    if (!found) await db.user.create({ data: { companyId, email: u.email, name: u.name, role: u.role, mdmOrgId, passwordHash } });
    else if (found.companyId === companyId) await db.user.update({ where: { id: found.id }, data: { role: u.role, mdmOrgId, active: true } });
  }

  for (const p of PENDING) {
    if (await db.mdmDevice.findFirst({ where: { companyId, hardwareId: p.hw } })) continue;
    await db.mdmDevice.create({
      data: {
        companyId,
        platform: p.platform,
        status: 'PENDING',
        name: p.name,
        enrollCode: p.code,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
        hardwareId: p.hw,
        serial: p.serial,
        manufacturer: p.manufacturer,
        model: p.model,
        osVersion: p.os,
        agentVersion: '1.0.0',
        ipAddress: '192.168.1.' + (40 + PENDING.indexOf(p)),
        lastSeenAt: new Date(),
        events: { create: { type: 'REGISTER', message: `Agent se javio, kod za upis ${p.code}` } },
      },
    });
  }

  // ključ za automatski upis (demo)
  const maslina = orgIds.get('Restoran Maslina')!;
  if (!(await db.mdmEnrollToken.findFirst({ where: { orgId: maslina, label: 'Demo — Maslina Centar' } }))) {
    const site = await db.mdmSite.findFirst({ where: { orgId: maslina, name: 'Maslina — Centar' } });
    await db.mdmEnrollToken.create({ data: { companyId, orgId: maslina, siteId: site?.id ?? null, token: randomBytes(16).toString('hex'), label: 'Demo — Maslina Centar', createdBy: 'mdm-demo' } });
  }

  const [orgs, sites, users, pending] = await Promise.all([
    db.mdmOrg.count({ where: { companyId } }),
    db.mdmSite.count({ where: { org: { companyId } } }),
    db.user.count({ where: { companyId, role: { in: ['DISTRIBUTOR', 'CLIENT'] } } }),
    db.mdmDevice.count({ where: { companyId, status: 'PENDING' } }),
  ]);
  console.log(`MDM demo: ${orgs} organizacija, ${sites} lokacija, ${users} vanjskih korisnika, ${pending} uređaja čeka upis.`);
  console.log('Prijave (admin123): distributor@demo.hr, distributor2@demo.hr, klijent@demo.hr');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
