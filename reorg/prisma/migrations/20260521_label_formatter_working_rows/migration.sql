-- CreateTable
CREATE TABLE "label_formatter_working_rows" (
    "id" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
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
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "label_formatter_working_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "label_formatter_working_rows_createdByUserId_sortOrder_idx" ON "label_formatter_working_rows"("createdByUserId", "sortOrder");

-- CreateIndex
CREATE INDEX "label_formatter_working_rows_createdByUserId_updatedAt_idx" ON "label_formatter_working_rows"("createdByUserId", "updatedAt");

-- AddForeignKey
ALTER TABLE "label_formatter_working_rows" ADD CONSTRAINT "label_formatter_working_rows_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
