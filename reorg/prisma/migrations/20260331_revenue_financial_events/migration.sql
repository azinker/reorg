-- CreateEnum
CREATE TYPE "RevenueFinancialEventType" AS ENUM ('TRANSACTION', 'BILLING_ACTIVITY', 'SUMMARY');

-- CreateEnum
CREATE TYPE "RevenueFinancialEventClassification" AS ENUM ('SALE', 'TAX', 'MARKETPLACE_FEE', 'ADVERTISING_FEE', 'SHIPPING_LABEL', 'ACCOUNT_LEVEL_FEE', 'CREDIT', 'OTHER');

-- CreateTable
CREATE TABLE "revenue_financial_events" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "eventType" "RevenueFinancialEventType" NOT NULL,
    "classification" "RevenueFinancialEventClassification" NOT NULL,
    "externalEventId" TEXT NOT NULL,
    "externalOrderId" TEXT,
    "externalLineId" TEXT,
    "platformItemId" TEXT,
    "sku" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currencyCode" TEXT,
    "feeType" TEXT,
    "feeTypeDescription" TEXT,
    "bookingEntry" TEXT,
    "isExact" BOOLEAN NOT NULL DEFAULT true,
    "rawData" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_financial_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "revenue_financial_events_integrationId_eventType_externalEve_key" ON "revenue_financial_events"("integrationId", "eventType", "externalEventId");

-- CreateIndex
CREATE INDEX "revenue_financial_events_platform_occurredAt_idx" ON "revenue_financial_events"("platform", "occurredAt");

-- CreateIndex
CREATE INDEX "revenue_financial_events_integrationId_occurredAt_idx" ON "revenue_financial_events"("integrationId", "occurredAt");

-- CreateIndex
CREATE INDEX "revenue_financial_events_classification_occurredAt_idx" ON "revenue_financial_events"("classification", "occurredAt");

-- CreateIndex
CREATE INDEX "revenue_financial_events_externalOrderId_idx" ON "revenue_financial_events"("externalOrderId");

-- CreateIndex
CREATE INDEX "revenue_financial_events_platformItemId_idx" ON "revenue_financial_events"("platformItemId");

-- AddForeignKey
ALTER TABLE "revenue_financial_events" ADD CONSTRAINT "revenue_financial_events_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
