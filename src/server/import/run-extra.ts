import 'server-only';
import type { RunCtx } from './run';
import { bulkInsert, newId, ts } from './run';
import type { ImportPlan } from './plan';

/** Vrste e-pošte → entitet plana (id zapisa na koji se poruka odnosi). */
const MAIL_ENTITY: Record<string, string> = {
  invoice: 'invoices', quote: 'quotes', proforma: 'quotes', delivery: 'invoices', service: 'serviceOrders', 'service-delivery': 'serviceOrders',
  partner: 'partners', reminder: 'invoices', order: 'orders', receipt: 'receipts',
};

/**
 * Tablice koje ima samo sigurnosna kopija ovog programa: dnevnik e-pošte i
 * korisnici portala. E-adresa korisnika portala je jedinstvena u cijeloj bazi —
 * ako je zauzeta (npr. izvorna firma još postoji), korisnik se preskače.
 */
export async function insertExtras(c: RunCtx, plan: ImportPlan) {
  const { tx, companyId } = c;
  const mails = (plan.emailLogs ?? []).map((m) => ({
    id: newId(), companyId, kind: m.kind.slice(0, 40), entityId: m.entityKey ? (c.id(MAIL_ENTITY[m.kind] ?? '', m.entityKey) ?? null) : null,
    to: m.to.slice(0, 1000), cc: m.cc, subject: m.subject.slice(0, 1000), status: m.status, error: m.error, messageId: m.messageId, sentBy: m.sentBy, at: new Date(m.at),
  }));
  await bulkInsert(tx, 'EmailLog', mails);
  c.count('emailLogs', mails.length);

  const wanted = (plan.portalUsers ?? []).filter((p) => c.id('partners', p.partnerKey));
  const taken = new Set(
    wanted.length ? (await tx.portalUser.findMany({ where: { email: { in: wanted.map((p) => p.email) } }, select: { email: true } })).map((p) => p.email) : [],
  );
  const portal = wanted.filter((p) => !taken.has(p.email) && (taken.add(p.email), true));
  if (portal.length) {
    await tx.portalUser.createMany({
      data: portal.map((p) => ({
        companyId, partnerId: c.id('partners', p.partnerKey)!, email: p.email, name: p.name, passwordHash: p.passwordHash, active: p.active,
        lastLoginAt: p.lastLoginAt ? new Date(p.lastLoginAt) : null, createdAt: ts(p.createdAt),
      })),
    });
  }
  c.count('portalUsers', portal.length, (plan.portalUsers?.length ?? 0) - portal.length);
  c.step('emailLogs+portalUsers', mails.length + portal.length);
}
