-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "closedAt" DATE,
ADD COLUMN     "pausedSince" DATE;

-- AlterTable
ALTER TABLE "ContractItem" ADD COLUMN     "pausedSince" DATE;

-- CreateTable
CREATE TABLE "ReturnedContractItem" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "monthly" DECIMAL(14,2) NOT NULL,
    "plan" JSONB NOT NULL DEFAULT '[]',
    "skipped" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "paused" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "endDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnedContractItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnedContractItem_contractId_idx" ON "ReturnedContractItem"("contractId");

-- CreateIndex
CREATE INDEX "ReturnedContractItem_itemId_idx" ON "ReturnedContractItem"("itemId");

-- AddForeignKey
ALTER TABLE "ReturnedContractItem" ADD CONSTRAINT "ReturnedContractItem_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnedContractItem" ADD CONSTRAINT "ReturnedContractItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

