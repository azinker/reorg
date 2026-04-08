-- CreateEnum
CREATE TYPE "AutoResponderStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED', 'INVALID');
CREATE TYPE "AutoResponderEventType" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'SKIPPED', 'DUPLICATE_PREVENTED', 'NO_ACTIVE_RESPONDER', 'PREVIEW', 'TEST_SEND', 'INTEGRATION_DISABLED', 'RESPONDER_AUTO_DISABLED');
CREATE TYPE "AutoResponderSource" AS ENUM ('SHIP_ORDERS', 'RECONCILIATION', 'PREVIEW', 'TESTING_AREA');
CREATE TYPE "AutoResponderJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'PAUSED');

-- AlterEnum
ALTER TYPE "NetworkTransferChannel" ADD VALUE 'AUTO_RESPONDER';

-- CreateTable
CREATE TABLE "auto_responders" (
    "id" TEXT NOT NULL,
    "messageName" TEXT NOT NULL,
    "channel" "Platform" NOT NULL,
    "integrationId" TEXT NOT NULL,
    "subjectTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "status" "AutoResponderStatus" NOT NULL DEFAULT 'INACTIVE',
    "activatedAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_responders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_responder_versions" (
    "id" TEXT NOT NULL,
    "responderId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "subjectTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "validationStatus" TEXT NOT NULL DEFAULT 'valid',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_responder_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_responder_send_logs" (
    "id" TEXT NOT NULL,
    "responderId" TEXT,
    "responderVersionId" TEXT,
    "integrationId" TEXT NOT NULL,
    "channel" "Platform" NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "eventType" "AutoResponderEventType" NOT NULL,
    "source" "AutoResponderSource" NOT NULL,
    "renderedSubject" TEXT,
    "renderedBody" TEXT,
    "status" TEXT,
    "reason" TEXT,
    "externalMessageId" TEXT,
    "ebayItemId" TEXT,
    "ebayBuyerUserId" TEXT,
    "queuedAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "bytesEstimate" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auto_responder_send_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auto_responder_jobs" (
    "id" TEXT NOT NULL,
    "responderId" TEXT NOT NULL,
    "responderVersionId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "channel" "Platform" NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "ebayItemId" TEXT,
    "ebayBuyerUserId" TEXT,
    "buyerName" TEXT,
    "itemTitle" TEXT,
    "source" "AutoResponderSource" NOT NULL,
    "status" "AutoResponderJobStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auto_responder_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auto_responders_channel_status_idx" ON "auto_responders"("channel", "status");
CREATE INDEX "auto_responders_integrationId_idx" ON "auto_responders"("integrationId");
CREATE INDEX "auto_responders_status_idx" ON "auto_responders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "auto_responder_versions_responderId_versionNumber_key" ON "auto_responder_versions"("responderId", "versionNumber");
CREATE INDEX "auto_responder_versions_responderId_createdAt_idx" ON "auto_responder_versions"("responderId", "createdAt");

-- CreateIndex (dedupe constraint)
CREATE UNIQUE INDEX "auto_responder_dedupe" ON "auto_responder_send_logs"("orderNumber", "channel");
CREATE INDEX "auto_responder_send_logs_channel_createdAt_idx" ON "auto_responder_send_logs"("channel", "createdAt");
CREATE INDEX "auto_responder_send_logs_responderId_createdAt_idx" ON "auto_responder_send_logs"("responderId", "createdAt");
CREATE INDEX "auto_responder_send_logs_eventType_createdAt_idx" ON "auto_responder_send_logs"("eventType", "createdAt");
CREATE INDEX "auto_responder_send_logs_orderNumber_idx" ON "auto_responder_send_logs"("orderNumber");
CREATE INDEX "auto_responder_send_logs_createdAt_idx" ON "auto_responder_send_logs"("createdAt");

-- CreateIndex
CREATE INDEX "auto_responder_jobs_status_processAfter_idx" ON "auto_responder_jobs"("status", "processAfter");
CREATE INDEX "auto_responder_jobs_channel_status_idx" ON "auto_responder_jobs"("channel", "status");
CREATE INDEX "auto_responder_jobs_orderNumber_idx" ON "auto_responder_jobs"("orderNumber");

-- AddForeignKey
ALTER TABLE "auto_responders" ADD CONSTRAINT "auto_responders_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "auto_responders" ADD CONSTRAINT "auto_responders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "auto_responders" ADD CONSTRAINT "auto_responders_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "auto_responder_versions" ADD CONSTRAINT "auto_responder_versions_responderId_fkey" FOREIGN KEY ("responderId") REFERENCES "auto_responders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_responder_versions" ADD CONSTRAINT "auto_responder_versions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "auto_responder_send_logs" ADD CONSTRAINT "auto_responder_send_logs_responderId_fkey" FOREIGN KEY ("responderId") REFERENCES "auto_responders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auto_responder_send_logs" ADD CONSTRAINT "auto_responder_send_logs_responderVersionId_fkey" FOREIGN KEY ("responderVersionId") REFERENCES "auto_responder_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "auto_responder_send_logs" ADD CONSTRAINT "auto_responder_send_logs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "auto_responder_jobs" ADD CONSTRAINT "auto_responder_jobs_responderId_fkey" FOREIGN KEY ("responderId") REFERENCES "auto_responders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_responder_jobs" ADD CONSTRAINT "auto_responder_jobs_responderVersionId_fkey" FOREIGN KEY ("responderVersionId") REFERENCES "auto_responder_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auto_responder_jobs" ADD CONSTRAINT "auto_responder_jobs_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
