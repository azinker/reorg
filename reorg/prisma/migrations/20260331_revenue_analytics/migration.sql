-- AlterTable
ALTER TABLE "marketplace_sale_lines" ADD COLUMN     "advertisingFeeAmount" DOUBLE PRECISION,
ADD COLUMN     "financialRawData" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "grossRevenueAmount" DOUBLE PRECISION,
ADD COLUMN     "marketplaceFeeAmount" DOUBLE PRECISION,
ADD COLUMN     "netRevenueAmount" DOUBLE PRECISION,
ADD COLUMN     "otherFeeAmount" DOUBLE PRECISION,
ADD COLUMN     "shippingAmount" DOUBLE PRECISION,
ADD COLUMN     "taxAmount" DOUBLE PRECISION,
ADD COLUMN     "unitPriceAmount" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "marketplace_sale_orders" ADD COLUMN     "buyerDisplayLabel" TEXT,
ADD COLUMN     "buyerEmail" TEXT,
ADD COLUMN     "buyerIdentifier" TEXT,
ADD COLUMN     "currencyCode" TEXT,
ADD COLUMN     "discountAmount" DOUBLE PRECISION,
ADD COLUMN     "financialRawData" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "grossRevenueAmount" DOUBLE PRECISION,
ADD COLUMN     "netRevenueAmount" DOUBLE PRECISION,
ADD COLUMN     "shippingCollectedAmount" DOUBLE PRECISION,
ADD COLUMN     "taxCollectedAmount" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "revenue_sync_jobs" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "triggeredByUserId" TEXT,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "ordersProcessed" INTEGER NOT NULL DEFAULT 0,
    "linesProcessed" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "errorSummary" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "revenue_sync_jobs_integrationId_createdAt_idx" ON "revenue_sync_jobs"("integrationId", "createdAt");

-- CreateIndex
CREATE INDEX "revenue_sync_jobs_platform_createdAt_idx" ON "revenue_sync_jobs"("platform", "createdAt");

-- CreateIndex
CREATE INDEX "revenue_sync_jobs_status_createdAt_idx" ON "revenue_sync_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "marketplace_sale_orders_platform_buyerIdentifier_idx" ON "marketplace_sale_orders"("platform", "buyerIdentifier");

-- AddForeignKey
ALTER TABLE "revenue_sync_jobs" ADD CONSTRAINT "revenue_sync_jobs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revenue_sync_jobs" ADD CONSTRAINT "revenue_sync_jobs_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
