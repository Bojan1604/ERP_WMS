-- Knjigovođa: oznaka predaje računa knjigovođi i e-adresa knjigovođe

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "accountantEmail" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "accountantSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "accountantSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Invoice_companyId_accountantSentAt_idx" ON "Invoice"("companyId", "accountantSentAt");

-- CreateIndex
CREATE INDEX "SupplierInvoice_companyId_accountantSentAt_idx" ON "SupplierInvoice"("companyId", "accountantSentAt");

