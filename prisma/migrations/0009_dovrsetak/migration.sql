-- Dovršetak prijenosa: indeksi za nove filtre i sortiranja, paketi (Marže → Paketi), naslov predračuna
-- po dokumentu, zaštita TOTP koda od ponovne uporabe, promjena naplate najma s računa, prilozi vidljivi
-- klijentu na portalu, početak automatskog izdavanja rata, pokušaji prijave (ograničenje).
-- Samo dodavanje (novi stupci su nullable ili sa zadanom vrijednošću, nove tablice, indeksi) + preslike podataka.
-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "autoIssueSince" DATE;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpLastStep" INTEGER;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "rentNextBilling" "Billing",
ADD COLUMN     "rentNextFrom" DATE;

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "public" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(14,2),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackageItem" (
    "packageId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PackageItem_pkey" PRIMARY KEY ("packageId","itemId")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Package_companyId_createdAt_idx" ON "Package"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "PackageItem_itemId_idx" ON "PackageItem"("itemId");

-- CreateIndex
CREATE INDEX "LoginAttempt_key_at_idx" ON "LoginAttempt"("key", "at");

-- CreateIndex
CREATE INDEX "Partner_email_trgm_idx" ON "Partner" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Item_companyId_importDate_idx" ON "Item"("companyId", "importDate");

-- CreateIndex
CREATE INDEX "Item_companyId_issueDate_idx" ON "Item"("companyId", "issueDate");

-- CreateIndex (silazno, prazni na kraju — Prisma ne zna NULLS LAST, pa je upisano ručno)
CREATE INDEX "Item_companyId_importDate_desc_idx" ON "Item"("companyId", "importDate" DESC NULLS LAST);

-- CreateIndex
CREATE INDEX "Item_companyId_issueDate_desc_idx" ON "Item"("companyId", "issueDate" DESC NULLS LAST);

-- CreateIndex
CREATE INDEX "Item_companyId_cost_idx" ON "Item"("companyId", "cost");

-- CreateIndex
CREATE INDEX "Item_companyId_state_issueDate_idx" ON "Item"("companyId", "state", "issueDate");

-- CreateIndex
CREATE INDEX "Item_companyId_partnerId_issueDate_idx" ON "Item"("companyId", "partnerId", "issueDate");

-- CreateIndex
CREATE INDEX "Item_companyId_cpu_idx" ON "Item"("companyId", "cpu");

-- CreateIndex
CREATE INDEX "Item_companyId_screen_idx" ON "Item"("companyId", "screen");

-- CreateIndex
CREATE INDEX "Item_companyId_os_idx" ON "Item"("companyId", "os");

-- CreateIndex
CREATE INDEX "Invoice_companyId_dueDate_idx" ON "Invoice"("companyId", "dueDate");

-- CreateIndex
CREATE INDEX "InvoiceLine_description_trgm_idx" ON "InvoiceLine" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Contract_companyId_startDate_idx" ON "Contract"("companyId", "startDate");

-- CreateIndex
CREATE INDEX "Contract_companyId_endDate_idx" ON "Contract"("companyId", "endDate");

-- CreateIndex
CREATE INDEX "PurchaseOrder_companyId_date_idx" ON "PurchaseOrder"("companyId", "date");

-- CreateIndex
CREATE INDEX "ServiceOrder_companyId_reportedAt_idx" ON "ServiceOrder"("companyId", "reportedAt");

-- CreateIndex
CREATE INDEX "ServiceOrder_companyId_partnerId_reportedAt_idx" ON "ServiceOrder"("companyId", "partnerId", "reportedAt");

-- CreateIndex
CREATE INDEX "EmailLog_to_trgm_idx" ON "EmailLog" USING GIN ("to" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "EmailLog_subject_trgm_idx" ON "EmailLog" USING GIN ("subject" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackageItem" ADD CONSTRAINT "PackageItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Fotografije koje je klijent sam poslao s portala (prijava kvara) ostaju mu vidljive.
UPDATE "Attachment" a SET "public" = true
FROM "ServiceOrder" so
WHERE a."entity" = 'serviceOrder' AND a."entityId" = so."id" AND so."source" = 'PORTAL' AND a."createdBy" LIKE '% (portal)';

-- Preslika: paketi su se prije spremali kao ponude (nacrt) s napomenom „Paket: <naziv>".
-- Ponude ostaju; iz njih se stvaraju paketi s istim uređajima i cijenom (osnovica ponude).
INSERT INTO "Package" ("id", "companyId", "name", "price", "note", "createdBy", "createdAt", "updatedAt")
SELECT 'pkg' || q."id", q."companyId",
       left(btrim(substring(split_part(q."note", E'\n', 1) FROM 8)), 200),
       q."netTotal",
       CASE WHEN position(E'\n' IN q."note") > 0 THEN NULLIF(btrim(substring(q."note" FROM position(E'\n' IN q."note") + 1)), '') END,
       q."createdBy", q."createdAt", q."updatedAt"
FROM "Quote" q
WHERE q."note" LIKE 'Paket: %'
  AND btrim(substring(split_part(q."note", E'\n', 1) FROM 8)) <> ''
  AND EXISTS (SELECT 1 FROM "QuoteLine" l WHERE l."quoteId" = q."id" AND l."kind" = 'DEVICE' AND l."itemId" IS NOT NULL);

INSERT INTO "PackageItem" ("packageId", "itemId", "sort")
SELECT 'pkg' || l."quoteId", l."itemId", min(l."sort")
FROM "QuoteLine" l
JOIN "Package" p ON p."id" = 'pkg' || l."quoteId"
WHERE l."kind" = 'DEVICE' AND l."itemId" IS NOT NULL
GROUP BY 1, 2;

-- Firme koje već imaju automatsko izdavanje: rate se izdaju od danas (bez zaostataka).
UPDATE "Company" SET "autoIssueSince" = CURRENT_DATE WHERE "autoIssueRent" = true AND "autoIssueSince" IS NULL;
