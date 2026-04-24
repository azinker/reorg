-- Persist eBay Commerce Message API conversationId on HelpdeskTicket so the
-- mirror/sweep paths can skip the otherPartyUsername lookup on every tick
-- and so we have a stable handle for the new Commerce-Message inbound
-- ingest leg (fetches agent replies sent directly from eBay's web UI,
-- which never land in the legacy Trading API "Sent" folder).
--
-- Additive + idempotent: applies cleanly via
--   `prisma db push --accept-data-loss --skip-generate`.

ALTER TABLE "helpdesk_tickets"
  ADD COLUMN IF NOT EXISTS "ebayConversationId" text;

CREATE INDEX IF NOT EXISTS "helpdesk_tickets_ebayConversationId_idx"
  ON "helpdesk_tickets" ("ebayConversationId");
