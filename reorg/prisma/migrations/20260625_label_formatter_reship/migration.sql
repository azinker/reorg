-- CreateTable
CREATE TABLE "label_formatter_reship_batches" (
    "id" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "rowCount" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "carrier" TEXT NOT NULL DEFAULT 'usps',
    "serviceClass" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "seriesCode" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "fromStreet" TEXT NOT NULL,
    "fromStreet2" TEXT,
    "fromCity" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "fromZip" TEXT NOT NULL,
    "zipFileName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_formatter_reship_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_formatter_reship_rows" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "note" TEXT,
    "orderNumber" TEXT NOT NULL,
    "sourceStore" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zipCode" TEXT NOT NULL,
    "lineItems" JSONB NOT NULL DEFAULT '[]',
    "trackingNumber" TEXT,
    "labelCrowId" TEXT,
    "carrier" TEXT NOT NULL DEFAULT 'usps',
    "serviceClass" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "seriesCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_formatter_reship_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_formatter_reship_batches_createdByUserId_idx" ON "label_formatter_reship_batches"("createdByUserId");

-- CreateIndex
CREATE INDEX "label_formatter_reship_batches_createdAt_idx" ON "label_formatter_reship_batches"("createdAt");

-- CreateIndex
CREATE INDEX "label_formatter_reship_rows_batchId_idx" ON "label_formatter_reship_rows"("batchId");

-- CreateIndex
CREATE INDEX "label_formatter_reship_rows_orderNumber_idx" ON "label_formatter_reship_rows"("orderNumber");

-- CreateIndex
CREATE INDEX "label_formatter_reship_rows_trackingNumber_idx" ON "label_formatter_reship_rows"("trackingNumber");

-- AddForeignKey
ALTER TABLE "label_formatter_reship_batches" ADD CONSTRAINT "label_formatter_reship_batches_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_formatter_reship_rows" ADD CONSTRAINT "label_formatter_reship_rows_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "label_formatter_reship_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
