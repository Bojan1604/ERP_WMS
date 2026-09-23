-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('TRANSFER', 'CASH', 'CARD', 'OTHER');

-- CreateEnum
CREATE TYPE "FiscalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "StocktakeStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
ALTER TYPE "RequestKind" ADD VALUE 'RECEIVE';

-- AlterEnum
ALTER TYPE "Series" ADD VALUE 'STOCKTAKE';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "eInvoiceApiKey" TEXT,
ADD COLUMN     "eInvoiceProvider" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "fiscalCert" BYTEA,
ADD COLUMN     "fiscalCertInfo" JSONB,
ADD COLUMN     "fiscalCertPassword" TEXT,
ADD COLUMN     "fiscalEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "fiscalEnv" TEXT NOT NULL DEFAULT 'TEST',
ADD COLUMN     "fiscalSequenceMode" TEXT NOT NULL DEFAULT 'P';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "fiscalAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fiscalError" TEXT,
ADD COLUMN     "fiscalStatus" "FiscalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "fiscalizedAt" TIMESTAMP(3),
ADD COLUMN     "jir" TEXT,
ADD COLUMN     "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'TRANSFER',
ADD COLUMN     "zki" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "oib" TEXT;

-- CreateTable
CREATE TABLE "FiscalLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "kind" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "request" TEXT,
    "response" TEXT,
    "error" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stocktake" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "warehouseId" TEXT,
    "status" "StocktakeStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "createdBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),
    "summary" JSONB,

    CONSTRAINT "Stocktake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StocktakeScan" (
    "id" TEXT NOT NULL,
    "stocktakeId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "itemId" TEXT,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scannedBy" TEXT,

    CONSTRAINT "StocktakeScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FiscalLog_companyId_at_idx" ON "FiscalLog"("companyId", "at");

-- CreateIndex
CREATE INDEX "FiscalLog_invoiceId_idx" ON "FiscalLog"("invoiceId");

-- CreateIndex
CREATE INDEX "Stocktake_companyId_status_idx" ON "Stocktake"("companyId", "status");

-- CreateIndex
CREATE INDEX "Stocktake_warehouseId_idx" ON "Stocktake"("warehouseId");

-- CreateIndex
CREATE UNIQUE INDEX "Stocktake_companyId_number_key" ON "Stocktake"("companyId", "number");

-- CreateIndex
CREATE INDEX "StocktakeScan_itemId_idx" ON "StocktakeScan"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "StocktakeScan_stocktakeId_serial_key" ON "StocktakeScan"("stocktakeId", "serial");

-- AddForeignKey
ALTER TABLE "FiscalLog" ADD CONSTRAINT "FiscalLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stocktake" ADD CONSTRAINT "Stocktake_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StocktakeScan" ADD CONSTRAINT "StocktakeScan_stocktakeId_fkey" FOREIGN KEY ("stocktakeId") REFERENCES "Stocktake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

