-- QA nabava: trajna odluka „Ovo je račun za robu s primke" na ulaznom računu (prije se računala
-- iznova pri svakom spremanju/prihvaćanju/knjiženju i nije se pamtila). Samo dodavanje + preslika.
-- AlterTable
ALTER TABLE "SupplierInvoice" ADD COLUMN "goodsInvoice" BOOLEAN;

-- Preslika: povezan račun bez vlastitog troška je račun za robu (trošak nosi primka ili se ne knjiži);
-- povezan račun s vlastitim troškom je račun za robu samo ako osnovica odgovara vrijednosti
-- narudžbenice ili primke (±1 % ili 1 €) — inače je prijevoz / dodatni trošak.
UPDATE "SupplierInvoice" s
SET "goodsInvoice" = CASE
  WHEN NOT EXISTS (SELECT 1 FROM "Expense" e WHERE e."supplierInvoiceId" = s."id") THEN TRUE
  WHEN EXISTS (
    SELECT 1 FROM "PurchaseOrder" o
    WHERE o."id" = s."orderId" AND o."total" > 0 AND ABS(s."netAmount" - o."total") <= GREATEST(1, o."total" * 0.01)
  ) OR EXISTS (
    SELECT 1 FROM "GoodsReceipt" r
    WHERE r."id" = s."receiptId" AND r."total" > 0 AND ABS(s."netAmount" - r."total") <= GREATEST(1, r."total" * 0.01)
  ) THEN TRUE
  ELSE FALSE
END
WHERE s."orderId" IS NOT NULL OR s."receiptId" IS NOT NULL;
