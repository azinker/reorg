-- Help Desk thread overhaul v2 — schema additions for the message thread
-- rewrite + new eBay action mirrors. Applied to live DB via
-- `prisma db push --skip-generate` (Neon shadow database is unreliable for
-- migrate dev). All changes are additive with safe defaults so they apply
-- cleanly to existing data.

-- 1. AUTO_RESPONDER source value on the existing HelpdeskMessageSource enum
--    so we can distinguish AR-originated outbound messages from human agent
--    replies in the ThreadView (renders a robot avatar instead of an agent
--    monogram).
ALTER TYPE "HelpdeskMessageSource" ADD VALUE IF NOT EXISTS 'AUTO_RESPONDER';

-- 2. Per-agent default for the Composer's primary "Send" button
--    ("RESOLVED" or "WAITING"). NULL = use the global default. Stored on
--    User so it survives across sessions and devices.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "helpdeskDefaultSendStatus" VARCHAR(16);

-- 3. eBay return / dispute mirror table. Sourced from eBay REST post-order
--    Returns API and folded into the timeline as a centered pill.
DO $$ BEGIN
  CREATE TYPE "HelpdeskCaseStatus" AS ENUM (
    'OPEN', 'CLOSED', 'AWAITING_SELLER', 'AWAITING_BUYER',
    'ESCALATED', 'CANCELLED', 'REFUNDED', 'UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "HelpdeskCaseKind" AS ENUM (
    'RETURN', 'ITEM_NOT_RECEIVED', 'NOT_AS_DESCRIBED', 'CHARGEBACK', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "helpdesk_cases" (
  "id"              TEXT PRIMARY KEY,
  "integrationId"   TEXT NOT NULL,
  "ticketId"        TEXT,
  "externalId"      TEXT NOT NULL,
  "kind"            "HelpdeskCaseKind" NOT NULL,
  "status"          "HelpdeskCaseStatus" NOT NULL DEFAULT 'OPEN',
  "ebayOrderNumber" TEXT,
  "buyerUserId"     TEXT,
  "reason"          TEXT,
  "manageUrl"       TEXT,
  "openedAt"        TIMESTAMP(3) NOT NULL,
  "closedAt"        TIMESTAMP(3),
  "rawData"         JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "helpdesk_cases_integrationId_externalId_key"
  ON "helpdesk_cases"("integrationId", "externalId");
CREATE INDEX IF NOT EXISTS "helpdesk_cases_ticketId_openedAt_idx"
  ON "helpdesk_cases"("ticketId", "openedAt");
CREATE INDEX IF NOT EXISTS "helpdesk_cases_ebayOrderNumber_idx"
  ON "helpdesk_cases"("ebayOrderNumber");
CREATE INDEX IF NOT EXISTS "helpdesk_cases_buyerUserId_idx"
  ON "helpdesk_cases"("buyerUserId");
CREATE INDEX IF NOT EXISTS "helpdesk_cases_status_openedAt_idx"
  ON "helpdesk_cases"("status", "openedAt");

-- 4. Buyer feedback mirror. Sourced from eBay Trading API GetFeedback.
--    Negative feedback drives a red-tinted timeline pill and (when ticket
--    type is still QUERY) flips type → NEGATIVE_FEEDBACK.
DO $$ BEGIN
  CREATE TYPE "HelpdeskFeedbackKind" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "helpdesk_feedback" (
  "id"              TEXT PRIMARY KEY,
  "integrationId"   TEXT NOT NULL,
  "ticketId"        TEXT,
  "externalId"      TEXT NOT NULL,
  "kind"            "HelpdeskFeedbackKind" NOT NULL,
  "starRating"      INTEGER,
  "comment"         TEXT,
  "sellerResponse"  TEXT,
  "ebayOrderNumber" TEXT,
  "ebayItemId"      TEXT,
  "buyerUserId"     TEXT,
  "manageUrl"       TEXT,
  "leftAt"          TIMESTAMP(3) NOT NULL,
  "rawData"         JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "helpdesk_feedback_integrationId_externalId_key"
  ON "helpdesk_feedback"("integrationId", "externalId");
CREATE INDEX IF NOT EXISTS "helpdesk_feedback_ticketId_leftAt_idx"
  ON "helpdesk_feedback"("ticketId", "leftAt");
CREATE INDEX IF NOT EXISTS "helpdesk_feedback_ebayOrderNumber_idx"
  ON "helpdesk_feedback"("ebayOrderNumber");
CREATE INDEX IF NOT EXISTS "helpdesk_feedback_buyerUserId_idx"
  ON "helpdesk_feedback"("buyerUserId");
CREATE INDEX IF NOT EXISTS "helpdesk_feedback_kind_leftAt_idx"
  ON "helpdesk_feedback"("kind", "leftAt");

-- 5. Cancellation request mirror. Sourced from eBay REST post-order
--    Cancellation API.
DO $$ BEGIN
  CREATE TYPE "HelpdeskCancellationStatus" AS ENUM (
    'REQUESTED', 'APPROVED', 'REJECTED', 'COMPLETED',
    'CANCELLED_BY_BUYER', 'UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "helpdesk_cancellations" (
  "id"              TEXT PRIMARY KEY,
  "integrationId"   TEXT NOT NULL,
  "ticketId"        TEXT,
  "externalId"      TEXT NOT NULL,
  "status"          "HelpdeskCancellationStatus" NOT NULL DEFAULT 'REQUESTED',
  "reason"          TEXT,
  "refundAmount"    DOUBLE PRECISION,
  "refundCurrency"  VARCHAR(8),
  "ebayOrderNumber" TEXT,
  "buyerUserId"     TEXT,
  "manageUrl"       TEXT,
  "requestedAt"     TIMESTAMP(3) NOT NULL,
  "resolvedAt"      TIMESTAMP(3),
  "rawData"         JSONB NOT NULL DEFAULT '{}'::jsonb,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "helpdesk_cancellations_integrationId_externalId_key"
  ON "helpdesk_cancellations"("integrationId", "externalId");
CREATE INDEX IF NOT EXISTS "helpdesk_cancellations_ticketId_requestedAt_idx"
  ON "helpdesk_cancellations"("ticketId", "requestedAt");
CREATE INDEX IF NOT EXISTS "helpdesk_cancellations_ebayOrderNumber_idx"
  ON "helpdesk_cancellations"("ebayOrderNumber");
CREATE INDEX IF NOT EXISTS "helpdesk_cancellations_buyerUserId_idx"
  ON "helpdesk_cancellations"("buyerUserId");
CREATE INDEX IF NOT EXISTS "helpdesk_cancellations_status_requestedAt_idx"
  ON "helpdesk_cancellations"("status", "requestedAt");
