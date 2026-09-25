import type { InvoiceEditorValue } from './invoice-editor';
import type { DeviceOpt, EditorLine, SalesLookups } from './types';
import { customerVat } from '@/domain/tax';
import { unifyDevicePrices } from '@/domain/invoice';
import { addDays, today } from '@/domain/dates';
import { autoKpd, deviceToLine } from './line-tools';

/**
 * Početne vrijednosti editora (poziva se na poslužitelju i u klijentu):
 * novi račun za kupca, uz po želji unaprijed odabrane uređaje. Uz `type: 'RENT'`
 * uređaji idu kao stavke najma (mjesečna cijena), a račun traži ugovor.
 */
export function newInvoiceValue(lookups: SalesLookups, partnerId: string | null, devices: DeviceOpt[] = [], type: 'SALE' | 'RENT' = 'SALE'): InvoiceEditorValue {
  const { company, models } = lookups;
  const partner = lookups.partners.find((p) => p.id === partnerId) ?? null;
  // tretman prema vrsti računa: najam je usluga (strani kupac: čl. 17., ne čl. 41./45.)
  const vat = customerVat(partner ?? company.country, company, type);
  const date = today();
  const lines: EditorLine[] =
    type === 'RENT'
      ? devices.map((d, i) => ({ ...deviceToLine(d, { lineType: 'RENT', months: 1, company, models, docType: 'RENT' }), key: `p${i}` }))
      : unifyDevicePrices(
          [],
          devices.map((d, i): EditorLine => ({
            key: `p${i}`,
            kind: 'DEVICE',
            itemId: d.id,
            modelId: d.modelId,
            description: d.model,
            unit: 'kom',
            kpd: d.kpd ?? autoKpd({ kind: 'DEVICE', modelId: d.modelId }, 'SALE', company, models),
            qty: 1,
            unitPrice: d.price,
            discountPct: 0,
            warrantyMonths: d.warrantyMonths,
            agreedPrice: d.priceSource === 'agreed',
            serial: d.serial,
            cost: d.cost,
            suggestSale: d.price,
            suggestRent: d.rent ?? null,
          })),
        );
  return {
    id: null,
    type,
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
    advances: [],
    charges: [],
    paymentMethod: 'TRANSFER',
    description: '',
    note: '',
    lines,
    contractId: null,
    period: '',
    rent: { startDate: date, billing: 'MONTHLY', months: 24, seasonFrom: null, seasonTo: null },
  };
}
