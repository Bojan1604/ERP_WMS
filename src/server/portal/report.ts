import 'server-only';
import type { Tx } from '../db';
import { assert } from '../errors';
import { audit } from '../audit';
import { createServiceOrder } from '../services/service';
import { addAttachments } from '../services/attachments';
import { deviceWarrantyEnd } from '../queries/service';
import { portalActor, type PortalScope } from './session';
import { PORTAL_MAX_PHOTOS } from '@/domain/portal';
import { isImageMime, sniffMime } from '@/domain/attachments';
import { today } from '@/domain/dates';

export interface FaultReportInput {
  itemId: string;
  issue: string;
  contact: string | null;
}

/**
 * Prijava kvara s portala: servisni nalog statusa „Prijavljeno" (REPORTED),
 * izvor PORTAL, s kontaktom i do 4 fotografije (prilozi naloga). Uređaj mora
 * biti klijentov i aktivan; status uređaja se ne mijenja — to radi servis
 * kad uređaj zaprimi.
 */
export async function reportFault(tx: Tx, scope: PortalScope & { partnerName?: string }, input: FaultReportInput, photos: Array<{ fileName: string | null; data: Uint8Array<ArrayBuffer> }> = []) {
  const actor = portalActor(scope);
  const issue = input.issue.trim();
  assert(issue, 'Opišite kvar.');
  assert(photos.length <= PORTAL_MAX_PHOTOS, `Najviše ${PORTAL_MAX_PHOTOS} fotografije.`);
  for (const p of photos) {
    const mime = sniffMime(p.data);
    assert(mime && isImageMime(mime), `Datoteka „${p.fileName ?? ''}" nije slika (JPEG, PNG, WebP).`);
  }
  const item = await tx.item.findFirst({
    where: { id: input.itemId, companyId: scope.companyId, partnerId: scope.partnerId, state: { notIn: ['IN_STOCK', 'WRITTEN_OFF'] } },
    select: { id: true, serial: true, warrantyStart: true, issueDate: true, warrantyMonths: true, model: { select: { warrantyMonths: true } } },
  });
  assert(item, 'Uređaj ne postoji.');
  const end = deviceWarrantyEnd(item);
  const contact = input.contact?.trim() || null;

  const order = await createServiceOrder(tx, actor, {
    itemId: item.id,
    issue,
    reportedAt: today(),
    status: 'REPORTED',
    underWarranty: !!end && end >= today(),
    note: `Prijava s portala · ${scope.name || scope.email}${contact ? ` · kontakt: ${contact}` : ''}`,
    setServiceStatus: false,
  });
  await tx.serviceOrder.update({ where: { id: order.id }, data: { source: 'PORTAL', portalUserId: scope.id, contact } });
  // fotografije koje je poslao klijent vidi i on na portalu
  if (photos.length) await addAttachments(tx, actor, 'serviceOrder', order.id, photos, { public: true });
  await audit(tx, actor, {
    entity: 'service',
    entityId: order.id,
    action: 'portal',
    summary: `Kvar prijavljen s portala: ${item.serial}${scope.partnerName ? ` (${scope.partnerName})` : ''}${photos.length ? ` · ${photos.length} fotografij${photos.length === 1 ? 'a' : 'e'}` : ''}`,
  });
  return order;
}
