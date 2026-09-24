-- CreateEnum
CREATE TYPE "SupplierInvoiceSource" AS ENUM ('MANUAL', 'EINVOICE');

-- CreateEnum
CREATE TYPE "SupplierInvoiceStatus" AS ENUM ('RECEIVED', 'ACCEPTED', 'REJECTED');

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "eInvoiceEnv" TEXT,
ADD COLUMN     "eInvoiceId" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "source" "SupplierInvoiceSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "status" "SupplierInvoiceStatus" NOT NULL DEFAULT 'ACCEPTED',
ADD COLUMN     "statusAt" TIMESTAMP(3),
ADD COLUMN     "statusBy" TEXT;

-- CreateIndex
CREATE INDEX "SupplierInvoice_companyId_status_idx" ON "SupplierInvoice"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierInvoice_companyId_eInvoiceId_key" ON "SupplierInvoice"("companyId", "eInvoiceId");

