-- Help Desk triage overhaul (eDesk-parity ticket header bar + inbox columns
-- + presence). All changes are additive with safe defaults so they apply
-- cleanly to the live DB via `prisma db push --accept-data-loss --skip-generate`
-- (the `--accept-data-loss` flag is a no-op here because nothing is dropped).

-- ── 1. New ticket-type enum + columns ────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE "HelpdeskTicketType" AS ENUM (
    'QUERY',
    'PRE_SALES',
    'RETURN_REQUEST',
    'ITEM_NOT_RECEIVED',
    'NEGATIVE_FEEDBACK',
    'REFUND',
    'SHIPPING_QUERY',
    'CANCELLATION',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "helpdesk_tickets"
  ADD COLUMN IF NOT EXISTS "type" "HelpdeskTicketType" NOT NULL DEFAULT 'QUERY',
  ADD COLUMN IF NOT EXISTS "typeOverridden" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isFavorite" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "isImportant" boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS "helpdesk_tickets_isFavorite_idx" ON "helpdesk_tickets" ("isFavorite");
CREATE INDEX IF NOT EXISTS "helpdesk_tickets_type_idx" ON "helpdesk_tickets" ("type");

-- ── 2. Per-user inbox column preferences ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS "helpdesk_column_prefs" (
  "userId"    text        NOT NULL,
  "layout"    text        NOT NULL DEFAULT 'table',
  "columns"   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "helpdesk_column_prefs_pkey" PRIMARY KEY ("userId", "layout"),
  CONSTRAINT "helpdesk_column_prefs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);

-- ── 3. Live ticket presence (green-eye polling) ──────────────────────────────

CREATE TABLE IF NOT EXISTS "helpdesk_presence" (
  "ticketId"      text        NOT NULL,
  "userId"        text        NOT NULL,
  "lastSeenAt"    timestamptz NOT NULL DEFAULT now(),
  "expiresAt"     timestamptz NOT NULL,
  "presenceState" text        NOT NULL DEFAULT 'viewer',
  CONSTRAINT "helpdesk_presence_pkey" PRIMARY KEY ("ticketId", "userId"),
  CONSTRAINT "helpdesk_presence_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "helpdesk_tickets"("id") ON DELETE CASCADE,
  CONSTRAINT "helpdesk_presence_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "helpdesk_presence_ticket_expires_idx"
  ON "helpdesk_presence" ("ticketId", "expiresAt");
CREATE INDEX IF NOT EXISTS "helpdesk_presence_expires_idx"
  ON "helpdesk_presence" ("expiresAt");
