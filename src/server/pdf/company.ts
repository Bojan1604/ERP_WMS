import 'server-only';
import { db } from '../db';
import { DomainError } from '../errors';
import type { PdfCompany } from './layout';

/** Postavke firme potrebne dokumentima (bez tajni: certifikat, API ključ, SMTP lozinka). */
export async function loadPdfCompany(companyId: string) {
  const c = await db.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      name: true,
      oib: true,
      vatId: true,
      vatRegistered: true,
      address: true,
      zip: true,
      city: true,
      country: true,
      iban: true,
      bank: true,
      swift: true,
      email: true,
      phone: true,
      web: true,
      logo: true,
      invoiceFooter: true,
      legalFooter: true,
      currency: true,
      proformaTitle: true,
      paymentModel: true,
      vatOnPayment: true,
      defaultWarrantyMonths: true,
      eInvoicePaymentMeans: true,
    },
  });
  if (!c) throw new DomainError('Firma ne postoji.');
  const doc: PdfCompany = {
    name: c.name,
    oib: c.oib,
    vatId: c.vatId,
    vatRegistered: c.vatRegistered,
    address: c.address,
    zip: c.zip,
    city: c.city,
    country: c.country,
    iban: c.iban,
    bank: c.bank,
    swift: c.swift,
    email: c.email,
    phone: c.phone,
    web: c.web,
    logo: c.logo,
    invoiceFooter: c.invoiceFooter,
    legalFooter: c.legalFooter,
  };
  return { ...c, doc };
}

export type LoadedCompany = Awaited<ReturnType<typeof loadPdfCompany>>;

/** Oznaka valute na dokumentu. */
export const currencySign = (c: string | null | undefined) => (!c || c === 'EUR' ? '€' : c);
