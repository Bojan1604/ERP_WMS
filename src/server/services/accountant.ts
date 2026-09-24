import 'server-only';
import type { Tx } from '../db';
import { audit } from '../audit';
import { assert } from '../errors';
import type { Actor } from './items';
import { ACCOUNTANT_ROW_CAP, parseKeys } from '@/domain/accountant';

/**
 * Oznaka „poslano knjigovođi" na izlaznim (izdanim) i ulaznim računima.
 * `sent = false` briše oznaku. Svi ključevi moraju pripadati firmi korisnika.
 */
export async function markAccountantSent(tx: Tx, actor: Actor, keys: string[], sent: boolean, at = new Date()) {
  const ids = parseKeys(keys);
  const n = ids.out.length + ids.in.length;
  assert(n > 0, 'Označite barem jedan dokument.');
  assert(ids.out.length <= ACCOUNTANT_ROW_CAP && ids.in.length <= ACCOUNTANT_ROW_CAP, `Najviše ${ACCOUNTANT_ROW_CAP} dokumenata po smjeru odjednom.`);
  const [outFound, inFound] = await Promise.all([
    ids.out.length ? tx.invoice.count({ where: { id: { in: ids.out }, companyId: actor.companyId, status: 'ISSUED' } }) : 0,
    ids.in.length ? tx.supplierInvoice.count({ where: { id: { in: ids.in }, companyId: actor.companyId } }) : 0,
  ]);
  assert(outFound === ids.out.length && inFound === ids.in.length, 'Neki dokumenti ne postoje.');
  const data = { accountantSentAt: sent ? at : null };
  if (ids.out.length) await tx.invoice.updateMany({ where: { id: { in: ids.out }, companyId: actor.companyId }, data });
  if (ids.in.length) await tx.supplierInvoice.updateMany({ where: { id: { in: ids.in }, companyId: actor.companyId }, data });
  await audit(tx, actor, {
    entity: 'accountant',
    action: sent ? 'sent' : 'unsent',
    summary: sent
      ? `${n} dokumenata označeno kao poslano knjigovođi (izlaznih ${ids.out.length}, ulaznih ${ids.in.length})`
      : `${n} dokumenata vraćeno u „nije poslano knjigovođi"`,
    diff: { out: ids.out, in: ids.in },
  });
  return { out: ids.out.length, in: ids.in.length };
}
