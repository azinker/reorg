-- CreateEnum
CREATE TYPE "ForecastBucket" AS ENUM ('DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "ForecastConfidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "DemandPattern" AS ENUM ('STABLE', 'TRENDING', 'SEASONAL', 'INTERMITTENT', 'NEW_ITEM');

-- CreateEnum
CREATE TYPE "SupplierOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InventorySourceType" AS ENUM ('MASTER_TPP_LIVE');

-- CreateTable
CREATE TABLE "marketplace_sale_orders" (
    "id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "orderStatus" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "rawData" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_sale_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketplace_sale_lines" (
    "id" TEXT NOT NULL,
    "marketplaceSaleOrderId" TEXT NOT NULL,
    "masterRowId" TEXT,
    "platform" "Platform" NOT NULL,
    "externalLineId" TEXT NOT NULL,
    "orderDate" TIMESTAMP(3) NOT NULL,
    "sku" TEXT NOT NULL,
    "title" TEXT,
    "platformItemId" TEXT,
    "platformVariantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "isReturn" BOOLEAN NOT NULL DEFAULT false,
    "rawData" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marketplace_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_snapshots" (
    "id" TEXT NOT NULL,
    "masterRowId" TEXT NOT NULL,
    "snapshotDate" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "source" "InventorySourceType" NOT NULL DEFAULT 'MASTER_TPP_LIVE',
    "isNearZero" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_runs" (
    "id" TEXT NOT NULL,
    "createdById" TEXT,
    "lookbackDays" INTEGER NOT NULL,
    "forecastBucket" "ForecastBucket" NOT NULL DEFAULT 'WEEKLY',
    "transitDays" INTEGER NOT NULL,
    "desiredCoverageDays" INTEGER NOT NULL,
    "useOpenInTransit" BOOLEAN NOT NULL DEFAULT true,
    "showReorderRelevantOnly" BOOLEAN NOT NULL DEFAULT true,
    "mode" TEXT NOT NULL DEFAULT 'balanced',
    "inventorySource" "InventorySourceType" NOT NULL DEFAULT 'MASTER_TPP_LIVE',
    "syncedSalesThrough" TIMESTAMP(3),
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecast_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forecast_run_lines" (
    "id" TEXT NOT NULL,
    "forecastRunId" TEXT NOT NULL,
    "masterRowId" TEXT NOT NULL,
    "title" TEXT,
    "sku" TEXT NOT NULL,
    "upc" TEXT,
    "imageUrl" TEXT,
    "supplierCost" DOUBLE PRECISION,
    "currentInventory" INTEGER NOT NULL DEFAULT 0,
    "salesTotalUnits" INTEGER NOT NULL DEFAULT 0,
    "salesHistoryDays" INTEGER NOT NULL DEFAULT 0,
    "averageDailyDemand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transitDemand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "postArrivalDemand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "safetyBuffer" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "grossRequiredQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "openInTransitQty" INTEGER NOT NULL DEFAULT 0,
    "openInTransitEta" TIMESTAMP(3),
    "projectedStockOnArrival" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "recommendedQty" INTEGER NOT NULL DEFAULT 0,
    "overrideQty" INTEGER,
    "finalQty" INTEGER NOT NULL DEFAULT 0,
    "demandPattern" "DemandPattern" NOT NULL DEFAULT 'NEW_ITEM',
    "modelUsed" TEXT NOT NULL,
    "confidence" "ForecastConfidence" NOT NULL DEFAULT 'LOW',
    "confidenceNote" TEXT,
    "warningFlags" JSONB NOT NULL DEFAULT '[]',
    "backtestError" DOUBLE PRECISION,
    "suspectedStockout" BOOLEAN NOT NULL DEFAULT false,
    "limitedHistory" BOOLEAN NOT NULL DEFAULT false,
    "hasInbound" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "forecast_run_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_orders" (
    "id" TEXT NOT NULL,
    "createdById" TEXT,
    "forecastRunId" TEXT,
    "supplier" TEXT,
    "status" "SupplierOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "eta" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_order_lines" (
    "id" TEXT NOT NULL,
    "supplierOrderId" TEXT NOT NULL,
    "masterRowId" TEXT NOT NULL,
    "title" TEXT,
    "sku" TEXT NOT NULL,
    "supplierCost" DOUBLE PRECISION,
    "systemRecommendedQty" INTEGER NOT NULL DEFAULT 0,
    "overrideQty" INTEGER,
    "finalQty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_sale_orders_platform_orderDate_idx" ON "marketplace_sale_orders"("platform", "orderDate");

-- CreateIndex
CREATE INDEX "marketplace_sale_orders_orderDate_idx" ON "marketplace_sale_orders"("orderDate");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_sale_orders_platform_externalOrderId_key" ON "marketplace_sale_orders"("platform", "externalOrderId");

-- CreateIndex
CREATE INDEX "marketplace_sale_lines_masterRowId_idx" ON "marketplace_sale_lines"("masterRowId");

-- CreateIndex
CREATE INDEX "marketplace_sale_lines_sku_idx" ON "marketplace_sale_lines"("sku");

-- CreateIndex
CREATE INDEX "marketplace_sale_lines_platform_orderDate_idx" ON "marketplace_sale_lines"("platform", "orderDate");

-- CreateIndex
CREATE INDEX "marketplace_sale_lines_platform_sku_idx" ON "marketplace_sale_lines"("platform", "sku");

-- CreateIndex
CREATE INDEX "marketplace_sale_lines_orderDate_idx" ON "marketplace_sale_lines"("orderDate");

-- CreateIndex
CREATE UNIQUE INDEX "marketplace_sale_lines_marketplaceSaleOrderId_externalLineI_key" ON "marketplace_sale_lines"("marketplaceSaleOrderId", "externalLineId");

-- CreateIndex
CREATE INDEX "inventory_snapshots_snapshotDate_idx" ON "inventory_snapshots"("snapshotDate");

-- CreateIndex
CREATE INDEX "inventory_snapshots_source_snapshotDate_idx" ON "inventory_snapshots"("source", "snapshotDate");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_snapshots_masterRowId_snapshotDate_source_key" ON "inventory_snapshots"("masterRowId", "snapshotDate", "source");

-- CreateIndex
CREATE INDEX "forecast_runs_createdById_idx" ON "forecast_runs"("createdById");

-- CreateIndex
CREATE INDEX "forecast_runs_createdAt_idx" ON "forecast_runs"("createdAt");

-- CreateIndex
CREATE INDEX "forecast_run_lines_forecastRunId_idx" ON "forecast_run_lines"("forecastRunId");

-- CreateIndex
CREATE INDEX "forecast_run_lines_masterRowId_idx" ON "forecast_run_lines"("masterRowId");

-- CreateIndex
CREATE INDEX "forecast_run_lines_title_idx" ON "forecast_run_lines"("title");

-- CreateIndex
CREATE UNIQUE INDEX "forecast_run_lines_forecastRunId_masterRowId_key" ON "forecast_run_lines"("forecastRunId", "masterRowId");

-- CreateIndex
CREATE INDEX "supplier_orders_createdById_idx" ON "supplier_orders"("createdById");

-- CreateIndex
CREATE INDEX "supplier_orders_forecastRunId_idx" ON "supplier_orders"("forecastRunId");

-- CreateIndex
CREATE INDEX "supplier_orders_status_eta_idx" ON "supplier_orders"("status", "eta");

-- CreateIndex
CREATE INDEX "supplier_order_lines_supplierOrderId_idx" ON "supplier_order_lines"("supplierOrderId");

-- CreateIndex
CREATE INDEX "supplier_order_lines_masterRowId_idx" ON "supplier_order_lines"("masterRowId");

-- CreateIndex
CREATE INDEX "supplier_order_lines_title_idx" ON "supplier_order_lines"("title");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_order_lines_supplierOrderId_masterRowId_key" ON "supplier_order_lines"("supplierOrderId", "masterRowId");

-- AddForeignKey
ALTER TABLE "marketplace_sale_lines" ADD CONSTRAINT "marketplace_sale_lines_marketplaceSaleOrderId_fkey" FOREIGN KEY ("marketplaceSaleOrderId") REFERENCES "marketplace_sale_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketplace_sale_lines" ADD CONSTRAINT "marketplace_sale_lines_masterRowId_fkey" FOREIGN KEY ("masterRowId") REFERENCES "master_rows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_masterRowId_fkey" FOREIGN KEY ("masterRowId") REFERENCES "master_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_run_lines" ADD CONSTRAINT "forecast_run_lines_forecastRunId_fkey" FOREIGN KEY ("forecastRunId") REFERENCES "forecast_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "forecast_run_lines" ADD CONSTRAINT "forecast_run_lines_masterRowId_fkey" FOREIGN KEY ("masterRowId") REFERENCES "master_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_orders" ADD CONSTRAINT "supplier_orders_forecastRunId_fkey" FOREIGN KEY ("forecastRunId") REFERENCES "forecast_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_order_lines" ADD CONSTRAINT "supplier_order_lines_supplierOrderId_fkey" FOREIGN KEY ("supplierOrderId") REFERENCES "supplier_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_order_lines" ADD CONSTRAINT "supplier_order_lines_masterRowId_fkey" FOREIGN KEY ("masterRowId") REFERENCES "master_rows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

