import type { InvoiceEditorValue } from './invoice-editor';
import type { DeviceOpt, EditorLine, SalesLookups } from './types';
import { customerVat } from '@/domain/tax';
import { unifyDevicePrices } from '@/domain/invoice';
import { addDays, today } from '@/domain/dates';

/**
 * Početne vrijednosti editora (poziva se na poslužitelju i u klijentu):
 * novi račun za kupca, uz po želji unaprijed odabrane uređaje.
 */
export function newInvoiceValue(lookups: SalesLookups, partnerId: string | null, devices: DeviceOpt[] = []): InvoiceEditorValue {
  const { company } = lookups;
  const partner = lookups.partners.find((p) => p.id === partnerId) ?? null;
  const vat = customerVat(partner?.country ?? company.country, company);
  const date = today();
  return {
    id: null,
    type: 'SALE',
    kind: 'INVOICE',
    partnerId: partner?.id ?? null,
    date,
    dueDate: addDays(date, partner?.paymentTermDays ?? company.paymentTermDays),
    deliveryDate: '',
    vatRate: vat.rate,
    taxCategory: vat.category,
    taxExemptReason: vat.exemptReason ?? '',
    discountPct: 0,
    discountAmount: 0,
    advanceAmount: 0,
    charges: [],
    paymentMethod: 'TRANSFER',
    description: '',
    note: '',
    lines: unifyDevicePrices([], devices.map((d, i): EditorLine => ({
      key: `p${i}`,
      kind: 'DEVICE',
      itemId: d.id,
      modelId: d.modelId,
      description: d.model,
      unit: 'kom',
      kpd: d.kpd ?? '',
      qty: 1,
      unitPrice: d.price,
      discountPct: 0,
      warrantyMonths: d.warrantyMonths,
      agreedPrice: d.priceSource === 'agreed',
      serial: d.serial,
      cost: d.cost,
    }))),
  };
}
