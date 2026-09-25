-- QA prodaja: preslika postavki firme na izdanom računu (PDV po naplati, firma u sustavu PDV-a)
-- i uračunati predujmovi s vezom na račun za predujam (BillingReference u eRačunu, zaštita od
-- dvostrukog uračunavanja). Samo dodavanje (nullable stupci, nova tablica) + preslika podataka.
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "sellerVatRegistered" BOOLEAN,
ADD COLUMN     "vatOnPayment" BOOLEAN;

-- CreateTable
CREATE TABLE "AdvanceUse" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvanceUse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvanceUse_invoiceId_idx" ON "AdvanceUse"("invoiceId");

-- CreateIndex
CREATE INDEX "AdvanceUse_advanceId_idx" ON "AdvanceUse"("advanceId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvanceUse_invoiceId_advanceId_key" ON "AdvanceUse"("invoiceId", "advanceId");

-- AddForeignKey
ALTER TABLE "AdvanceUse" ADD CONSTRAINT "AdvanceUse_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvanceUse" ADD CONSTRAINT "AdvanceUse_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preslika: već izdani računi zadržavaju postavke firme kakve su sada (najbolja dostupna procjena
-- stanja u trenutku izdavanja); nacrti ostaju null i prate postavke firme do izdavanja.
UPDATE "Invoice" i
SET "sellerVatRegistered" = c."vatRegistered",
    "vatOnPayment" = c."vatOnPayment"
FROM "Company" c
WHERE c.id = i."companyId" AND i.status = 'ISSUED' AND i."sellerVatRegistered" IS NULL;
