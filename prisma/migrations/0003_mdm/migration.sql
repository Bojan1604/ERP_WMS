-- CreateEnum
CREATE TYPE "MdmOrgType" AS ENUM ('DISTRIBUTOR', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "MdmPlatform" AS ENUM ('ANDROID', 'WINDOWS');

-- CreateEnum
CREATE TYPE "MdmDeviceStatus" AS ENUM ('PENDING', 'ENROLLED', 'RETIRED');

-- CreateEnum
CREATE TYPE "MdmCommandStatus" AS ENUM ('PENDING', 'SENT', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Role" ADD VALUE 'DISTRIBUTOR';
ALTER TYPE "Role" ADD VALUE 'CLIENT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "mdmOrgId" TEXT;

-- CreateTable
CREATE TABLE "MdmOrg" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "parentId" TEXT,
    "type" "MdmOrgType" NOT NULL,
    "name" TEXT NOT NULL,
    "oib" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "city" TEXT,
    "partnerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MdmOrg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmSite" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Zagreb',
    "profileId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MdmSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmDevice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orgId" TEXT,
    "siteId" TEXT,
    "platform" "MdmPlatform" NOT NULL,
    "status" "MdmDeviceStatus" NOT NULL DEFAULT 'PENDING',
    "name" TEXT NOT NULL,
    "enrollCode" TEXT,
    "tokenHash" TEXT NOT NULL,
    "serial" TEXT,
    "hardwareId" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "osVersion" TEXT,
    "agentVersion" TEXT,
    "imei" TEXT,
    "macAddress" TEXT,
    "ipAddress" TEXT,
    "publicIp" TEXT,
    "wifiSsid" TEXT,
    "wifiSignal" INTEGER,
    "batteryLevel" INTEGER,
    "charging" BOOLEAN,
    "storageFreeMb" INTEGER,
    "storageTotalMb" INTEGER,
    "ramTotalMb" INTEGER,
    "uptimeSec" INTEGER,
    "telemetry" JSONB NOT NULL DEFAULT '{}',
    "lastSeenAt" TIMESTAMP(3),
    "onlineSince" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3),
    "profileId" TEXT,
    "appliedConfigVersion" INTEGER NOT NULL DEFAULT 0,
    "configVersion" INTEGER NOT NULL DEFAULT 0,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "maintenancePin" TEXT,
    "notes" TEXT,
    "itemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MdmDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orgId" TEXT,
    "name" TEXT NOT NULL,
    "platform" "MdmPlatform" NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "apps" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MdmProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmApp" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orgId" TEXT,
    "platform" "MdmPlatform" NOT NULL,
    "name" TEXT NOT NULL,
    "packageName" TEXT NOT NULL,
    "description" TEXT,
    "installArgs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MdmApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmAppVersion" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "versionCode" INTEGER,
    "fileId" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MdmAppVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmFile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orgId" TEXT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MdmFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmCommand" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "MdmCommandStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "MdmCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmEvent" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "MdmEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmUpload" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MdmUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MdmEnrollToken" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "siteId" TEXT,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MdmEnrollToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MdmOrg_companyId_type_idx" ON "MdmOrg"("companyId", "type");

-- CreateIndex
CREATE INDEX "MdmOrg_parentId_idx" ON "MdmOrg"("parentId");

-- CreateIndex
CREATE INDEX "MdmOrg_partnerId_idx" ON "MdmOrg"("partnerId");

-- CreateIndex
CREATE INDEX "MdmSite_orgId_idx" ON "MdmSite"("orgId");

-- CreateIndex
CREATE INDEX "MdmSite_profileId_idx" ON "MdmSite"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "MdmDevice_tokenHash_key" ON "MdmDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "MdmDevice_companyId_status_idx" ON "MdmDevice"("companyId", "status");

-- CreateIndex
CREATE INDEX "MdmDevice_orgId_idx" ON "MdmDevice"("orgId");

-- CreateIndex
CREATE INDEX "MdmDevice_siteId_idx" ON "MdmDevice"("siteId");

-- CreateIndex
CREATE INDEX "MdmDevice_profileId_idx" ON "MdmDevice"("profileId");

-- CreateIndex
CREATE INDEX "MdmDevice_itemId_idx" ON "MdmDevice"("itemId");

-- CreateIndex
CREATE INDEX "MdmDevice_companyId_serial_idx" ON "MdmDevice"("companyId", "serial");

-- CreateIndex
CREATE INDEX "MdmDevice_companyId_lastSeenAt_idx" ON "MdmDevice"("companyId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "MdmDevice_companyId_enrollCode_idx" ON "MdmDevice"("companyId", "enrollCode");

-- CreateIndex
CREATE INDEX "MdmDevice_companyId_hardwareId_idx" ON "MdmDevice"("companyId", "hardwareId");

-- CreateIndex
CREATE INDEX "MdmDevice_name_trgm_idx" ON "MdmDevice" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "MdmDevice_serial_trgm_idx" ON "MdmDevice" USING GIN ("serial" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "MdmDevice_imei_trgm_idx" ON "MdmDevice" USING GIN ("imei" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "MdmProfile_companyId_orgId_idx" ON "MdmProfile"("companyId", "orgId");

-- CreateIndex
CREATE INDEX "MdmApp_companyId_orgId_idx" ON "MdmApp"("companyId", "orgId");

-- CreateIndex
CREATE UNIQUE INDEX "MdmApp_companyId_platform_packageName_orgId_key" ON "MdmApp"("companyId", "platform", "packageName", "orgId");

-- CreateIndex
CREATE INDEX "MdmAppVersion_fileId_idx" ON "MdmAppVersion"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "MdmAppVersion_appId_version_key" ON "MdmAppVersion"("appId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "MdmFile_storageKey_key" ON "MdmFile"("storageKey");

-- CreateIndex
CREATE INDEX "MdmFile_companyId_kind_idx" ON "MdmFile"("companyId", "kind");

-- CreateIndex
CREATE INDEX "MdmFile_orgId_idx" ON "MdmFile"("orgId");

-- CreateIndex
CREATE INDEX "MdmCommand_deviceId_status_idx" ON "MdmCommand"("deviceId", "status");

-- CreateIndex
CREATE INDEX "MdmCommand_deviceId_createdAt_idx" ON "MdmCommand"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "MdmEvent_deviceId_at_idx" ON "MdmEvent"("deviceId", "at");

-- CreateIndex
CREATE INDEX "MdmUpload_deviceId_kind_at_idx" ON "MdmUpload"("deviceId", "kind", "at");

-- CreateIndex
CREATE INDEX "MdmUpload_fileId_idx" ON "MdmUpload"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "MdmEnrollToken_token_key" ON "MdmEnrollToken"("token");

-- CreateIndex
CREATE INDEX "MdmEnrollToken_orgId_idx" ON "MdmEnrollToken"("orgId");

-- CreateIndex
CREATE INDEX "MdmEnrollToken_siteId_idx" ON "MdmEnrollToken"("siteId");

-- CreateIndex
CREATE INDEX "User_mdmOrgId_idx" ON "User"("mdmOrgId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_mdmOrgId_fkey" FOREIGN KEY ("mdmOrgId") REFERENCES "MdmOrg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmOrg" ADD CONSTRAINT "MdmOrg_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmOrg" ADD CONSTRAINT "MdmOrg_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MdmOrg"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmOrg" ADD CONSTRAINT "MdmOrg_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmSite" ADD CONSTRAINT "MdmSite_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "MdmOrg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmSite" ADD CONSTRAINT "MdmSite_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "MdmProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmDevice" ADD CONSTRAINT "MdmDevice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmDevice" ADD CONSTRAINT "MdmDevice_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "MdmOrg"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmDevice" ADD CONSTRAINT "MdmDevice_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "MdmSite"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmDevice" ADD CONSTRAINT "MdmDevice_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "MdmProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmDevice" ADD CONSTRAINT "MdmDevice_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmProfile" ADD CONSTRAINT "MdmProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmProfile" ADD CONSTRAINT "MdmProfile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "MdmOrg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmApp" ADD CONSTRAINT "MdmApp_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmApp" ADD CONSTRAINT "MdmApp_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "MdmOrg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmAppVersion" ADD CONSTRAINT "MdmAppVersion_appId_fkey" FOREIGN KEY ("appId") REFERENCES "MdmApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmAppVersion" ADD CONSTRAINT "MdmAppVersion_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MdmFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmFile" ADD CONSTRAINT "MdmFile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmFile" ADD CONSTRAINT "MdmFile_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "MdmOrg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmCommand" ADD CONSTRAINT "MdmCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "MdmDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmEvent" ADD CONSTRAINT "MdmEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "MdmDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmUpload" ADD CONSTRAINT "MdmUpload_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "MdmDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmUpload" ADD CONSTRAINT "MdmUpload_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "MdmFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmEnrollToken" ADD CONSTRAINT "MdmEnrollToken_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmEnrollToken" ADD CONSTRAINT "MdmEnrollToken_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "MdmOrg"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MdmEnrollToken" ADD CONSTRAINT "MdmEnrollToken_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "MdmSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Zajednička aplikacija (orgId NULL) smije postojati samo jednom po paketu;
-- obični UNIQUE NULL vrijednosti smatra različitima.
CREATE UNIQUE INDEX "MdmApp_shared_package_key" ON "MdmApp" ("companyId", "platform", "packageName") WHERE "orgId" IS NULL;
