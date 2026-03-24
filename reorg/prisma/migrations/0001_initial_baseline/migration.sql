-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TPP_EBAY', 'TT_EBAY', 'BIGCOMMERCE', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('STAGED', 'PUSHED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PushJobStatus" AS ENUM ('PENDING', 'DRY_RUN', 'CONFIRMED', 'EXECUTING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('DAILY', 'MANUAL', 'PRE_PUSH');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'OUT_OF_STOCK');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'OPERATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "writeLocked" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "master_rows" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "alternateTitles" JSONB NOT NULL DEFAULT '[]',
    "imageUrl" TEXT,
    "imageSource" TEXT,
    "upc" TEXT,
    "weight" TEXT,
    "weightDisplay" TEXT,
    "weightOz" DOUBLE PRECISION,
    "supplierCost" DOUBLE PRECISION,
    "supplierShipping" DOUBLE PRECISION,
    "shippingCostOverride" DOUBLE PRECISION,
    "platformFeeRate" DOUBLE PRECISION NOT NULL DEFAULT 0.136,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_listings" (
    "id" TEXT NOT NULL,
    "masterRowId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "platformItemId" TEXT NOT NULL,
    "platformVariantId" TEXT,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "imageUrl" TEXT,
    "salePrice" DOUBLE PRECISION,
    "adRate" DOUBLE PRECISION,
    "inventory" INTEGER,
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "isVariation" BOOLEAN NOT NULL DEFAULT false,
    "parentListingId" TEXT,
    "rawData" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unmatched_listings" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "platformItemId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT,
    "rawData" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unmatched_listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staged_changes" (
    "id" TEXT NOT NULL,
    "masterRowId" TEXT NOT NULL,
    "marketplaceListingId" TEXT,
    "field" TEXT NOT NULL,
    "stagedValue" TEXT NOT NULL,
    "liveValue" TEXT,
    "changedById" TEXT NOT NULL,
    "status" "ChangeStatus" NOT NULL DEFAULT 'STAGED',
    "pushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staged_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping_rates" (
    "id" TEXT NOT NULL,
    "weightKey" TEXT NOT NULL,
    "weightOz" DOUBLE PRECISION NOT NULL,
    "cost" DOUBLE PRECISION,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "shipping_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_jobs" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "triggeredBy" TEXT,
    "itemsProcessed" INTEGER NOT NULL DEFAULT 0,
    "itemsCreated" INTEGER NOT NULL DEFAULT 0,
    "itemsUpdated" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PushJobStatus" NOT NULL DEFAULT 'PENDING',
    "dryRun" BOOLEAN NOT NULL DEFAULT true,
    "payload" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "push_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "details" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" TEXT NOT NULL,
    "type" "BackupType" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "size" INTEGER,
    "stores" JSONB NOT NULL DEFAULT '[]',
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_platform_key" ON "integrations"("platform");

-- CreateIndex
CREATE UNIQUE INDEX "master_rows_sku_key" ON "master_rows"("sku");

-- CreateIndex
CREATE INDEX "master_rows_sku_idx" ON "master_rows"("sku");

-- CreateIndex
CREATE INDEX "master_rows_title_idx" ON "master_rows"("title");

-- CreateIndex
CREATE INDEX "marketplace_listings_sku_idx" ON "marketplace_listings"("sku");

-- CreateIndex
CREATE INDEX "marketplace_listings_masterRowId_idx" ON "marketplace_listings"("masterRowId");

-- CreateIndex
CREATE INDEX "marketplace_listings_integrationId_idx" ON "marketplace_listings"("integrationId");

-- CreateIndex
CREATE INDEX "marketplace_listings_parentListingId_idx" ON "marketplace_listings"("parentListingId");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_listings_integrationId_platformItemId_platformV_key" ON "marketplace_listings"("integrationId", "platformItemId", "platformVariantId");

-- CreateIndex
CREATE INDEX "unmatched_listings_sku_idx" ON "unmatched_listings"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "unmatched_listings_integrationId_platformItemId_key" ON "unmatched_listings"("integrationId", "platformItemId");

-- CreateIndex
CREATE INDEX "staged_changes_masterRowId_idx" ON "staged_changes"("masterRowId");

-- CreateIndex
CREATE INDEX "staged_changes_status_idx" ON "staged_changes"("status");

-- CreateIndex
CREATE INDEX "staged_changes_changedById_idx" ON "staged_changes"("changedById");

-- CreateIndex
CREATE UNIQUE INDEX "shipping_rates_weightKey_key" ON "shipping_rates"("weightKey");

-- CreateIndex
CREATE INDEX "sync_jobs_integrationId_idx" ON "sync_jobs"("integrationId");

-- CreateIndex
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs"("status");

-- CreateIndex
CREATE INDEX "push_jobs_userId_idx" ON "push_jobs"("userId");

-- CreateIndex
CREATE INDEX "push_jobs_status_idx" ON "push_jobs"("status");

-- CreateIndex
CREATE INDEX "audit_logs_userId_idx" ON "audit_logs"("userId");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "backups_type_idx" ON "backups"("type");

-- CreateIndex
CREATE INDEX "backups_status_idx" ON "backups"("status");

-- CreateIndex
CREATE INDEX "backups_expiresAt_idx" ON "backups"("expiresAt");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_masterRowId_fkey" FOREIGN KEY ("masterRowId") REFERENCES "master_rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_parentListingId_fkey" FOREIGN KEY ("parentListingId") REFERENCES "marketplace_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unmatched_listings" ADD CONSTRAINT "unmatched_listings_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staged_changes" ADD CONSTRAINT "staged_changes_masterRowId_fkey" FOREIGN KEY ("masterRowId") REFERENCES "master_rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staged_changes" ADD CONSTRAINT "staged_changes_marketplaceListingId_fkey" FOREIGN KEY ("marketplaceListingId") REFERENCES "marketplace_listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staged_changes" ADD CONSTRAINT "staged_changes_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_jobs" ADD CONSTRAINT "push_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

