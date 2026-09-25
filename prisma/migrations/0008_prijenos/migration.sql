-- CreateEnum
CREATE TYPE "QuoteKind" AS ENUM ('QUOTE', 'PROFORMA');

-- CreateEnum
CREATE TYPE "ServiceSource" AS ENUM ('INTERNAL', 'PORTAL');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SENT', 'FAILED');

-- AlterEnum
ALTER TYPE "Series" ADD VALUE 'PROFORMA';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "autoBackup" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autoIssueRent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "backupKeep" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "backupReminderDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "eInvoiceAttachPdf" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "eInvoicePaymentMeans" TEXT NOT NULL DEFAULT '30',
ADD COLUMN     "eReportingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kpdRent" TEXT,
ADD COLUMN     "kpdSale" TEXT,
ADD COLUMN     "kpdService" TEXT,
ADD COLUMN     "lastBackupAt" TIMESTAMP(3),
ADD COLUMN     "legalFooter" TEXT,
ADD COLUMN     "mailBccSelf" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mailFrom" TEXT,
ADD COLUMN     "mailReplyTo" TEXT,
ADD COLUMN     "mailTemplates" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "operatorName" TEXT,
ADD COLUMN     "operatorOib" TEXT,
ADD COLUMN     "paymentModel" TEXT NOT NULL DEFAULT 'HR00',
ADD COLUMN     "proformaTitle" TEXT NOT NULL DEFAULT 'Predračun',
ADD COLUMN     "smtpHost" TEXT,
ADD COLUMN     "smtpPassword" TEXT,
ADD COLUMN     "smtpPort" INTEGER,
ADD COLUMN     "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smtpUser" TEXT,
ADD COLUMN     "swift" TEXT,
ADD COLUMN     "vatOnPayment" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "vatTextEuGoods" TEXT,
ADD COLUMN     "vatTextEuService" TEXT,
ADD COLUMN     "vatTextThirdGoods" TEXT,
ADD COLUMN     "vatTextThirdService" TEXT;

-- AlterTable
ALTER TABLE "DeviceModel" ADD COLUMN     "cpu" TEXT,
ADD COLUMN     "kpdRent" TEXT,
ADD COLUMN     "os" TEXT,
ADD COLUMN     "screen" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "eInvoiceStatus" TEXT,
ADD COLUMN     "eInvoiceStatusAt" TIMESTAMP(3),
ADD COLUMN     "eReportedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InvoiceLine" ADD COLUMN     "lineType" "InvoiceType";

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "cpu" TEXT,
ADD COLUMN     "os" TEXT,
ADD COLUMN     "screen" TEXT;

-- AlterTable
ALTER TABLE "Partner" ADD COLUMN     "branchCode" TEXT,
ADD COLUMN     "branchName" TEXT,
ADD COLUMN     "endpointId" TEXT,
ADD COLUMN     "vatCategoryOverride" TEXT;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "supplierInvoiceCurrency" TEXT,
ADD COLUMN     "supplierInvoiceDate" DATE,
ADD COLUMN     "supplierInvoiceDueDate" DATE,
ADD COLUMN     "supplierInvoiceNet" DECIMAL(14,2),
ADD COLUMN     "supplierInvoiceNo" TEXT,
ADD COLUMN     "supplierInvoiceTotal" DECIMAL(14,2),
ADD COLUMN     "supplierInvoiceVat" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "kind" "QuoteKind" NOT NULL DEFAULT 'QUOTE';

-- AlterTable
ALTER TABLE "QuoteLine" ADD COLUMN     "lineType" "InvoiceType",
ADD COLUMN     "monthly" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "ServiceOrder" ADD COLUMN     "contact" TEXT,
ADD COLUMN     "portalUserId" TEXT,
ADD COLUMN     "source" "ServiceSource" NOT NULL DEFAULT 'INTERNAL';

-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'EUR',
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "receiptId" TEXT,
ADD COLUMN     "supplierName" TEXT,
ADD COLUMN     "supplierOib" TEXT,
ADD COLUMN     "vatPct" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "backupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "canDanger" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "requireApproval" BOOLEAN,
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecret" TEXT;

-- CreateTable
CREATE TABLE "UserCompany" (
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserCompany_pkey" PRIMARY KEY ("userId","companyId")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT,
    "to" TEXT NOT NULL,
    "cc" TEXT,
    "subject" TEXT NOT NULL,
    "status" "EmailStatus" NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "sentBy" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalUser" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PortalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PortalSession" (
    "id" TEXT NOT NULL,
    "portalUserId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserCompany_companyId_idx" ON "UserCompany"("companyId");

-- CreateIndex
CREATE INDEX "EmailLog_companyId_at_idx" ON "EmailLog"("companyId", "at");

-- CreateIndex
CREATE INDEX "EmailLog_companyId_kind_entityId_idx" ON "EmailLog"("companyId", "kind", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalUser_email_key" ON "PortalUser"("email");

-- CreateIndex
CREATE INDEX "PortalUser_companyId_idx" ON "PortalUser"("companyId");

-- CreateIndex
CREATE INDEX "PortalUser_partnerId_idx" ON "PortalUser"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "PortalSession_tokenHash_key" ON "PortalSession"("tokenHash");

-- CreateIndex
CREATE INDEX "PortalSession_portalUserId_idx" ON "PortalSession"("portalUserId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_eInvoiceStatus_idx" ON "Invoice"("companyId", "eInvoiceStatus");

-- CreateIndex
CREATE INDEX "Item_categoryId_idx" ON "Item"("categoryId");

-- CreateIndex
CREATE INDEX "Quote_companyId_kind_date_idx" ON "Quote"("companyId", "kind", "date");

-- CreateIndex
CREATE INDEX "Quote_contractId_idx" ON "Quote"("contractId");

-- CreateIndex
CREATE INDEX "ServiceOrder_companyId_source_status_idx" ON "ServiceOrder"("companyId", "source", "status");

-- CreateIndex
CREATE INDEX "ServiceOrder_portalUserId_idx" ON "ServiceOrder"("portalUserId");

-- CreateIndex
CREATE INDEX "SupplierInvoice_orderId_idx" ON "SupplierInvoice"("orderId");

-- CreateIndex
CREATE INDEX "SupplierInvoice_receiptId_idx" ON "SupplierInvoice"("receiptId");

-- CreateIndex
CREATE INDEX "User_companyId_lastSeenAt_idx" ON "User"("companyId", "lastSeenAt");

-- AddForeignKey
ALTER TABLE "UserCompany" ADD CONSTRAINT "UserCompany_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCompany" ADD CONSTRAINT "UserCompany_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quote" ADD CONSTRAINT "Quote_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierInvoice" ADD CONSTRAINT "SupplierInvoice_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "GoodsReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceOrder" ADD CONSTRAINT "ServiceOrder_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalUser" ADD CONSTRAINT "PortalUser_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalUser" ADD CONSTRAINT "PortalUser_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PortalSession" ADD CONSTRAINT "PortalSession_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Preslika stanja eRačuna iz JSON-a u stupac za filtre popisa (postojeći poslani računi)
UPDATE "Invoice"
SET "eInvoiceStatus" = CASE WHEN "eInvoice"->>'status' = 'SENT' THEN 'SENT' ELSE 'ERROR' END,
    "eInvoiceStatusAt" = "updatedAt"
WHERE "eInvoice"->>'route' = 'EINVOICE' AND "eInvoice"->>'status' IN ('SENT', 'FAILED', 'UNKNOWN');
