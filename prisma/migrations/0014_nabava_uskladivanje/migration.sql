-- Nabava: jedno pravilo troška robe po narudžbenici (reconcileOrderGoodsExpense, services/goods-expense.ts).
-- Usklađivanje se ponavlja nakon svake promjene, pa odluka „Knjiži kao trošak" s računa mora biti trajna
-- (prije se čuvala samo postojanjem troška). Samo dodavanje + preslika, iznosi troškova se ne mijenjaju.
-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN "bookExpense" BOOLEAN NOT NULL DEFAULT true;

-- Preslika: prihvaćen račun bez vlastitog troška kojeg ne pokriva trošak primke (račun za robu uz
-- knjiženu primku) korisnik nije knjižio — to ostaje tako.
UPDATE "SupplierInvoice" s
SET "bookExpense" = false
WHERE s."status" = 'ACCEPTED'
  AND NOT EXISTS (SELECT 1 FROM "Expense" e WHERE e."supplierInvoiceId" = s."id")
  AND NOT (
    s."goodsInvoice" = true AND EXISTS (
      SELECT 1 FROM "Expense" e JOIN "GoodsReceipt" r ON r."id" = e."receiptId"
      WHERE r."status" = 'POSTED' AND (r."id" = s."receiptId" OR (s."orderId" IS NOT NULL AND r."orderId" = s."orderId"))
    )
  );
