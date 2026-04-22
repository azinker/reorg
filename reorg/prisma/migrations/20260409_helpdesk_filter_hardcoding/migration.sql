-- Help Desk filter-logic hard-coding pass.
--
-- Three user-defined filters are being replaced by hard-coded routing:
--
--   1. "From eBay Messages"  → tickets with type = SYSTEM, surfaced via a
--                              new "From eBay" sub-folder under Cancel
--                              Requests, hidden from All Tickets / To Do
--                              / Waiting.
--   2. "A buyer wants to cancel an order" → tickets with type = CANCELLATION
--                              auto-tagged with the cancel-requests tag and
--                              hidden from the main inbox.
--   3. "Auto Responder Initial Message" → tickets that have ONLY a single
--                              AUTO_RESPONDER message are auto-archived once;
--                              if the buyer replies, the ticket bounces to
--                              To Do and is never re-archived by the rule
--                              (because once a buyer message exists, the
--                              "only 1 AR message" condition can no longer
--                              re-trigger).
--
-- Schema additions:
--
--   • NetworkTransferChannel gains a HELPDESK value so all Help Desk eBay
--     traffic can be tracked under its own bucket on the Public Network
--     Transfer page (alongside Marketplace In/Out, Auto Responder, etc.).
--   • HelpdeskTicketType gains a SYSTEM value for eBay-originated
--     notifications.
--   • helpdesk_tickets gains a `systemMessageType` text column to sub-
--     classify SYSTEM tickets ("RETURN_APPROVED", "ITEM_DELIVERED", etc.)
--     so the From eBay folder can offer type-filter chips.
--
-- All operations are idempotent (`IF NOT EXISTS` / `ADD VALUE IF NOT EXISTS`)
-- so the migration is safe to apply via `prisma db push` against an
-- environment that already has some of these objects.

-- ── 1. NetworkTransferChannel: HELPDESK ───────────────────────────────────────

ALTER TYPE "NetworkTransferChannel" ADD VALUE IF NOT EXISTS 'HELPDESK';

-- ── 2. HelpdeskTicketType: SYSTEM ─────────────────────────────────────────────

ALTER TYPE "HelpdeskTicketType" ADD VALUE IF NOT EXISTS 'SYSTEM';

-- ── 3. helpdesk_tickets.systemMessageType + index ─────────────────────────────

ALTER TABLE "helpdesk_tickets"
  ADD COLUMN IF NOT EXISTS "systemMessageType" text;

CREATE INDEX IF NOT EXISTS "helpdesk_tickets_systemMessageType_idx"
  ON "helpdesk_tickets" ("systemMessageType");
