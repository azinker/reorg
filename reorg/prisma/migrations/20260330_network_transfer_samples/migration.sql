-- CreateEnum
CREATE TYPE "NetworkTransferChannel" AS ENUM ('CLIENT_API_RESPONSE', 'MARKETPLACE_INBOUND', 'SYNC_JOB', 'FORECAST', 'OTHER');

-- CreateTable
CREATE TABLE "network_transfer_samples" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" "NetworkTransferChannel" NOT NULL,
    "label" TEXT NOT NULL,
    "bytesEstimate" INTEGER,
    "durationMs" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "integrationId" TEXT,

    CONSTRAINT "network_transfer_samples_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "network_transfer_samples_createdAt_idx" ON "network_transfer_samples"("createdAt");

-- CreateIndex
CREATE INDEX "network_transfer_samples_channel_idx" ON "network_transfer_samples"("channel");

-- CreateIndex
CREATE INDEX "network_transfer_samples_integrationId_idx" ON "network_transfer_samples"("integrationId");

-- AddForeignKey
ALTER TABLE "network_transfer_samples" ADD CONSTRAINT "network_transfer_samples_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
