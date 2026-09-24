-- AlterTable
ALTER TABLE "ContractItem" ADD COLUMN     "paused" TEXT[] DEFAULT ARRAY[]::TEXT[];
