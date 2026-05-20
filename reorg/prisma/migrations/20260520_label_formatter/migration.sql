-- CreateTable
CREATE TABLE "label_formatter_export_batches" (
    "id" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "rowCount" INTEGER NOT NULL,
    "orderNumbers" JSONB NOT NULL DEFAULT '[]',
    "sourceStores" JSONB NOT NULL DEFAULT '[]',
    "excelFileName" TEXT NOT NULL,
    "pdfFileName" TEXT NOT NULL,
    "zipFileName" TEXT,
    "excelFileKey" TEXT,
    "pdfFileKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_formatter_export_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_formatter_export_rows" (
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_formatter_export_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_formatter_export_batches_createdByUserId_idx" ON "label_formatter_export_batches"("createdByUserId");

-- CreateIndex
CREATE INDEX "label_formatter_export_batches_createdAt_idx" ON "label_formatter_export_batches"("createdAt");

-- CreateIndex
CREATE INDEX "label_formatter_export_rows_batchId_idx" ON "label_formatter_export_rows"("batchId");

-- CreateIndex
CREATE INDEX "label_formatter_export_rows_orderNumber_idx" ON "label_formatter_export_rows"("orderNumber");

-- CreateIndex
CREATE INDEX "label_formatter_export_rows_sourceStore_idx" ON "label_formatter_export_rows"("sourceStore");

-- AddForeignKey
ALTER TABLE "label_formatter_export_batches" ADD CONSTRAINT "label_formatter_export_batches_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label_formatter_export_rows" ADD CONSTRAINT "label_formatter_export_rows_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "label_formatter_export_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
