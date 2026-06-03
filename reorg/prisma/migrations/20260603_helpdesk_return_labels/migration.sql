CREATE TABLE IF NOT EXISTS "helpdesk_return_labels" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "createdByUserId" TEXT,
  "orderNumber" TEXT NOT NULL,
  "labelCrowId" TEXT,
  "labelCrowDownloadUrl" TEXT,
  "trackingNumber" TEXT NOT NULL,
  "carrier" TEXT NOT NULL DEFAULT 'USPS',
  "serviceClass" TEXT NOT NULL DEFAULT 'Ground',
  "providerKey" TEXT NOT NULL DEFAULT 'api',
  "seriesCode" TEXT NOT NULL DEFAULT '9302',
  "seriesId" TEXT,
  "weightLbs" DOUBLE PRECISION NOT NULL DEFAULT 2,
  "fromAddress" JSONB NOT NULL,
  "toAddress" JSONB NOT NULL,
  "pdfBytes" BYTEA,
  "rawResponse" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "helpdesk_return_labels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "helpdesk_return_labels_labelCrowId_key"
  ON "helpdesk_return_labels"("labelCrowId");

CREATE INDEX IF NOT EXISTS "helpdesk_return_labels_ticketId_createdAt_idx"
  ON "helpdesk_return_labels"("ticketId", "createdAt");

CREATE INDEX IF NOT EXISTS "helpdesk_return_labels_orderNumber_idx"
  ON "helpdesk_return_labels"("orderNumber");

CREATE INDEX IF NOT EXISTS "helpdesk_return_labels_trackingNumber_idx"
  ON "helpdesk_return_labels"("trackingNumber");

ALTER TABLE "helpdesk_return_labels"
  ADD CONSTRAINT "helpdesk_return_labels_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "helpdesk_tickets"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
