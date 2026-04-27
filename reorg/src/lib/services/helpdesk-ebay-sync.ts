/**
 * Help Desk eBay sync service.
 *
 * 2-stage polling strategy (cost-optimized for Neon public network transfer):
 *   1. Cheap probe: GetMyMessages summary ΓåÆ check NewMessageCount + LastModifiedTime.
 *      Returns ~1KB. Run every cron tick.
 *   2. Headers pull: only fired when summary indicates new activity. Returns
 *      ~5ΓÇô20KB depending on volume. Used to detect specific message IDs to
 *      hydrate.
 *   3. Body pull: chunked (10 IDs per call) for the IDs we don't already have.
 *
 * Backfill: 60-day initial history (BACKFILL_DAYS, env-tunable).
 * Resumable across cron ticks via
 * HelpdeskSyncCheckpoint.backfillCursor ΓÇö each tick advances by ~7 days
 * (eBay's StartTime window cap) until backfillDone=true.
 *
 * Threading: messages are linked into HelpdeskTickets by a `threadKey`. The
 * key prefers ItemID + buyer pair for buyerΓåöseller threads on a single item;
 * falls back to Subject + buyer for general inquiries.
 */

import { db } from "@/lib/db";
import {
  Platform,
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskTicketStatus,
  HelpdeskTicketKind,
  HelpdeskTicketType,
  type HelpdeskFilter,
  type HelpdeskTicket,
  type Integration,
  type Prisma,
} from "@prisma/client";
import {
  buildEbayConfig,
  getMyMessagesSummary,
  getMyMessagesHeaders,
  getMyMessagesBodies,
  type EbayMessageBody,
  type EbayMessageHeader,
} from "@/lib/services/helpdesk-ebay";
import {
  getConversations,
  getConversationMessages,
  resolveConversationIdForBuyer,
  type CommerceMessage,
  type CommerceMessageConversation,
  type CommerceMessageMedia,
} from "@/lib/services/helpdesk-commerce-message";
import { applyFilterAction, pickMatchingFilters } from "@/lib/helpdesk/filters";
import { BUYER_CANCELLATION_TAG_NAME } from "@/lib/helpdesk/folders";
import { helpdeskFlags, helpdeskFlagsSnapshotAsync } from "@/lib/helpdesk/flags";
import {
  deriveStatusOnInbound,
  deriveStatusOnSyncedOutbound,
} from "@/lib/helpdesk/status-routing";
import { classifyMessageSource } from "@/lib/helpdesk/message-source";
import { detectTicketType } from "@/lib/helpdesk/type-detect";
import {
  detectFromEbay,
  detectCancellationRequest,
} from "@/lib/helpdesk/from-ebay-detect";
import {
  extractBuyerNameFromAutoResponderBody,
  getSellerUserId,
  resolveBuyerForDigest,
  type ResolvedBuyer,
} from "@/lib/helpdesk/buyer-resolve";
import {
  parseEbayDigest,
  hashBodyForMatch,
} from "@/lib/helpdesk/ebay-digest-parser";
import {
  cleanMessageHtml,
  extractEnvelopePreviewImages,
  envelopeStubBody,
} from "@/lib/helpdesk/html-clean";

// ΓöÇΓöÇΓöÇ Constants ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/** Folders we sync for each integration. 0 = Inbox, 1 = Sent. */
const FOLDERS = [
  { id: 0, key: "inbox" },
  { id: 1, key: "sent" },
] as const;

/** Maximum span (days) per GetMyMessages headers call ΓÇö eBay caps at 7. */
const HEADERS_WINDOW_DAYS = 7;

/**
 * Initial backfill horizon in days.
 *
 * Adam wants the inbox to show the full last 60 days of buyer
 * conversations on first connect (TPP + TT). The cron walks backwards
 * one HEADERS_WINDOW_DAYS slice at a time, so a 60-day horizon =
 * ceil(60/7) = 9 cron ticks worst case before backfill flips done.
 *
 * Tunable via the HELPDESK_BACKFILL_DAYS env var so we can re-trigger
 * a deeper pull (e.g. 90/180) without a redeploy by bumping the env
 * var and resetting checkpoints (scripts/reset-helpdesk-backfill.ts).
 */
const BACKFILL_DAYS = Number.parseInt(
  process.env.HELPDESK_BACKFILL_DAYS ?? "60",
  10,
);

/** Max body fetch chunks per tick (each chunk = 10 messages). */
const MAX_BODY_CHUNKS_PER_TICK = 20;

/** Wall-clock budget in ms ΓÇö used to bail out gracefully. */
const TICK_BUDGET_MS = 75_000;

/**
 * If a recent buyer asks a pre-sale question from a different listing, fold
 * that question into their latest order ticket instead of creating a second
 * orphaned PRE_SALES ticket. Keep this bounded so a buyer who returns months
 * later with an unrelated pre-sale question does not get attached to stale
 * order work.
 */
const CROSS_LISTING_ORDER_LOOKBACK_DAYS = 90;

// ΓöÇΓöÇΓöÇ Types ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export interface HelpdeskPollSummary {
  integrationId: string;
  platform: Platform;
  folder: string;
  probedNewCount: number;
  probedTotalCount: number;
  headersFetched: number;
  bodiesFetched: number;
  ticketsCreated: number;
  ticketsUpdated: number;
  messagesInserted: number;
  backfillAdvanced: boolean;
  backfillDone: boolean;
  error?: string;
}

export interface HelpdeskPollResult {
  durationMs: number;
  summaries: HelpdeskPollSummary[];
}

interface CrossListingInquiryContext {
  sourceItemId: string;
  sourceItemTitle: string | null;
  sourceSubject: string | null;
  sourceConversationId: string | null;
  targetTicketId: string;
  targetOrderNumber: string | null;
  targetItemId: string | null;
}

// ΓöÇΓöÇΓöÇ Public entrypoint ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

export async function runHelpdeskPoll(): Promise<HelpdeskPollResult> {
  const startedAt = Date.now();
  const summaries: HelpdeskPollSummary[] = [];

  const integrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    },
  });

  for (const integration of integrations) {
    if (Date.now() - startedAt > TICK_BUDGET_MS) break;
    for (const folder of FOLDERS) {
      if (Date.now() - startedAt > TICK_BUDGET_MS) break;
      try {
        const summary = await pollIntegrationFolder(integration, folder.id, folder.key);
        summaries.push(summary);
      } catch (err) {
        summaries.push({
          integrationId: integration.id,
          platform: integration.platform,
          folder: folder.key,
          probedNewCount: 0,
          probedTotalCount: 0,
          headersFetched: 0,
          bodiesFetched: 0,
          ticketsCreated: 0,
          ticketsUpdated: 0,
          messagesInserted: 0,
          backfillAdvanced: false,
          backfillDone: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // End-of-tick AR-only archive sweep.
  //
  // Catches tickets the per-message archive rule missed — specifically
  // tickets created by the direct AR ingest path (helpdesk-ar-ingest.ts)
  // before the hardcoded archive rule was added there, and any other
  // edge cases where a ticket has ≥1 AUTO_RESPONDER message and zero
  // INBOUND messages but is not yet archived. Idempotent: re-running it
  // on an already-archived ticket is a no-op (filtered by isArchived).
  try {
    await sweepArchiveArOnlyTickets();
  } catch (err) {
    console.error(
      "[helpdesk-sync] AR-only archive sweep failed",
      err instanceof Error ? err.message : err,
    );
  }

  try {
    await sweepAdoptRecentCrossListingPreSalesTickets(integrations);
  } catch (err) {
    console.error(
      "[helpdesk-sync] cross-listing pre-sales adoption sweep failed",
      err instanceof Error ? err.message : err,
    );
  }

  // End-of-tick read-state reconciliation against the eBay web UI.
  //
  // eBay runs two disjoint read-state stores: the legacy Trading API
  // (GetMyMessages / ReviseMyMessages) and the modern Commerce Message
  // API (/commerce/message/v1, which drives ebay.com/mesg). They can
  // report different READ/UNREAD values for the same buyer message.
  //
  // Agents work in the eBay web UI, so Commerce Message API is the
  // authoritative source. sweepUnreadConversationsFromWebUi reconciles
  // Help Desk unread state against that store in both directions
  // (bumps locally-read→unread when CM says unread; clears locally-
  // unread→read when CM confirms the full unread set and a ticket's
  // buyer is not in it).
  //
  // The legacy Trading-API-based sweeps (sweepStaleUnreadTickets and
  // sweepStaleReadTickets) are intentionally NOT called here — they
  // race with the CM sweep and cause tickets to oscillate between
  // read/unread each tick. They're retained in this file for
  // diagnostics and potential reuse on non-buyer (SYSTEM) tickets, but
  // are no longer part of the normal sync path.
  //
  // The unread sweep also returns per-conversation eBay `last_modified_date`
  // timestamps, which we feed into sweepCommerceMessageInbound so it can
  // prioritize tickets whose eBay-side activity is newer than our DB
  // (i.e. tickets where an agent replied via the eBay web UI and the
  // reply never landed in our legacy scrape).
  let commerceActivity: CommerceActivitySignals = new Map();
  try {
    const flags = await helpdeskFlagsSnapshotAsync();
    if (flags.effectiveCanSyncReadState) {
      commerceActivity = await sweepUnreadConversationsFromWebUi(integrations);
    }
  } catch (err) {
    console.error(
      "[helpdesk-sync] web-ui read-state sweep failed",
      err instanceof Error ? err.message : err,
    );
  }

  // Ingest agent replies sent from eBay's modern web UI. Those never
  // land in the legacy Trading API "Sent" folder (which runHelpdeskPoll
  // scrapes), so without this pass Help Desk silently loses every web-UI
  // reply. Gated by the same read-state flag as the unread sweep — both
  // read the Commerce Message API and only make sense when the
  // integration's reconciliation is enabled.
  try {
    const flags = await helpdeskFlagsSnapshotAsync();
    if (flags.effectiveCanSyncReadState) {
      await sweepCommerceMessageInbound(integrations, commerceActivity);
    }
  } catch (err) {
    console.error(
      "[helpdesk-sync] commerce message inbound ingest failed",
      err instanceof Error ? err.message : err,
    );
  }

  return { durationMs: Date.now() - startedAt, summaries };
}

/**
 * Archive every not-yet-archived, non-SYSTEM, non-spam ticket whose only
 * outbound activity is auto-responder messages and which has never received
 * a buyer reply. Runs as a cheap sweep at the end of each poll tick.
 *
 * Safety:
 *   - Excludes SYSTEM tickets (those belong in "From eBay", not Archived).
 *   - Excludes spam.
 *   - Requires `messages.some.source = AUTO_RESPONDER` (don't archive
 *     agent-only outbound threads).
 *   - Requires `messages.none.direction = INBOUND` (don't archive anything
 *     with a buyer reply — that's the bounce-out rule).
 *   - Capped to 500 tickets per sweep to keep the write small; the next
 *     poll will catch any stragglers.
 */
async function sweepArchiveArOnlyTickets(): Promise<void> {
  const candidates = await db.helpdeskTicket.findMany({
    where: {
      isArchived: false,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      messages: {
        some: { source: HelpdeskMessageSource.AUTO_RESPONDER },
        none: { direction: HelpdeskMessageDirection.INBOUND },
      },
    },
    select: { id: true },
    take: 500,
  });
  if (candidates.length === 0) return;
  const now = new Date();
  const result = await db.helpdeskTicket.updateMany({
    where: { id: { in: candidates.map((t) => t.id) } },
    data: {
      isArchived: true,
      archivedAt: now,
      status: HelpdeskTicketStatus.RESOLVED,
    },
  });
  console.info(
    "[helpdesk-sync] AR-only archive sweep archived tickets",
    { archived: result.count, sampled: candidates.length },
  );
}

/**
 * Max stale-unread messages to verify against eBay per tick.
 *
 * Each chunk of 10 = 1 GetMyMessages call. Capped so one tick costs at most
 * ~5 API calls per integration (= 10 calls total for TPP + TT), well under
 * eBay Trading API daily quotas even at 5-minute cron cadence.
 */
const MAX_STALE_UNREAD_PER_TICK = 50;

/**
 * Reconcile local tickets where `unreadCount > 0` against eBay's current
 * read state, regardless of how old the last inbound message is. This plugs
 * the hole where reconcileEbayReadState (running only on the 7-day
 * incremental window) never re-checks older threads after an agent reads or
 * marks them unread directly on eBay.
 *
 * Strategy:
 *   1. Pick up to MAX_STALE_UNREAD_PER_TICK tickets per integration with
 *      unreadCount > 0, prioritized oldest-first (largest drift).
 *   2. For each ticket, grab its latest INBOUND ebayMessageId.
 *   3. Batch 10 IDs per GetMyMessages call (ReturnMessages detail level —
 *      this returns Read state as part of the body).
 *   4. Feed the results into reconcileEbayReadState, which already owns
 *      the read=true -> clear unread + auto-resolve logic and the
 *      read=false -> re-mark unread logic.
 *
 * Skips SYSTEM tickets (those belong in "From eBay" and must never sync
 * read state) and spam. Gated by effectiveCanSyncReadState at the caller.
 */
async function sweepStaleUnreadTickets(
  integrations: Integration[],
): Promise<void> {
  for (const integration of integrations) {
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) continue;

    const tickets = await db.helpdeskTicket.findMany({
      where: {
        integrationId: integration.id,
        unreadCount: { gt: 0 },
        isSpam: false,
        type: { not: HelpdeskTicketType.SYSTEM },
      },
      select: {
        id: true,
        messages: {
          where: {
            direction: HelpdeskMessageDirection.INBOUND,
            ebayMessageId: { not: null },
          },
          orderBy: { sentAt: "desc" },
          take: 1,
          select: { ebayMessageId: true },
        },
      },
      orderBy: { lastBuyerMessageAt: "asc" },
      take: MAX_STALE_UNREAD_PER_TICK,
    });

    const messageIds: string[] = [];
    for (const t of tickets) {
      const mid = t.messages[0]?.ebayMessageId;
      if (mid) messageIds.push(mid);
    }
    if (messageIds.length === 0) continue;

    const allBodies: EbayMessageBody[] = [];
    for (let i = 0; i < messageIds.length; i += 10) {
      const chunk = messageIds.slice(i, i + 10);
      try {
        const bodies = await getMyMessagesBodies(integration.id, config, chunk);
        allBodies.push(...bodies);
      } catch (err) {
        console.warn(
          "[helpdesk-sync] stale unread chunk failed",
          {
            integrationId: integration.id,
            chunkSize: chunk.length,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    if (allBodies.length === 0) continue;

    await reconcileEbayReadState(integration.id, allBodies);

    console.info(
      "[helpdesk-sync] stale unread sweep checked tickets",
      {
        integrationId: integration.id,
        ticketsProbed: tickets.length,
        messagesVerified: allBodies.length,
      },
    );
  }
}

/**
 * Max stale-READ tickets to verify against eBay per tick. Matches the
 * unread budget so both sweeps together cost ~10 GetMyMessages calls per
 * tick across TPP + TT, well under eBay Trading API daily quotas even at
 * 5-minute cron cadence.
 */
const MAX_STALE_READ_PER_TICK = 50;

/**
 * Mirror of sweepStaleUnreadTickets in the opposite direction. Reconciles
 * local tickets where `unreadCount = 0` against eBay's current read state,
 * catching the case where an agent marked a ticket unread directly on eBay
 * on a thread older than the 7-day incremental window.
 *
 * Strategy:
 *   1. Count eligible tickets (unreadCount=0, non-spam, non-SYSTEM, has an
 *      INBOUND message with an ebayMessageId).
 *   2. Pick a RANDOM slice of MAX_STALE_READ_PER_TICK tickets via a
 *      random skip offset. Random sampling is required because confirm-only
 *      probes (local read + eBay read = no drift) don't bump updatedAt —
 *      reconcileEbayReadState only writes on actual state changes — so any
 *      deterministic ordering would hammer the same 50 tickets every tick
 *      forever. Random coverage probabilistically reaches every ticket.
 *   3. For each ticket, grab its latest INBOUND ebayMessageId.
 *   4. Batch 10 IDs per GetMyMessages call (ReturnMessages detail level —
 *      returns Read state as part of the body). Message-ID lookup is NOT
 *      bounded by eBay's 7-day header window.
 *   5. Feed results into reconcileEbayReadState, which flips local to
 *      unreadCount=1 for any message where eBay reports Read=false.
 *
 * Note: this sweep never pushes state to eBay — it's a pure pull.
 *
 * Skips SYSTEM tickets (those belong in "From eBay" and must never sync
 * read state) and spam. Gated by effectiveCanSyncReadState at the caller.
 */
async function sweepStaleReadTickets(
  integrations: Integration[],
): Promise<void> {
  for (const integration of integrations) {
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) continue;

    const where = {
      integrationId: integration.id,
      unreadCount: 0,
      isSpam: false,
      type: { not: HelpdeskTicketType.SYSTEM },
      // Must have at least one inbound message we can probe — outbound-only
      // threads have no buyer message on eBay to verify read state against.
      messages: {
        some: {
          direction: HelpdeskMessageDirection.INBOUND,
          ebayMessageId: { not: null },
        },
      },
    } as const;

    const eligibleCount = await db.helpdeskTicket.count({ where });
    if (eligibleCount === 0) continue;

    // Random slice across the eligible population. If there are fewer
    // tickets than the per-tick budget we just grab them all (skip=0).
    const skip =
      eligibleCount <= MAX_STALE_READ_PER_TICK
        ? 0
        : Math.floor(Math.random() * (eligibleCount - MAX_STALE_READ_PER_TICK));

    const tickets = await db.helpdeskTicket.findMany({
      where,
      select: {
        id: true,
        messages: {
          where: {
            direction: HelpdeskMessageDirection.INBOUND,
            ebayMessageId: { not: null },
          },
          orderBy: { sentAt: "desc" },
          take: 1,
          select: { ebayMessageId: true },
        },
      },
      // Deterministic ordering so `skip` is meaningful; `id` (cuid) gives
      // stable pagination without a second index lookup.
      orderBy: { id: "asc" },
      skip,
      take: MAX_STALE_READ_PER_TICK,
    });

    const messageIds: string[] = [];
    for (const t of tickets) {
      const mid = t.messages[0]?.ebayMessageId;
      if (mid) messageIds.push(mid);
    }
    if (messageIds.length === 0) continue;

    const allBodies: EbayMessageBody[] = [];
    for (let i = 0; i < messageIds.length; i += 10) {
      const chunk = messageIds.slice(i, i + 10);
      try {
        const bodies = await getMyMessagesBodies(integration.id, config, chunk);
        allBodies.push(...bodies);
      } catch (err) {
        console.warn(
          "[helpdesk-sync] stale read chunk failed",
          {
            integrationId: integration.id,
            chunkSize: chunk.length,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }

    if (allBodies.length === 0) continue;

    await reconcileEbayReadState(integration.id, allBodies);

    console.info(
      "[helpdesk-sync] stale read sweep checked tickets",
      {
        integrationId: integration.id,
        ticketsProbed: tickets.length,
        messagesVerified: allBodies.length,
      },
    );
  }
}

// ΓöÇΓöÇΓöÇ Per-integration / per-folder logic ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async function pollIntegrationFolder(
  integration: Integration,
  folderID: number,
  folderKey: string,
): Promise<HelpdeskPollSummary> {
  const summary: HelpdeskPollSummary = {
    integrationId: integration.id,
    platform: integration.platform,
    folder: folderKey,
    probedNewCount: 0,
    probedTotalCount: 0,
    headersFetched: 0,
    bodiesFetched: 0,
    ticketsCreated: 0,
    ticketsUpdated: 0,
    messagesInserted: 0,
    backfillAdvanced: false,
    backfillDone: false,
  };

  const config = buildEbayConfig(integration);
  if (!config.appId || !config.refreshToken) {
    summary.error = "missing eBay credentials";
    return summary;
  }

  const checkpoint = await db.helpdeskSyncCheckpoint.upsert({
    where: { integrationId_folder: { integrationId: integration.id, folder: folderKey } },
    create: { integrationId: integration.id, folder: folderKey },
    update: {},
  });

  // ΓöÇΓöÇ Stage 1: cheap probe ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const probe = await getMyMessagesSummary(integration.id, config, folderID);
  summary.probedNewCount = probe.newMessageCount;
  summary.probedTotalCount = probe.totalMessageCount;

  const probeMod = probe.lastModifiedTime ? new Date(probe.lastModifiedTime) : null;
  const wmTime = checkpoint.lastWatermark ? checkpoint.lastWatermark.getTime() : 0;
  const probeNewer = probeMod ? probeMod.getTime() > wmTime : false;
  const hasNew = probe.newMessageCount > 0 || probeNewer;
  const needsBackfill = !checkpoint.backfillDone;

  // No new messages and backfill is done? Bail with just the probe cost.
  if (!hasNew && !needsBackfill) {
    return summary;
  }

  // ΓöÇΓöÇ Stage 2: pull headers for the appropriate window ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const now = new Date();
  let windowStart: Date;
  let windowEnd: Date;

  if (needsBackfill) {
    // Walk backwards from (lastFullSyncAt or now) toward (now - BACKFILL_DAYS)
    // in HEADERS_WINDOW_DAYS steps. Cursor stores the next window's END.
    const horizonStart = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
    windowEnd = checkpoint.backfillCursor ?? now;
    if (windowEnd.getTime() <= horizonStart.getTime()) {
      // Already past the horizon ΓÇö backfill is done.
      await db.helpdeskSyncCheckpoint.update({
        where: { id: checkpoint.id },
        data: { backfillDone: true, lastFullSyncAt: now },
      });
      summary.backfillDone = true;
      return summary;
    }
    windowStart = new Date(
      Math.max(
        horizonStart.getTime(),
        windowEnd.getTime() - HEADERS_WINDOW_DAYS * 86_400_000,
      ),
    );
  } else {
    // Incremental: pull last 7 days from the watermark, padded by 1 hour.
    const watermark = checkpoint.lastWatermark
      ? new Date(checkpoint.lastWatermark.getTime() - 60 * 60 * 1000)
      : new Date(now.getTime() - HEADERS_WINDOW_DAYS * 86_400_000);
    windowStart = watermark;
    windowEnd = now;
  }

  const headers = await getMyMessagesHeaders(integration.id, config, {
    startTime: windowStart,
    endTime: windowEnd,
    folderID,
  });
  summary.headersFetched = headers.length;

  // Filter out headers we already have a message for.
  const externalIds = headers.map((h) => h.messageID).filter(Boolean);
  let existingExternalIds = new Set<string>();
  if (externalIds.length > 0) {
    const existing = await db.helpdeskMessage.findMany({
      where: {
        ebayMessageId: { in: externalIds },
        ticket: { integrationId: integration.id },
      },
      select: { ebayMessageId: true },
    });
    existingExternalIds = new Set(
      existing.map((e) => e.ebayMessageId).filter(Boolean) as string[],
    );
  }
  const missing = headers.filter(
    (h) => h.messageID && !existingExternalIds.has(h.messageID),
  );

  // ΓöÇΓöÇ Read-state reconciliation (inbound, opt-in) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  // If the eBay UI was used to mark messages read, mirror that into reorG so
  // the agent doesn't see the same red-dot twice. We only flow eBayΓåÆreorG when
  // a message is now read on eBay (one-directional). Going the other way
  // (eBay says unread ΓåÆ reorG marks unread) would constantly fight an agent
  // who already triaged a thread in reorG.
  //
  // Intentionally not calling reconcileEbayReadState here: its source
  // (GetMyMessages headers) reports the legacy Trading API's Read flag,
  // which disagrees with what agents actually see on ebay.com/mesg for
  // modern buyer Q&A. End-of-tick sweepUnreadConversationsFromWebUi
  // (Commerce Message API) is the authoritative reconcile path for
  // buyer tickets. SYSTEM tickets never sync read state in either
  // direction, so nothing is lost by skipping the Trading-API path here.
  //
  // Flag snapshot still read so downstream flag-dependent code in this
  // function sees the same snapshot as the rest of the sync tick.
  await helpdeskFlagsSnapshotAsync();

  // Pre-load enabled filters once per folder pull so the per-message engine
  // doesn't hit the DB for each new inbound message.
  const filters = await db.helpdeskFilter.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
  });

  // ΓöÇΓöÇ Stage 3: hydrate bodies in chunks ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  const startedAt = Date.now();
  let chunksFetched = 0;
  let processedUpTo = 0;
  for (let i = 0; i < missing.length; i += 10) {
    if (chunksFetched >= MAX_BODY_CHUNKS_PER_TICK) break;
    if (Date.now() - startedAt > 55_000) break;
    const chunk = missing.slice(i, i + 10);
    const ids = chunk.map((c) => c.messageID).filter(Boolean);
    if (ids.length === 0) continue;
    const bodies = await getMyMessagesBodies(integration.id, config, ids);
    summary.bodiesFetched += bodies.length;
    chunksFetched++;
    processedUpTo = i + chunk.length;
    const reconciled = await reconcileMessages({
      integration,
      folderKey,
      bodies,
      filters,
    });
    summary.ticketsCreated += reconciled.ticketsCreated;
    summary.ticketsUpdated += reconciled.ticketsUpdated;
    summary.messagesInserted += reconciled.messagesInserted;
  }
  const allMissingProcessed = processedUpTo >= missing.length;
  const processedHeaders = missing.slice(0, processedUpTo);

  // ΓöÇΓöÇ Update checkpoint ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
  if (needsBackfill) {
    // Only advance the cursor past this window when ALL missing messages
    // in the window were processed. Otherwise the next tick retries the
    // same window and picks up the remaining messages.
    if (allMissingProcessed) {
      const advancedCursor = windowStart;
      const backfillNowDone =
        advancedCursor.getTime() <= now.getTime() - BACKFILL_DAYS * 86_400_000;
      await db.helpdeskSyncCheckpoint.update({
        where: { id: checkpoint.id },
        data: {
          backfillCursor: advancedCursor,
          backfillDone: backfillNowDone,
          lastFullSyncAt: backfillNowDone ? now : checkpoint.lastFullSyncAt,
        },
      });
      summary.backfillAdvanced = true;
      summary.backfillDone = backfillNowDone;
    }
  } else {
    // Only advance the watermark to the latest receive time of messages
    // we actually fetched bodies for — never jump past unprocessed ones.
    const latest = processedHeaders
      .map((m) => (m.receiveDate ? new Date(m.receiveDate).getTime() : 0))
      .reduce((max, t) => (t > max ? t : max), wmTime);
    await db.helpdeskSyncCheckpoint.update({
      where: { id: checkpoint.id },
      data: {
        lastWatermark: latest > 0 ? new Date(latest) : undefined,
        lastFullSyncAt: now,
      },
    });
  }

  return summary;
}

// ΓöÇΓöÇΓöÇ Reconciliation: header ΓåÆ ticket + message ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

interface ReconcileArgs {
  integration: Integration;
  folderKey: string;
  bodies: EbayMessageBody[];
  /** Enabled HelpdeskFilters loaded once per sync pass. */
  filters: HelpdeskFilter[];
}

interface ReconcileResult {
  ticketsCreated: number;
  ticketsUpdated: number;
  messagesInserted: number;
}

async function reconcileMessages(args: ReconcileArgs): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    ticketsCreated: 0,
    ticketsUpdated: 0,
    messagesInserted: 0,
  };

  // Build a Set of eBay message IDs that originated from our Auto Responder
  // for this batch, so we can tag the resulting HelpdeskMessage rows with
  // source=AUTO_RESPONDER instead of the catch-all EBAY/EBAY_UI. We match by
  // the externalMessageId that AR persisted on the SendLog row when the
  // send succeeded — that's exactly the same id eBay will hand us back on
  // the next inbox/sent sync. One query per batch (vs. per message) keeps
  // the worker O(N) instead of O(N²).
  const outboundMessageIds = args.bodies
    .filter((b) => inferDirection(b, args.folderKey) === HelpdeskMessageDirection.OUTBOUND)
    .map((b) => b.messageID)
    .filter((id): id is string => Boolean(id));
  const arMessageIds = new Set<string>();
  if (outboundMessageIds.length > 0) {
    const arRows = await db.autoResponderSendLog.findMany({
      where: {
        integrationId: args.integration.id,
        externalMessageId: { in: outboundMessageIds },
        eventType: "SENT",
      },
      select: { externalMessageId: true },
    });
    for (const r of arRows) {
      if (r.externalMessageId) arMessageIds.add(r.externalMessageId);
    }
  }

  for (const body of args.bodies) {
    if (!body.messageID) continue;
    // Envelope-level direction governs the *primary* HelpdeskMessage row
    // we insert (the digest envelope itself, used for filters/threading).
    // Per-sub-message directions for digest-exploded historical rows are
    // resolved later from the parser's structured output. We alias to
    // `direction` to keep the rest of this loop's existing logic intact.
    const envelopeDirection = inferDirection(body, args.folderKey);
    const direction = envelopeDirection;

    const sentAt = body.receiveDate ? new Date(body.receiveDate) : new Date();
    const subject = body.subject?.trim() || null;
    const itemId = body.itemID?.trim() || null;

    // Extract an eBay order number from the message itself (subject or body).
    // Auto-responder messages always include "Your order (#NN-NNNNN-NNNNN)";
    // many buyer replies also quote the order number. We capture it here so
    // the ticket can show it without an extra API round-trip. This has to
    // happen BEFORE the buyer resolver and computeThreadKey because both
    // use it (resolver as the saleOrder fallback, threadKey as the primary
    // grouping key).
    const extractedOrderNumber = extractEbayOrderNumber(body);

    // Resolve the *real* buyer for this message. The digest-aware resolver
    // first scans the HTML body for a `/usr/<buyer>` link (which the eBay
    // template embeds in every history-block heading), then falls back to
    // the standard envelope-level resolver (sender / recipient / body
    // salutation / MarketplaceSaleOrder). This is the single source of
    // truth for buyer identity throughout sync — keep all downstream
    // `buyerUserId` writes in sync with the value here so we never store
    // "eBay" or our seller name.
    const resolved: ResolvedBuyer = await resolveBuyerForDigest({
      body,
      integration: args.integration,
      orderNumber: extractedOrderNumber,
      digestHtml: body.text,
    });
    const buyerUserId = resolved.buyerUserId;
    const buyerName = resolved.buyerName;
    const buyerEmail = resolved.buyerEmail;

    // Hardcoded From-eBay detection runs BEFORE computeThreadKey so system
    // notifications can be routed into dedicated sys: threadKeys, keeping
    // them isolated from buyer conversation tickets on the same order. See
    // the detection comment further down for the full rationale.
    const fromEbayResult =
      direction === HelpdeskMessageDirection.INBOUND
        ? detectFromEbay({
            sender: body.sender ?? null,
            subject,
            bodyText: body.text ?? null,
            ebayQuestionType: body.questionType ?? null,
          })
        : null;
    const isCancellationRequest =
      direction === HelpdeskMessageDirection.INBOUND
        ? detectCancellationRequest({
            sender: body.sender ?? null,
            subject,
            bodyText: body.text ?? null,
          })
        : false;

    const threadKey = computeThreadKey(
      body,
      buyerUserId,
      extractedOrderNumber,
      fromEbayResult,
    );
    if (!threadKey) continue;

    const isPreSales =
      !!itemId &&
      !buyerOrderHint(body) &&
      body.questionType !== "Shipping" &&
      !extractedOrderNumber;

    let ticket = await db.helpdeskTicket.findUnique({
      where: {
        integrationId_threadKey: {
          integrationId: args.integration.id,
          threadKey,
        },
      },
    });
    let crossListingInquiry: CrossListingInquiryContext | null = null;

    // Pre-sales → post-sales adoption. If this message has an order number
    // (threadKey=ord:...) and we don't have a ticket at that key yet, look
    // for an existing *pre-sales* ticket on the same {itemId, buyer} pair
    // that hasn't been stamped with an order yet. If one exists, we adopt
    // it: rewrite its threadKey from `itm:...` to `ord:...` so the
    // pre-sales message history follows the buyer into the order.
    //
    // Safety: we only adopt when `ebayOrderNumber` is NULL on the existing
    // ticket. If the existing itm:-keyed ticket already has an order
    // stamped, it belongs to a *different* earlier order and we must leave
    // it alone.
    if (!ticket && extractedOrderNumber && itemId && buyerUserId) {
      const preSalesKey = `itm:${itemId}|buyer:${buyerUserId.toLowerCase()}`;
      {
        const preSalesTicket = await db.helpdeskTicket.findUnique({
          where: {
            integrationId_threadKey: {
              integrationId: args.integration.id,
              threadKey: preSalesKey,
            },
          },
        });
        if (preSalesTicket && preSalesTicket.ebayOrderNumber === null) {
          // Adopt it: re-key and stamp the order number. We don't change
          // kind here — the branch below handles pre-sales → post-sales
          // reclassification via ticketUpdate.kind.
          ticket = await db.helpdeskTicket.update({
            where: { id: preSalesTicket.id },
            data: {
              threadKey,
              ebayOrderNumber: extractedOrderNumber,
            },
          });
        }
      }
    }

    // Buyer-agnostic → buyer-identified adoption. Sent-folder messages
    // may create tickets keyed as `ord:<order>` (no buyer) because the
    // eBay API sets both sender and recipientUserID to the seller's own
    // handle in the sent folder. When a later inbox message arrives with
    // the correct buyer, the threadKey is `ord:<order>|buyer:<buyer>`.
    // If we don't have a ticket at that key yet, look for an existing
    // buyer-agnostic ticket at `ord:<order>` and adopt it.
    if (!ticket && extractedOrderNumber && buyerUserId) {
      const agnosticKey = `ord:${extractedOrderNumber}`;
      const agnosticTicket = await db.helpdeskTicket.findUnique({
        where: {
          integrationId_threadKey: {
            integrationId: args.integration.id,
            threadKey: agnosticKey,
          },
        },
      });
      if (agnosticTicket) {
        ticket = await db.helpdeskTicket.update({
          where: { id: agnosticTicket.id },
          data: {
            threadKey,
            buyerUserId,
            buyerName: buyerName ?? agnosticTicket.buyerName,
            buyerEmail: buyerEmail ?? agnosticTicket.buyerEmail,
          },
        });
      }
    }

    // Reverse adoption (item-only message → existing order ticket).
    //
    // Scenario from Adam's screenshots: we send the auto-responder on
    // order 03-14496-19535 (creates `ord:...|buyer:...` ticket, then
    // archived). The buyer later replies *without quoting the order
    // number* — eBay routes it on the listing's contact-seller flow, so
    // `extractedOrderNumber` is null and the buyer's body.itemID is the
    // listing they bought. We'd compute `itm:<listing>|buyer:<buyer>`
    // and create a brand-new ticket, leaving the AR archived and the
    // reply orphaned in a different ticket.
    //
    // The fix: when threadKey is `itm:...|buyer:...` and we have no
    // ticket at that key, look up MarketplaceSaleOrder for orders this
    // buyer placed on this listing. If we find one, look for an
    // existing `ord:<orderNumber>|buyer:...` ticket and adopt it. This
    // merges the buyer's reply into the AR ticket and the inbound-
    // status logic above will bounce it out of archive into TO_DO.
    if (
      !ticket &&
      !extractedOrderNumber &&
      itemId &&
      buyerUserId &&
      threadKey.startsWith("itm:")
    ) {
      const candidateOrders = await db.marketplaceSaleOrder.findMany({
        where: {
          platform: args.integration.platform,
          buyerIdentifier: { equals: buyerUserId, mode: "insensitive" },
          lines: { some: { platformItemId: itemId } },
        },
        select: { externalOrderId: true, orderDate: true },
        orderBy: { orderDate: "desc" },
        take: 5,
      });
      for (const order of candidateOrders) {
        const orderTicketKey = `ord:${order.externalOrderId}|buyer:${buyerUserId.toLowerCase()}`;
        const existingOrderTicket = await db.helpdeskTicket.findUnique({
          where: {
            integrationId_threadKey: {
              integrationId: args.integration.id,
              threadKey: orderTicketKey,
            },
          },
        });
        if (existingOrderTicket) {
          ticket = existingOrderTicket;
          break;
        }
      }
    }

    // Cross-listing adoption (item-only message -> latest recent order ticket).
    //
    // Buyers sometimes open the seller contact box from a different listing
    // after they already have an order with us. In eBay this appears as a
    // pre-sale item conversation, but operationally it belongs with that
    // buyer's latest order thread so the agent sees the whole relationship in
    // one place. We only do this for inbound item-only messages, and only when
    // the current ticket is absent or still an unanswered pre-sales stub. The
    // source listing/conversation is stored on the message rawData so the UI
    // can explain it and outbound replies can target the correct eBay thread.
    const canCrossAdoptItemInquiry =
      direction === HelpdeskMessageDirection.INBOUND &&
      !extractedOrderNumber &&
      itemId &&
      buyerUserId &&
      threadKey.startsWith("itm:") &&
      (!ticket ||
        (ticket.kind === HelpdeskTicketKind.PRE_SALES &&
          !ticket.ebayOrderNumber &&
          !ticket.lastAgentMessageAt));
    if (canCrossAdoptItemInquiry && itemId && buyerUserId) {
      const sourceTicket = ticket;
      const orderTicket = await findLatestRecentOrderTicketForBuyer({
        integration: args.integration,
        buyerUserId,
        excludeTicketId: sourceTicket?.id ?? null,
      });
      if (orderTicket && orderTicket.id !== sourceTicket?.id) {
        ticket = orderTicket;
        crossListingInquiry =
          orderTicket.ebayItemId && orderTicket.ebayItemId === itemId
            ? null
            : {
                sourceItemId: itemId,
                sourceItemTitle: extractItemTitleFromSubject(subject, itemId),
                sourceSubject: subject || null,
                sourceConversationId: sourceTicket?.ebayConversationId ?? null,
                targetTicketId: orderTicket.id,
                targetOrderNumber: orderTicket.ebayOrderNumber,
                targetItemId: orderTicket.ebayItemId,
              };
      }
    }

    const ticketUpdate: Prisma.HelpdeskTicketUpdateInput = {};
    if (direction === HelpdeskMessageDirection.INBOUND) {
      ticketUpdate.lastBuyerMessageAt = sentAt;
      ticketUpdate.unreadCount = { increment: 1 };
      if (ticket) {
        // Route the ticket through the pure status helper. The helper knows
        // the eDesk semantics (every non-spam buyer message → TO_DO; that
        // includes RESOLVED reopens AND archived bounces).
        const next = deriveStatusOnInbound({
          status: ticket.status,
          hasAgentReplied: ticket.lastAgentMessageAt !== null,
          isArchived: ticket.isArchived,
          isSpam: ticket.isSpam,
        });
        if (next !== ticket.status) {
          ticketUpdate.status = next;
        }
        // Reopen bookkeeping is only relevant when we resurrect a RESOLVED
        // ticket — otherwise we'd inflate reopenCount on every buyer message
        // in a normal back-and-forth.
        if (ticket.status === HelpdeskTicketStatus.RESOLVED) {
          ticketUpdate.reopenCount = { increment: 1 };
          ticketUpdate.lastReopenedAt = new Date();
        }
        // Bounce-out-of-archive: the user's explicit spec is that a buyer
        // reply on an archived ticket re-opens it to To Do. We clear the
        // archive flag here (the status helper itself can't touch it
        // because it's pure). Spam tickets are deliberately NOT bounced —
        // SPAM is an explicit agent decision and the spammer messaging
        // again shouldn't resurrect the thread.
        if (ticket.isArchived && !ticket.isSpam) {
          ticketUpdate.isArchived = false;
          ticketUpdate.archivedAt = null;
        }
        // Wake any active snooze: a new buyer message means the agent's
        // "remind me later" is now moot.
        if (ticket.snoozedUntil) {
          ticketUpdate.snoozedUntil = null;
          if (ticket.snoozedById) {
            ticketUpdate.snoozedBy = { disconnect: true };
          }
        }
      }
    } else {
      ticketUpdate.lastAgentMessageAt = sentAt;
      // Mark first response if not yet set.
      if (ticket && !ticket.firstResponseAt) {
        ticketUpdate.firstResponseAt = sentAt;
      }
    }

    // Auto-detect generic ticket type from this message (subject + body +
    // eBay questionType). Skipped when From-eBay/Cancellation already
    // pinned the type so we don't downgrade a SYSTEM/CANCELLATION ticket
    // back to QUERY.
    const detectedType: HelpdeskTicketType | null = isCancellationRequest
      ? HelpdeskTicketType.CANCELLATION
      : fromEbayResult?.isFromEbay
        ? HelpdeskTicketType.SYSTEM
        : direction === HelpdeskMessageDirection.INBOUND
          ? detectTicketType({
              ebayQuestionType: body.questionType ?? null,
              subject,
              bodyText: body.text ?? null,
            })
          : null;

    if (!ticket) {
      ticket = await db.helpdeskTicket.create({
        data: {
          integrationId: args.integration.id,
          channel: args.integration.platform,
          threadKey,
          buyerUserId,
          buyerName,
          buyerEmail,
          ebayItemId: itemId,
          ebayOrderNumber: extractedOrderNumber,
          subject,
          kind: isPreSales ? HelpdeskTicketKind.PRE_SALES : HelpdeskTicketKind.POST_SALES,
          ...(detectedType ? { type: detectedType } : {}),
          ...(fromEbayResult?.isFromEbay && fromEbayResult.systemMessageType
            ? { systemMessageType: fromEbayResult.systemMessageType }
            : {}),
          // v2 folder semantics: every unanswered buyer message lives in
          // TO_DO. The legacy NEW value is preserved in the enum for
          // historical rows but new tickets never start there. Outbound-only
          // creates (rare — usually we see the buyer message first) still
          // start in WAITING because we just spoke last.
          status:
            direction === HelpdeskMessageDirection.INBOUND
              ? HelpdeskTicketStatus.TO_DO
              : HelpdeskTicketStatus.WAITING,
          lastBuyerMessageAt:
            direction === HelpdeskMessageDirection.INBOUND ? sentAt : null,
          lastAgentMessageAt:
            direction === HelpdeskMessageDirection.OUTBOUND ? sentAt : null,
          unreadCount: direction === HelpdeskMessageDirection.INBOUND ? 1 : 0,
        },
      });
      result.ticketsCreated++;
    } else {
      // Backfill an existing post-sales ticket with the order number when we
      // see one on a later message in the thread.
      if (extractedOrderNumber && !ticket.ebayOrderNumber) {
        ticketUpdate.ebayOrderNumber = extractedOrderNumber;
      }
      // Backfill buyer fields if they're missing or were previously stored
      // as a system value ("eBay") or our seller name. We only overwrite
      // when the resolver gave us a confident answer this round; leaving
      // the bad value in place is a no-op the repair script can fix later.
      const sellerLower = (
        (args.integration.config as Record<string, unknown>)?.accountUserId as string | undefined
      )?.toLowerCase() ?? null;
      const existingLower = ticket.buyerUserId?.toLowerCase() ?? null;
      const existingIsBad =
        !existingLower ||
        existingLower === "ebay" ||
        (sellerLower !== null && existingLower === sellerLower);
      if (buyerUserId && existingIsBad) {
        ticketUpdate.buyerUserId = buyerUserId;
      }
      // Update buyerName when:
      //   - it's missing OR the userId was previously bad (legacy fix), OR
      //   - we just discovered a real "First Last" that's distinct from the
      //     stored username. We never replace a real human name with a
      //     username — only the other way around.
      const newNameIsRealHuman =
        !!buyerName &&
        buyerName.toLowerCase() !==
          (buyerUserId ?? ticket.buyerUserId ?? "").toLowerCase();
      const storedNameIsJustUsername =
        !!ticket.buyerName &&
        ticket.buyerName.toLowerCase() ===
          (ticket.buyerUserId ?? "").toLowerCase();
      if (
        buyerName &&
        (!ticket.buyerName ||
          existingIsBad ||
          (newNameIsRealHuman && storedNameIsJustUsername))
      ) {
        ticketUpdate.buyerName = buyerName;
      }
      if (buyerEmail && !ticket.buyerEmail) {
        ticketUpdate.buyerEmail = buyerEmail;
      }
      // If a ticket was originally classified as pre-sales but a later
      // message reveals an order number, re-classify it as post-sales so it
      // moves into the right folder.
      if (
        extractedOrderNumber &&
        ticket.kind === HelpdeskTicketKind.PRE_SALES
      ) {
        ticketUpdate.kind = HelpdeskTicketKind.POST_SALES;
      }
      // Type upgrade: if an agent hasn't manually picked a type yet AND the
      // current type is still the default QUERY, let a stronger signal in a
      // later message reclassify the ticket (e.g. buyer's first message was
      // generic, second message says "I want to return this"). We never
      // overwrite a non-default type or an explicit override.
      //
      // Hardcoded SYSTEM/CANCELLATION detection is treated as authoritative:
      // even if the ticket's current type was already upgraded to (say)
      // RETURN_REQUEST by an earlier heuristic, an unmistakable eBay system
      // notification or cancellation request lands the ticket in the right
      // bucket. We still respect an explicit human override (typeOverridden).
      if (detectedType && !ticket.typeOverridden) {
        const isHardcodedDetection =
          detectedType === HelpdeskTicketType.SYSTEM ||
          detectedType === HelpdeskTicketType.CANCELLATION;
        // Defensive guard: NEVER flip an existing conversation ticket into
        // SYSTEM. The threadKey routing above already isolates system
        // notifications into their own sys:... tickets, but this guard
        // protects legacy rows (created before the routing fix) from being
        // silently reclassified and hidden in the "From eBay" folder while
        // they still hold buyer/agent correspondence.
        const wouldDemoteToSystem =
          detectedType === HelpdeskTicketType.SYSTEM &&
          ticket.type !== HelpdeskTicketType.SYSTEM;
        if (
          !wouldDemoteToSystem &&
          (isHardcodedDetection ||
            (ticket.type === "QUERY" && detectedType !== "QUERY"))
        ) {
          ticketUpdate.type = detectedType;
        }
      }
      // Stamp/refresh the system message sub-type whenever this message is
      // a recognized From-eBay notification AND the ticket is already a
      // SYSTEM ticket (post-routing). Never stamp it on a conversation
      // ticket — the threadKey split above means we should never hit this
      // path for mixed tickets, but we're defensive in case of legacy data.
      if (
        fromEbayResult?.isFromEbay &&
        fromEbayResult.systemMessageType &&
        ticket.type === HelpdeskTicketType.SYSTEM
      ) {
        ticketUpdate.systemMessageType = fromEbayResult.systemMessageType;
      }
    }

    if (Object.keys(ticketUpdate).length > 0 && ticket.id) {
      ticket = await db.helpdeskTicket.update({
        where: { id: ticket.id },
        data: ticketUpdate,
      });
      result.ticketsUpdated++;
    }

    // Insert message (idempotent on (ticketId, externalId))
    let inserted = false;
    let duplicateEnvelope = false;
    const messageBodyText = body.text ?? "";
    const sellerUserIdLower = getSellerUserId(args.integration)?.toLowerCase() ?? null;
    const rawSender = body.sender?.trim() || null;
    const senderIsSeller =
      rawSender != null &&
      sellerUserIdLower != null &&
      rawSender.toLowerCase() === sellerUserIdLower;
    const messageFromName =
      direction === HelpdeskMessageDirection.INBOUND
        ? (senderIsSeller ? buyerName ?? buyerUserId : rawSender) ?? null
        : null;
    const messageFromIdentifier =
      direction === HelpdeskMessageDirection.INBOUND
        ? (senderIsSeller ? buyerUserId : rawSender) ?? null
        : null;

    // Source determination is delegated to a pure classifier so the
    // priority ordering (reorG envelope > AR log > catch-all EBAY_UI) is
    // unit-tested independently of the sync's prisma plumbing.
    const messageSource = classifyMessageSource({
      direction,
      ebayMessageId: body.messageID,
      externalMessageId: body.externalMessageID,
      autoResponderMessageIds: arMessageIds,
    });

    try {
      await db.helpdeskMessage.create({
        data: {
          ticketId: ticket.id,
          direction,
          source: messageSource,
          externalId: body.messageID,
          ebayMessageId: body.messageID,
          fromName: messageFromName,
          fromIdentifier: messageFromIdentifier,
          subject,
          bodyText: cleanMessageHtml(messageBodyText),
          isHtml:
            (body.contentType ?? "").toLowerCase().includes("html") ||
            looksLikeHtmlBody(messageBodyText),
          rawMedia: (body.mediaUrls ?? []) as Prisma.InputJsonValue,
          rawData: {
            ...crossListingRawData(crossListingInquiry),
            questionType: body.questionType ?? null,
            parentMessageID: body.parentMessageID ?? null,
            recipientUserID: body.recipientUserID ?? null,
            itemID: body.itemID ?? null,
            responseDetails: body.responseDetails ?? null,
            folder: args.folderKey,
          } as Prisma.InputJsonValue,
          sentAt,
        },
      });
      result.messagesInserted++;
      inserted = true;
    } catch (err) {
      // Ignore unique-constraint duplicates; surface other errors.
      if (
        err instanceof Error &&
        err.message.includes("Unique constraint failed")
      ) {
        duplicateEnvelope = true;
      } else {
        console.error("[helpdesk-sync] message insert failed", err);
      }
    }

    if (!inserted && !duplicateEnvelope) continue;

    // ── Synced-outbound status transition. When an OUTBOUND message
    // lands and is newer than every inbound on the ticket, the ball is
    // now in the buyer's court — but the *target* status depends on
    // *how* the agent replied:
    //
    //   1. Agent typed the reply directly on eBay.com (source=EBAY_UI):
    //      we treat this as a deliberate "I'm done" signal and flip the
    //      ticket straight to RESOLVED. There's no in-app composer
    //      action here to choose RESOLVED vs WAITING, so without this
    //      auto-rule eBay-direct replies pile up in WAITING forever.
    //
    //   2. reorG outbound worker delivered the reply (source=EBAY,
    //      reorG: prefix): the composer already applied the agent's
    //      chosen status (WAITING or RESOLVED) when it queued the job.
    //      We default to WAITING but *never downgrade* a ticket that's
    //      already RESOLVED — the helper enforces that.
    //
    //   3. Auto Responder send (source=AUTO_RESPONDER): explicitly
    //      EXCLUDED. An AR is a one-way courtesy notification, not a
    //      substantive reply. Flipping TO_DO → WAITING here would hide
    //      the ticket from the agent's "needs response" queue while the
    //      buyer still hasn't actually been answered.
    //
    // Buyer follow-ups still bounce these tickets back to TO_DO via
    // `deriveStatusOnInbound` above.
    if (
      inserted &&
      direction === HelpdeskMessageDirection.OUTBOUND &&
      messageSource !== HelpdeskMessageSource.AUTO_RESPONDER &&
      ticket.status !== HelpdeskTicketStatus.RESOLVED &&
      ticket.status !== HelpdeskTicketStatus.SPAM &&
      !ticket.isArchived
    ) {
      const newerInbound = await db.helpdeskMessage.findFirst({
        where: {
          ticketId: ticket.id,
          direction: HelpdeskMessageDirection.INBOUND,
          sentAt: { gt: sentAt },
        },
        select: { id: true },
      });
      if (!newerInbound) {
        const nextStatus = deriveStatusOnSyncedOutbound(messageSource);
        if (nextStatus !== ticket.status) {
          await db.helpdeskTicket.update({
            where: { id: ticket.id },
            data: {
              status: nextStatus,
              unreadCount: 0,
              ...(nextStatus === HelpdeskTicketStatus.RESOLVED
                ? { resolvedAt: sentAt }
                : {}),
            },
          });
        }
      }
    }

    // ── Digest expansion: eBay's GetMyMessages returns each notification
    // as a single HTML "digest" body that contains the *entire* recent
    // conversation history embedded in `<div id="UserInputtedText[N]">`
    // blocks (one per historical message). The envelope row we inserted
    // above represents the digest itself; here we explode the historical
    // sub-messages into their own HelpdeskMessage rows so the agent sees
    // every individual buyer/agent/AR turn instead of one giant blob.
    //
    // Idempotency strategy:
    //   - The parser produces a stable `externalId` per sub-message of
    //     form `<digestExternalId>:<n>`, so re-running the same digest is
    //     a no-op via the (ticketId, externalId) unique constraint.
    //   - Across DIFFERENT digests covering the same conversation we
    //     dedupe by `bodyHash` (computed in-process from existing rows).
    //
    // Direction handling:
    //   - The parser returns "inbound" / "outbound" / "unknown" per sub
    //     based on the surrounding `MessageHistory[N]` heading.
    //   - "unknown" sub-messages are skipped — they're usually the eBay
    //     boilerplate header/footer and we don't want to mis-attribute
    //     them.
    //
    // AR attribution: outbound sub-messages whose normalized bodyHash
    // matches an `AutoResponderSendLog.renderedBody` for the same
    // (integration, orderNumber) get tagged source=AUTO_RESPONDER so the
    // ThreadView renders them with the AR avatar/label instead of as a
    // generic agent message.
    if (body.text && /<div\s+id="UserInputtedText\d*"/i.test(body.text)) {
      try {
        const parsed = parseEbayDigest({
          bodyHtml: body.text,
          digestExternalId: body.messageID,
        });
        if (parsed.isDigest && parsed.subMessages.length > 0) {
          // Build hash set of existing messages on this ticket so we can
          // dedupe newly parsed sub-messages against earlier digests.
          const existing = await db.helpdeskMessage.findMany({
            where: { ticketId: ticket.id },
            select: { bodyText: true, externalId: true },
          });
          const existingHashes = new Set<string>();
          const existingExternalIds = new Set<string>();
          for (const m of existing) {
            existingHashes.add(hashBodyForMatch(m.bodyText));
            if (m.externalId) existingExternalIds.add(m.externalId);
          }

          // Pull AR send logs for this order so we can attribute outbound
          // sub-messages whose body matches an AR send. We key by hash so
          // a single equality check covers any whitespace/casing drift
          // between what we sent and what eBay echoed back.
          const arHashes = new Set<string>();
          if (extractedOrderNumber) {
            const arLogs = await db.autoResponderSendLog.findMany({
              where: {
                integrationId: args.integration.id,
                orderNumber: extractedOrderNumber,
                eventType: "SENT",
                renderedBody: { not: null },
              },
              select: { renderedBody: true },
            });
            for (const log of arLogs) {
              if (log.renderedBody) {
                arHashes.add(hashBodyForMatch(log.renderedBody));
              }
            }
          }

          // Track the best buyer real-name we discover during this digest
          // expansion. We only learn first/last names from AR bodies (the
          // rest of the system stores eBay usernames). If we find one,
          // we'll patch the ticket once after the loop instead of inside
          // each iteration.
          let realBuyerNameFromAr: string | null = null;

          for (const sub of parsed.subMessages) {
            // Skip sub-messages with unknown direction — they're almost
            // always the eBay header/footer template fragments and not
            // real conversational turns.
            if (sub.direction === "unknown") continue;
            // Idempotency: skip if we've already inserted this exact sub
            // (same digest, same position) or any other row with the
            // same body hash on this ticket (covers cross-digest dupes).
            if (existingExternalIds.has(sub.externalId)) continue;
            if (existingHashes.has(sub.bodyHash)) continue;

            const subDirection =
              sub.direction === "inbound"
                ? HelpdeskMessageDirection.INBOUND
                : HelpdeskMessageDirection.OUTBOUND;

            // AR attribution: only outbound sub-messages whose hash
            // matches an AR send log for this order are tagged AR. All
            // other outbound subs get the generic EBAY source (we don't
            // know whether a human agent wrote them or eBay generated
            // them — but they're definitely "from us").
            const isArSub =
              subDirection === HelpdeskMessageDirection.OUTBOUND &&
              arHashes.has(sub.bodyHash);
            const subSource = isArSub
              ? HelpdeskMessageSource.AUTO_RESPONDER
              : subDirection === HelpdeskMessageDirection.INBOUND
                ? HelpdeskMessageSource.EBAY
                : HelpdeskMessageSource.EBAY;

            // AR bodies open with "{First Last},<br />…" — pull the real
            // human name back out so the inbox Customer column can show
            // it instead of the eBay username. Cheap regex; no DB hit.
            if (isArSub && !realBuyerNameFromAr) {
              const extracted = extractBuyerNameFromAutoResponderBody(
                sub.bodyHtml,
              );
              if (
                extracted &&
                extracted.toLowerCase() !==
                  (buyerUserId ?? "").toLowerCase()
              ) {
                realBuyerNameFromAr = extracted;
              }
            }

            const subFromName =
              subDirection === HelpdeskMessageDirection.INBOUND
                ? buyerName ?? buyerUserId ?? "Buyer"
                : isArSub
                  ? "Auto Responder"
                  : null;

            try {
              await db.helpdeskMessage.create({
                data: {
                  ticketId: ticket.id,
                  direction: subDirection,
                  source: subSource,
                  externalId: sub.externalId,
                  ebayMessageId: body.messageID,
                  fromName: subFromName,
                  fromIdentifier:
                    subDirection === HelpdeskMessageDirection.INBOUND
                      ? buyerUserId
                      : null,
                  subject: null,
                  bodyText: cleanMessageHtml(sub.bodyHtml),
                  isHtml: true,
                  rawMedia: [] as Prisma.InputJsonValue,
                  rawData: {
                    ...crossListingRawData(crossListingInquiry),
                    digestSource: body.messageID,
                    subIndex: sub.index,
                    isLive: sub.isLive,
                    folder: args.folderKey,
                  } as Prisma.InputJsonValue,
                  // Historical sub-messages don't carry their own
                  // timestamp in the digest, so we approximate using the
                  // envelope's receiveDate offset by sub-index seconds.
                  // Older subs get earlier timestamps so chronological
                  // sort order is preserved within the ticket.
                  sentAt: new Date(
                    sentAt.getTime() -
                      (parsed.subMessages.length - 1 - sub.index) * 1000,
                  ),
                },
              });
              // Track the new hash so subsequent subs in the same digest
              // dedupe against it too.
              existingHashes.add(sub.bodyHash);
              result.messagesInserted++;

              // ── Filter evaluation per sub-message. The envelope-level
              // filter check below sees only the eBay notification chrome
              // ("X has sent a question…"), never the AR / agent / buyer
              // body that actually carries the trigger text. Without this
              // pass, filters like "body contains 🚨🚨 Great News!" would
              // never fire on live ingest — they'd only catch up when an
              // admin clicks "Run filter". Apply matches once per sub
              // (idempotent on already-archived tickets).
              if (args.filters.length > 0) {
                const subMatching = pickMatchingFilters(
                  args.filters,
                  {
                    subject: null,
                    bodyText: sub.bodyHtml,
                    fromName: subFromName,
                    fromIdentifier: subFromName,
                  },
                  {
                    buyerUserId: ticket.buyerUserId,
                    buyerName: ticket.buyerName,
                  },
                );
                for (const f of subMatching) {
                  try {
                    await applyFilterAction(f, ticket.id, null);
                  } catch (err) {
                    console.error(
                      `[helpdesk-sync] sub-filter "${f.name}" apply failed for ticket ${ticket.id}`,
                      err,
                    );
                  }
                }
                if (subMatching.length > 0) {
                  await db.helpdeskFilter.updateMany({
                    where: { id: { in: subMatching.map((f) => f.id) } },
                    data: { totalHits: { increment: 1 } },
                  });
                }
              }
            } catch (err) {
              if (
                !(err instanceof Error) ||
                !err.message.includes("Unique constraint failed")
              ) {
                console.error(
                  "[helpdesk-sync] sub-message insert failed",
                  err,
                );
              }
            }
          }

          // Patch ticket.buyerName with the real "First Last" we pulled
          // out of any AR sub-message in this digest. Only overwrite when
          // the existing value is missing OR is just the eBay username
          // (we never want to clobber a real name with a different one).
          if (realBuyerNameFromAr) {
            const currentLower = (ticket.buyerName ?? "").toLowerCase();
            const usernameLower = (ticket.buyerUserId ?? "").toLowerCase();
            const looksLikeUsername =
              !currentLower || currentLower === usernameLower;
            if (looksLikeUsername) {
              try {
                await db.helpdeskTicket.update({
                  where: { id: ticket.id },
                  data: { buyerName: realBuyerNameFromAr },
                });
              } catch (err) {
                console.error(
                  "[helpdesk-sync] AR-derived buyerName update failed",
                  err,
                );
              }
            }
          }
        }

          // ── Strip the digest envelope body now that sub-messages are
          // extracted. The envelope HTML duplicates all sub-message content
          // and averages 20-50 KB. Lift any preview images onto the live
          // sub-message first so they aren't lost.
          try {
            const previewImgs = extractEnvelopePreviewImages(
              messageBodyText,
            );
            if (previewImgs.length > 0) {
              let imageTarget = await db.helpdeskMessage.findFirst({
                where: {
                  ticketId: ticket.id,
                  AND: [
                    { rawData: { path: ["digestSource"], equals: body.messageID } },
                    { rawData: { path: ["isLive"], equals: true } },
                  ],
                },
                select: { id: true, rawMedia: true },
              });

              // If the live Trading sub was skipped because the
              // Commerce-Message row already exists with the same body,
              // lift the images onto that canonical CM row instead.
              if (!imageTarget && parsed.isDigest) {
                const liveParsed = parsed.subMessages.find((sub) => sub.isLive);
                if (liveParsed && liveParsed.direction !== "unknown") {
                  const liveDirection =
                    liveParsed.direction === "inbound"
                      ? HelpdeskMessageDirection.INBOUND
                      : HelpdeskMessageDirection.OUTBOUND;
                  const candidates = await db.helpdeskMessage.findMany({
                    where: {
                      ticketId: ticket.id,
                      direction: liveDirection,
                      externalId: { startsWith: "cm:" },
                    },
                    select: { id: true, bodyText: true, rawMedia: true },
                    take: 50,
                  });
                  imageTarget =
                    candidates.find(
                      (candidate) =>
                        hashBodyForMatch(candidate.bodyText) ===
                        liveParsed.bodyHash,
                    ) ?? null;
                }
              }

              if (imageTarget) {
                const existing = Array.isArray(imageTarget.rawMedia)
                  ? (imageTarget.rawMedia as Array<{ url: string }>)
                  : [];
                const existingUrls = new Set(existing.map((e) => e.url));
                const newMedia = [
                  ...existing,
                  ...previewImgs.filter((p) => !existingUrls.has(p.url)),
                ];
                await db.helpdeskMessage.update({
                  where: { id: imageTarget.id },
                  data: { rawMedia: newMedia as unknown as Prisma.InputJsonValue },
                });
              }
            }
            await db.helpdeskMessage.updateMany({
              where: {
                ticketId: ticket.id,
                externalId: body.messageID,
              },
              data: { bodyText: envelopeStubBody() },
            });
          } catch {
            // Non-fatal — the envelope stays full-sized if this fails
          }
      } catch (err) {
        // Parser failures must never block envelope-level sync. Log and
        // move on — the digest envelope row is already in the DB so the
        // agent will at minimum see the latest message.
        console.error("[helpdesk-sync] digest parse failed", err);
      }
    }

    // ── Hardcoded routing rules (replaces three obsolete user-defined
    // filters). Runs AFTER digest expansion so the AR-only-archive rule
    // sees the true final message count for the ticket, not the partial
    // count mid-loop.
    //
    // We re-fetch the ticket here so isArchived / type / status reflect
    // any earlier ticketUpdate or auto-resolve transitions in this loop
    // iteration. Cheap — one indexed PK lookup.
    const refreshedTicket = await db.helpdeskTicket.findUnique({
      where: { id: ticket.id },
      select: {
        id: true,
        type: true,
        isArchived: true,
        archivedAt: true,
        status: true,
      },
    });
    if (refreshedTicket) {
      // Rule 1 — Cancellation Request tag.
      // When THIS message is detected as a buyer-initiated cancellation
      // request, attach the BUYER_CANCELLATION_TAG_NAME tag (lazily
      // upserted, mirrors filters.ts). The folder layer already excludes
      // tagged tickets from All Tickets / To Do / Waiting and routes them
      // to the Cancel Requests folder via `buildFolderWhere("buyer_cancellation")`.
      if (isCancellationRequest) {
        try {
          const tag = await db.helpdeskTag.upsert({
            where: { name: BUYER_CANCELLATION_TAG_NAME },
            update: {},
            create: {
              name: BUYER_CANCELLATION_TAG_NAME,
              description:
                "Buyer asked to cancel the order. Auto-tagged by hardcoded sync rule (replaces obsolete 'A buyer wants to cancel an order' filter).",
              color: "#ef4444",
            },
            select: { id: true },
          });
          await db.helpdeskTicketTag.createMany({
            data: [{ ticketId: ticket.id, tagId: tag.id }],
            skipDuplicates: true,
          });
        } catch (err) {
          console.error(
            "[helpdesk-sync] cancellation tag attach failed",
            err,
          );
        }
      }

      // Rule 2 — Auto-Responder-only Archive (with bounce-out persistence).
      //
      // A ticket is "AR-only" when it has at least one AUTO_RESPONDER
      // message and ZERO inbound (buyer) messages. Digest expansion
      // creates both an envelope row AND sub-message rows for the same
      // conversation, so a simple `messageCount === 1` check doesn't
      // work — an AR-only ticket typically has 2+ rows (envelope + AR
      // sub-message). Instead we check for the ABSENCE of any inbound
      // messages, which structurally guarantees the buyer hasn't replied.
      //
      // Once a buyer replies (inboundCount > 0), this rule can never
      // fire again — making the bounce-out permanent without any extra
      // "do not re-archive" flag.
      if (!refreshedTicket.isArchived) {
        const [inboundCount, arCount] = await Promise.all([
          db.helpdeskMessage.count({
            where: {
              ticketId: ticket.id,
              direction: HelpdeskMessageDirection.INBOUND,
            },
          }),
          db.helpdeskMessage.count({
            where: {
              ticketId: ticket.id,
              source: HelpdeskMessageSource.AUTO_RESPONDER,
            },
          }),
        ]);
        if (inboundCount === 0 && arCount > 0) {
          try {
            await db.helpdeskTicket.update({
              where: { id: ticket.id },
              data: {
                isArchived: true,
                archivedAt: new Date(),
                status: HelpdeskTicketStatus.RESOLVED,
              },
            });
          } catch (err) {
            console.error(
              "[helpdesk-sync] AR-only archive update failed",
              err,
            );
          }
        }
      }
    }

    // ── Filters: evaluate against fresh INBOUND mail, plus OUTBOUND
    // messages that eBay generated on our behalf (shipping notices, refund
    // notices, payout notices — anything where no agent authored the reply
    // in our composer). The eBay-sync code path never sets `authorUserId`,
    // so every OUTBOUND we insert here is by definition "eBay-generated
    // from the seller's side". Agent-composed replies go through a
    // different code path (/api/helpdesk/messages) which sets
    // `authorUserId` and does NOT invoke filters, so they stay safe.
    if (args.filters.length > 0) {
      const matching = pickMatchingFilters(
        args.filters,
        {
          subject,
          bodyText: messageBodyText,
          fromName: messageFromName,
          fromIdentifier: messageFromName,
        },
        {
          buyerUserId: ticket.buyerUserId,
          buyerName: ticket.buyerName,
        },
      );
      // Apply each matching filter in `sortOrder`. Later actions can override
      // earlier ones (e.g. a "spam" filter after an "archive" filter), which
      // is the conventional Gmail-style behaviour.
      for (const f of matching) {
        try {
          await applyFilterAction(f, ticket.id, null);
        } catch (err) {
          console.error(
            `[helpdesk-sync] filter "${f.name}" apply failed for ticket ${ticket.id}`,
            err,
          );
        }
      }
      if (matching.length > 0) {
        // Bump aggregate hit counters so the UI can show "applied N times".
        await db.helpdeskFilter.updateMany({
          where: { id: { in: matching.map((f) => f.id) } },
          data: { totalHits: { increment: 1 } },
        });
      }
    }
  }

  return result;
}

// ΓöÇΓöÇΓöÇ Helpers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

function inferDirection(
  body: EbayMessageBody,
  folderKey: string,
): HelpdeskMessageDirection {
  // Sent folder = always outbound. Inbox = inbound from buyer to us.
  if (folderKey === "sent") return HelpdeskMessageDirection.OUTBOUND;
  return HelpdeskMessageDirection.INBOUND;
}

function buyerOrderHint(body: EbayMessageBody): boolean {
  // Best-effort signal that the message references a real order (post-sale).
  // eBay GetMyMessages does not always return order details; the subject
  // commonly contains "Order #" or "OrderID" for post-sale threads.
  const subject = (body.subject ?? "").toLowerCase();
  return /order\s*[#:]/i.test(subject) || /shipped/i.test(subject);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractItemTitleFromSubject(
  subject: string | null,
  itemId: string,
): string | null {
  const raw = subject?.trim();
  if (!raw) return null;
  const marker = " sent a message about ";
  const markerIndex = raw.toLowerCase().indexOf(marker);
  const afterMarker =
    markerIndex >= 0 ? raw.slice(markerIndex + marker.length) : raw;
  const withoutItemId = afterMarker
    .replace(new RegExp(`\\s*#${escapeRegExp(itemId)}\\s*$`), "")
    .trim();
  return withoutItemId ? withoutItemId.slice(0, 180) : null;
}

function crossListingRawData(
  context: CrossListingInquiryContext | null,
): Record<string, unknown> {
  if (!context) return {};
  return {
    crossListingInquiry: {
      sourceItemId: context.sourceItemId,
      sourceItemTitle: context.sourceItemTitle,
      sourceSubject: context.sourceSubject,
      sourceConversationId: context.sourceConversationId,
      sourceItemUrl: `https://www.ebay.com/itm/${context.sourceItemId}`,
      targetTicketId: context.targetTicketId,
      targetOrderNumber: context.targetOrderNumber,
      targetItemId: context.targetItemId,
    },
  };
}

function mergeCrossListingRawData(
  rawData: Prisma.JsonValue,
  context: CrossListingInquiryContext | null,
): Prisma.InputJsonValue {
  if (!context) return rawData as Prisma.InputJsonValue;
  const base =
    rawData && typeof rawData === "object" && !Array.isArray(rawData)
      ? (rawData as Record<string, unknown>)
      : {};
  return {
    ...base,
    ...crossListingRawData(context),
  } as Prisma.InputJsonValue;
}

async function findLatestRecentOrderTicketForBuyer(args: {
  integration: Integration;
  buyerUserId: string;
  excludeTicketId: string | null;
}): Promise<HelpdeskTicket | null> {
  const cutoff = new Date(
    Date.now() - CROSS_LISTING_ORDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const notClauses: Prisma.HelpdeskTicketWhereInput[] = [
    { type: HelpdeskTicketType.SYSTEM },
    { threadKey: { startsWith: "sys:" } },
  ];
  if (args.excludeTicketId) {
    notClauses.push({ id: args.excludeTicketId });
  }
  const baseWhere: Prisma.HelpdeskTicketWhereInput = {
    integrationId: args.integration.id,
    buyerUserId: { equals: args.buyerUserId, mode: "insensitive" },
    ebayOrderNumber: { not: null },
    isSpam: false,
    NOT: notClauses,
  };

  const recentOrders = await db.marketplaceSaleOrder.findMany({
    where: {
      platform: args.integration.platform,
      buyerIdentifier: { equals: args.buyerUserId, mode: "insensitive" },
      orderDate: { gte: cutoff },
    },
    select: { externalOrderId: true },
    orderBy: { orderDate: "desc" },
    take: 10,
  });

  const seenOrderNumbers = new Set<string>();
  for (const order of recentOrders) {
    const orderNumber = order.externalOrderId?.trim();
    if (!orderNumber || seenOrderNumbers.has(orderNumber)) continue;
    seenOrderNumbers.add(orderNumber);
    const ticket = await db.helpdeskTicket.findFirst({
      where: {
        ...baseWhere,
        ebayOrderNumber: orderNumber,
      },
      orderBy: { updatedAt: "desc" },
    });
    if (ticket) return ticket;
  }

  return db.helpdeskTicket.findFirst({
    where: {
      ...baseWhere,
      OR: [
        { lastBuyerMessageAt: { gte: cutoff } },
        { lastAgentMessageAt: { gte: cutoff } },
        { createdAt: { gte: cutoff } },
        { updatedAt: { gte: cutoff } },
      ],
    },
    orderBy: [{ lastBuyerMessageAt: "desc" }, { updatedAt: "desc" }],
  });
}

async function sweepAdoptRecentCrossListingPreSalesTickets(
  integrations: Integration[],
): Promise<void> {
  const cutoff = new Date(
    Date.now() - CROSS_LISTING_ORDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );

  for (const integration of integrations) {
    const preSalesTickets = await db.helpdeskTicket.findMany({
      where: {
        integrationId: integration.id,
        kind: HelpdeskTicketKind.PRE_SALES,
        ebayOrderNumber: null,
        buyerUserId: { not: null },
        ebayItemId: { not: null },
        lastAgentMessageAt: null,
        isArchived: false,
        isSpam: false,
        OR: [
          { lastBuyerMessageAt: { gte: cutoff } },
          { createdAt: { gte: cutoff } },
          { updatedAt: { gte: cutoff } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    for (const preSalesTicket of preSalesTickets) {
      if (!preSalesTicket.buyerUserId || !preSalesTicket.ebayItemId) continue;
      const orderTicket = await findLatestRecentOrderTicketForBuyer({
        integration,
        buyerUserId: preSalesTicket.buyerUserId,
        excludeTicketId: preSalesTicket.id,
      });
      if (!orderTicket || orderTicket.id === preSalesTicket.id) continue;

      await mergePreSalesTicketIntoOrderTicket({
        sourceTicket: preSalesTicket,
        targetTicket: orderTicket,
      });
    }
  }
}

async function mergePreSalesTicketIntoOrderTicket(args: {
  sourceTicket: HelpdeskTicket;
  targetTicket: HelpdeskTicket;
}): Promise<void> {
  const sourceItemId = args.sourceTicket.ebayItemId;
  if (!sourceItemId) return;
  const isDifferentItem =
    !!args.targetTicket.ebayItemId &&
    args.targetTicket.ebayItemId !== sourceItemId;
  const context: CrossListingInquiryContext | null = isDifferentItem
    ? {
        sourceItemId,
        sourceItemTitle: extractItemTitleFromSubject(
          args.sourceTicket.subject,
          sourceItemId,
        ),
        sourceSubject: args.sourceTicket.subject,
        sourceConversationId: args.sourceTicket.ebayConversationId,
        targetTicketId: args.targetTicket.id,
        targetOrderNumber: args.targetTicket.ebayOrderNumber,
        targetItemId: args.targetTicket.ebayItemId,
      }
    : null;

  const messages = await db.helpdeskMessage.findMany({
    where: { ticketId: args.sourceTicket.id, deletedAt: null },
    orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      direction: true,
      externalId: true,
      rawData: true,
      sentAt: true,
    },
  });
  if (messages.length === 0) return;

  const latestInboundAt =
    messages
      .filter((m) => m.direction === HelpdeskMessageDirection.INBOUND)
      .map((m) => m.sentAt)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const now = new Date();

  await db.$transaction(async (tx) => {
    for (const message of messages) {
      const duplicate = message.externalId
        ? await tx.helpdeskMessage.findFirst({
            where: {
              ticketId: args.targetTicket.id,
              externalId: message.externalId,
            },
            select: { id: true, rawData: true },
          })
        : null;

      if (duplicate) {
        if (context) {
          await tx.helpdeskMessage.update({
            where: { id: duplicate.id },
            data: {
              rawData: mergeCrossListingRawData(duplicate.rawData, context),
            },
          });
        }
        continue;
      }

      await tx.helpdeskMessage.update({
        where: { id: message.id },
        data: {
          ticketId: args.targetTicket.id,
          rawData: mergeCrossListingRawData(message.rawData, context),
        },
      });
    }

    const ticketUpdate: Prisma.HelpdeskTicketUpdateInput = {
      unreadCount: Math.max(
        args.targetTicket.unreadCount,
        args.sourceTicket.unreadCount,
      ),
    };
    if (
      latestInboundAt &&
      (!args.targetTicket.lastBuyerMessageAt ||
        latestInboundAt > args.targetTicket.lastBuyerMessageAt)
    ) {
      ticketUpdate.lastBuyerMessageAt = latestInboundAt;
    }
    if (
      args.sourceTicket.status === HelpdeskTicketStatus.TO_DO ||
      args.sourceTicket.unreadCount > 0
    ) {
      const nextStatus = deriveStatusOnInbound({
        status: args.targetTicket.status,
        hasAgentReplied: args.targetTicket.lastAgentMessageAt !== null,
        isArchived: args.targetTicket.isArchived,
        isSpam: args.targetTicket.isSpam,
      });
      ticketUpdate.status = nextStatus;
      if (args.targetTicket.status === HelpdeskTicketStatus.RESOLVED) {
        ticketUpdate.reopenCount = { increment: 1 };
        ticketUpdate.lastReopenedAt = now;
      }
      if (args.targetTicket.isArchived && !args.targetTicket.isSpam) {
        ticketUpdate.isArchived = false;
        ticketUpdate.archivedAt = null;
      }
      if (args.targetTicket.snoozedUntil) {
        ticketUpdate.snoozedUntil = null;
        if (args.targetTicket.snoozedById) {
          ticketUpdate.snoozedBy = { disconnect: true };
        }
      }
    }

    await tx.helpdeskTicket.update({
      where: { id: args.targetTicket.id },
      data: ticketUpdate,
    });

    await tx.helpdeskTicket.update({
      where: { id: args.sourceTicket.id },
      data: {
        isArchived: true,
        archivedAt: now,
        status: HelpdeskTicketStatus.RESOLVED,
        unreadCount: 0,
      },
    });

    await tx.auditLog.create({
      data: {
        action: "HELPDESK_CROSS_LISTING_TICKET_MERGED",
        entityType: "HelpdeskTicket",
        entityId: args.targetTicket.id,
        details: {
          sourceTicketId: args.sourceTicket.id,
          sourceItemId,
          sourceConversationId: args.sourceTicket.ebayConversationId,
          targetOrderNumber: args.targetTicket.ebayOrderNumber,
          targetTicketId: args.targetTicket.id,
        } as Prisma.InputJsonValue,
      },
    });
  });
}

/**
 * Stable thread key. We prefer `orderNumber + buyer` because that is the
 * strongest signal that two messages belong to the same logical ticket: each
 * eBay order is its own transaction, and the operator wants each order's
 * messages in its own ticket even when the same buyer places multiple
 * orders on the same listing.
 *
 * When no order number is known yet (pure pre-sales inquiry), we fall back
 * to `itemId + buyer`. As soon as that conversation converts into a real
 * order, the sync will "adopt" the pre-sales ticket by rewriting its
 * threadKey from `itm:...` to `ord:...` so the pre-sales message history is
 * preserved on the post-sales ticket.
 *
 * Format examples:
 *   - ord:08-14471-32723|buyer:johndoe          (post-sales, preferred)
 *   - itm:123456789|buyer:johndoe                (pre-sales, no order yet)
 *   - sub:question-about-shipping|buyer:johndoe  (no itemID available)
 *   - msg:abcdef                                 (last-resort fallback)
 */
function computeThreadKey(
  body: EbayMessageBody,
  buyerUserId: string | null,
  orderNumber: string | null,
  fromEbayResult?: { isFromEbay: boolean; systemMessageType?: string | null } | null,
): string | null {
  const buyer = buyerUserId?.trim() || null;
  const itemId = body.itemID?.trim();
  const subject = body.subject?.trim();

  // Eventful eBay system notifications (Return Requested, Payout Sent, Case
  // Closed, etc.) live in their OWN isolated tickets keyed by the event type.
  // They must never share a ticket with the buyer's conversation — the "From
  // eBay" folder is reserved strictly for system bookkeeping. This keeps
  // tickets like "buyer asked for a label" (type=QUERY) distinct from the
  // related "eBay opened a return case" SYSTEM ticket on the same order.
  if (fromEbayResult?.isFromEbay) {
    const sysType = fromEbayResult.systemMessageType ?? "OTHER";
    if (orderNumber) {
      return `sys:ord:${orderNumber}|type:${sysType}`;
    }
    if (itemId) {
      return `sys:itm:${itemId}|type:${sysType}`;
    }
    if (body.messageID) {
      return `sys:msg:${body.messageID}`;
    }
    return null;
  }

  if (orderNumber && buyer) {
    return `ord:${orderNumber}|buyer:${buyer.toLowerCase()}`;
  }
  if (orderNumber) {
    // No buyer resolved yet but we still have a real order number — keep
    // the message attached to the order so a later, well-identified
    // message can adopt this row. Without this branch system messages
    // (refund/shipping notifications) would either fan out to a per-
    // message ticket or pile into the wrong (item, seller) bucket.
    return `ord:${orderNumber}`;
  }
  if (itemId && buyer) {
    return `itm:${itemId}|buyer:${buyer.toLowerCase()}`;
  }
  if (subject && buyer) {
    return `sub:${subject.slice(0, 80).toLowerCase()}|buyer:${buyer.toLowerCase()}`;
  }
  if (body.messageID) {
    return `msg:${body.messageID}`;
  }
  return null;
}

// ΓöÇΓöÇΓöÇ Body sniffing & order-number extraction ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * Heuristic: does the message body actually contain HTML markup? eBay's
 * GetMyMessages frequently returns HTML inside the <Text> element without
 * setting ContentType=text/html (especially for buyer-side and notification
 * messages), so we sniff the content directly. This mirrors the detection
 * logic in SafeHtml so the data we store and what we render stay in sync.
 */
const HTML_BODY_TAG_RE =
  /<\/?(?:html|body|head|table|tr|td|th|div|p|br|hr|span|img|a|h[1-6]|ul|ol|li|strong|em|b|i|font|center|blockquote|pre)\b/i;
const HTML_ENTITY_TAG_RE =
  /&lt;\/?(?:html|body|table|tr|td|div|p|br|span|img|a|h[1-6]|ul|ol|li|strong|em|font)\b/i;

function looksLikeHtmlBody(text: string): boolean {
  if (!text) return false;
  return HTML_BODY_TAG_RE.test(text) || HTML_ENTITY_TAG_RE.test(text);
}

/**
 * eBay order numbers in messages appear in several shapes:
 *   - Auto-responder bodies: "Your order (#24-14519-40737)"
 *   - eBay shipping notifications: "Order number: 24-14519-40737"
 *   - Bulk-style: "Order ID: 12-12345-12345" or "OrderID: 110123456789-987654321"
 *   - Buyer replies that quote: "Order #24-14519-40737"
 *
 * We accept either the buyer/seller-facing "##-#####-#####" format OR the
 * legacy "<itemId>-<txnId>" numeric format eBay still emits in some
 * notifications.
 *
 * The regex matches:
 *   `\d{2}-\d{5}-\d{5}` ΓÇö the 5-3-5 segmented order number, or
 *   `\d{10,16}-\d{5,15}` ΓÇö the legacy numeric ItemID-TxnID pairing.
 */
const ORDER_NUMBER_RE = /(\d{2}-\d{5}-\d{5})|(\d{10,16}-\d{5,15})/;
const ORDER_NUMBER_LABEL_RE =
  /(?:order\s*(?:number|no\.?|#|id)\s*[:#]?\s*)([A-Z0-9-]+)/i;

/**
 * Two-way mirror of eBay's read-state into reorG.
 *
 * Direction 1 — eBay read → reorG read:
 *   If a header we already have locally is now `read=true` on eBay, and
 *   the owning ticket's only unread inbound message is this one (or older),
 *   zero out the ticket's `unreadCount`. TO_DO / NEW tickets also get
 *   resolved because "read on eBay" means an agent saw it there.
 *
 * Direction 2 — eBay unread → reorG unread (per user decision, updated):
 *   If a message that was read in reorG is flipped back to unread on eBay,
 *   ONLY flip `unreadCount=1` on the reorG ticket. Do NOT move folders, do
 *   NOT un-archive, do NOT change status. Rationale: the ticket is already
 *   in whatever folder it belongs to (Waiting, Archived, etc.); marking a
 *   message unread on eBay is purely a read-state signal and should not
 *   re-route work. Spam tickets are still excluded.
 *
 * Cheap: one ticket-grouping query, one updateMany per direction.
 */
async function reconcileEbayReadState(
  integrationId: string,
  headers: EbayMessageHeader[],
): Promise<void> {
  // Build maps of eBay message ID → read state
  const readOnEbay = new Set<string>();
  const unreadOnEbay = new Set<string>();
  for (const h of headers) {
    if (!h.messageID) continue;
    if (h.read === true) readOnEbay.add(h.messageID);
    else if (h.read === false) unreadOnEbay.add(h.messageID);
  }
  if (readOnEbay.size === 0 && unreadOnEbay.size === 0) return;

  const allIds = [...readOnEbay, ...unreadOnEbay];

  // Find local messages — exclude SYSTEM (FROM EBAY) tickets entirely.
  // FROM EBAY tickets must NEVER have their read/unread state synced
  // in either direction.
  const localMessages = await db.helpdeskMessage.findMany({
    where: {
      ebayMessageId: { in: allIds },
      direction: HelpdeskMessageDirection.INBOUND,
      ticket: {
        integrationId,
        type: { not: HelpdeskTicketType.SYSTEM },
      },
    },
    select: {
      ebayMessageId: true,
      ticketId: true,
      sentAt: true,
      ticket: {
        select: {
          unreadCount: true,
          status: true,
          isArchived: true,
          isSpam: true,
          lastBuyerMessageAt: true,
        },
      },
    },
  });
  if (localMessages.length === 0) return;

  // ── eBay read → HelpDesk read (clear unreadCount)
  const ticketLatestRead = new Map<string, number>();
  for (const m of localMessages) {
    if (!m.ebayMessageId || !readOnEbay.has(m.ebayMessageId)) continue;
    const t = m.sentAt?.getTime() ?? 0;
    const prev = ticketLatestRead.get(m.ticketId) ?? 0;
    if (t > prev) ticketLatestRead.set(m.ticketId, t);
  }

  const ticketsToClear: string[] = [];
  for (const m of localMessages) {
    if (m.ticket.unreadCount <= 0) continue;
    if (!m.ebayMessageId || !readOnEbay.has(m.ebayMessageId)) continue;
    const lastBuyer = m.ticket.lastBuyerMessageAt?.getTime() ?? 0;
    const latestRead = ticketLatestRead.get(m.ticketId) ?? 0;
    if (latestRead >= lastBuyer && !ticketsToClear.includes(m.ticketId)) {
      ticketsToClear.push(m.ticketId);
    }
  }
  if (ticketsToClear.length > 0) {
    await db.helpdeskTicket.updateMany({
      where: { id: { in: ticketsToClear } },
      data: { unreadCount: 0 },
    });
    // Also resolve TO_DO/NEW tickets that are now fully read on eBay.
    // "Read on eBay" = the agent saw it and moved on, so it's handled.
    const toDoTicketsToClear = ticketsToClear.filter((tid) => {
      const msg = localMessages.find((m) => m.ticketId === tid);
      return (
        msg &&
        (msg.ticket.status === HelpdeskTicketStatus.NEW ||
          msg.ticket.status === HelpdeskTicketStatus.TO_DO)
      );
    });
    if (toDoTicketsToClear.length > 0) {
      await db.helpdeskTicket.updateMany({
        where: { id: { in: toDoTicketsToClear } },
        data: { status: HelpdeskTicketStatus.RESOLVED },
      });
    }
  }

  // ── eBay unread → reorG unread (read-state only).
  //
  // When eBay flips a message from read → unread, we mirror that read-state
  // by setting `unreadCount = 1` on the ticket. We explicitly do NOT change
  // folder / archive / status — the ticket is already in the right folder
  // for its workflow stage (Waiting, Archived, etc.). Marking a message
  // unread on eBay is a read-state signal, not a work-routing signal.
  // Spam tickets are excluded.
  const ticketsToMarkUnread: string[] = [];
  for (const m of localMessages) {
    if (!m.ebayMessageId || !unreadOnEbay.has(m.ebayMessageId)) continue;
    if (m.ticket.isSpam) continue;
    if (m.ticket.unreadCount > 0) continue; // already unread locally
    if (!ticketsToMarkUnread.includes(m.ticketId)) {
      ticketsToMarkUnread.push(m.ticketId);
    }
  }
  if (ticketsToMarkUnread.length > 0) {
    await db.helpdeskTicket.updateMany({
      where: { id: { in: ticketsToMarkUnread } },
      data: { unreadCount: 1 },
    });
    console.info(
      "[helpdesk-sync] eBay unread → reorG unread (read-state only, folder unchanged)",
      { integrationId, ticketIds: ticketsToMarkUnread },
    );
  }
}

function extractEbayOrderNumber(body: EbayMessageBody): string | null {
  const haystacks: string[] = [];
  if (body.subject) haystacks.push(body.subject);
  if (body.text) haystacks.push(body.text);

  for (const text of haystacks) {
    // Prefer label-anchored matches first ("Order #..." / "Order number: ...")
    const labelMatch = ORDER_NUMBER_LABEL_RE.exec(text);
    if (labelMatch) {
      const candidate = labelMatch[1]?.trim();
      if (candidate && /^\d{2}-\d{5}-\d{5}$/.test(candidate)) return candidate;
      if (candidate && /^\d{10,16}-\d{5,15}$/.test(candidate)) return candidate;
    }
    // Fallback: any unmistakable order-number shape anywhere in the text.
    const shapeMatch = ORDER_NUMBER_RE.exec(text);
    if (shapeMatch) {
      return (shapeMatch[1] ?? shapeMatch[2] ?? "").trim() || null;
    }
  }
  return null;
}

// ΓöÇΓöÇΓöÇ Backfill: ebayOrderNumber for tickets missing it ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

interface BackfillOrderNumbersOptions {
  /** Only act on tickets created within the last N days (default: 180). */
  withinDays?: number;
  /** Cap how many tickets to process this pass. */
  maxTickets?: number;
}

interface BackfillOrderNumbersResult {
  scanned: number;
  matchedFromMessages: number;
  matchedFromAutoResponder: number;
  matchedFromEbay: number;
  remaining: number;
}

/**
 * Find post-sales tickets that are missing `ebayOrderNumber` and try to
 * populate it. Strategy, in order of cost:
 *   1. Re-scan stored messages (free, just text).
 *   2. Match against AutoResponderSendLog (free, our own data ΓÇö every
 *      auto-responder send has an order number).
 *   3. Call eBay GetOrders by item+buyer (last resort, costs API quota).
 *
 * Designed to run from a cron tick or on-demand. Returns counts so the
 * caller can log progress.
 */
export async function backfillTicketOrderNumbers(
  opts: BackfillOrderNumbersOptions = {},
): Promise<BackfillOrderNumbersResult> {
  const result: BackfillOrderNumbersResult = {
    scanned: 0,
    matchedFromMessages: 0,
    matchedFromAutoResponder: 0,
    matchedFromEbay: 0,
    remaining: 0,
  };
  const since = new Date(Date.now() - (opts.withinDays ?? 180) * 86_400_000);
  const limit = opts.maxTickets ?? 200;

  const tickets = await db.helpdeskTicket.findMany({
    where: {
      ebayOrderNumber: null,
      kind: HelpdeskTicketKind.POST_SALES,
      createdAt: { gte: since },
    },
    include: {
      integration: true,
      messages: {
        select: { subject: true, bodyText: true },
        orderBy: { sentAt: "asc" },
      },
    },
    take: limit,
    orderBy: { createdAt: "desc" },
  });
  result.scanned = tickets.length;

  for (const ticket of tickets) {
    let matched: string | null = null;

    // 1. Stored messages ΓÇö re-run extraction in case the original sync
    //    happened before this code shipped.
    for (const m of ticket.messages) {
      const candidate = extractFromText(m.subject ?? "") ?? extractFromText(m.bodyText);
      if (candidate) {
        matched = candidate;
        result.matchedFromMessages++;
        break;
      }
    }

    // 2. Auto-responder log ΓÇö when reorG sent the first message on this
    //    thread, it logged the orderNumber. Match by buyer + item.
    if (!matched && ticket.buyerUserId && ticket.ebayItemId) {
      const log = await db.autoResponderSendLog.findFirst({
        where: {
          integrationId: ticket.integrationId,
          ebayItemId: ticket.ebayItemId,
          ebayBuyerUserId: ticket.buyerUserId,
          status: "sent",
        },
        select: { orderNumber: true },
        orderBy: { sentAt: "desc" },
      });
      if (log?.orderNumber) {
        matched = log.orderNumber;
        result.matchedFromAutoResponder++;
      }
    }

    // 3. eBay GetOrders by ItemID + buyer is not directly supported, so
    //    we fall back to looking up by any order numbers we *do* know about
    //    on the same buyer recently. Skipped here; the backfill cron can
    //    expand on this later.

    if (matched) {
      await db.helpdeskTicket.update({
        where: { id: ticket.id },
        data: { ebayOrderNumber: matched },
      });
    } else {
      result.remaining++;
    }
  }

  return result;
}

function extractFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const labelMatch = ORDER_NUMBER_LABEL_RE.exec(text);
  if (labelMatch) {
    const candidate = labelMatch[1]?.trim();
    if (candidate && /^\d{2}-\d{5}-\d{5}$/.test(candidate)) return candidate;
    if (candidate && /^\d{10,16}-\d{5,15}$/.test(candidate)) return candidate;
  }
  const shapeMatch = ORDER_NUMBER_RE.exec(text);
  if (shapeMatch) {
    return (shapeMatch[1] ?? shapeMatch[2] ?? "").trim() || null;
  }
  return null;
}

// ─── Targeted ingest: pull a specific order into the helpdesk ────────────
//
// Why this exists:
//   The cron-driven backfill is bounded by HELPDESK_BACKFILL_DAYS so a fresh
//   wipe can't accidentally replay months of history. But operators sometimes
//   need to re-ingest ONE specific order whose messages fall outside that
//   window (e.g. an older return case the buyer is still emailing about).
//   Rather than bumping the global horizon — which would trigger a full
//   replay across both stores — this helper scans eBay headers for a wider
//   window, filters bodies down to the target order, and runs the exact same
//   reconciliation pipeline that the cron uses. Everything else (write locks,
//   sent-folder logic, read reconcile) is bypassed: the ONLY side-effect is
//   creating/updating tickets and messages for the matching order.
//
// Safety:
//   - Read-only against eBay. No ReviseMyMessages, no message sends.
//   - Touches only HelpdeskTicket / HelpdeskMessage rows for the matched order.
//   - Idempotent: duplicate messageIDs are dropped by the reconcile unique key.

export interface IngestOrderOptions {
  /** eBay order number in the 17-14480-10344 format (or sibling shapes). */
  orderNumber: string;
  /** How far back to scan eBay headers. Default 120 days. */
  withinDays?: number;
  /** Which folders to scan. Default ["inbox", "sent"] for a complete thread. */
  folders?: Array<"inbox" | "sent">;
  /** Optional progress logger (defaults to console.log). */
  log?: (line: string) => void;
}

export interface IngestOrderResult {
  integrationId: string;
  platform: Platform;
  folder: string;
  headersScanned: number;
  bodiesFetched: number;
  bodiesMatched: number;
  ticketsCreated: number;
  ticketsUpdated: number;
  messagesInserted: number;
  error?: string;
}

/**
 * Scan eBay headers for the given integration + folders, fetch message
 * bodies in chunks of 10, filter to messages whose text mentions the
 * target order number, and run them through the normal reconcile
 * pipeline. Called by scripts/helpdesk-ingest-order.ts.
 */
export async function ingestOrderIntoHelpdesk(
  integration: Integration,
  opts: IngestOrderOptions,
): Promise<IngestOrderResult[]> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const folders = (opts.folders ?? ["inbox", "sent"]).map((k) =>
    k === "inbox" ? { id: 0, key: "inbox" } : { id: 1, key: "sent" },
  );
  const withinDays = opts.withinDays ?? 120;
  const target = opts.orderNumber.trim();
  if (!target) throw new Error("orderNumber is required");

  const config = buildEbayConfig(integration);
  if (!config.appId || !config.refreshToken) {
    return folders.map((f) => ({
      integrationId: integration.id,
      platform: integration.platform,
      folder: f.key,
      headersScanned: 0,
      bodiesFetched: 0,
      bodiesMatched: 0,
      ticketsCreated: 0,
      ticketsUpdated: 0,
      messagesInserted: 0,
      error: "missing eBay credentials",
    }));
  }

  // Load filters once (matches the cron's one-per-pass load).
  const filters = await db.helpdeskFilter.findMany({
    where: { enabled: true },
    orderBy: { sortOrder: "asc" },
  });

  const results: IngestOrderResult[] = [];
  const now = new Date();
  const horizon = new Date(now.getTime() - withinDays * 86_400_000);

  for (const folder of folders) {
    const summary: IngestOrderResult = {
      integrationId: integration.id,
      platform: integration.platform,
      folder: folder.key,
      headersScanned: 0,
      bodiesFetched: 0,
      bodiesMatched: 0,
      ticketsCreated: 0,
      ticketsUpdated: 0,
      messagesInserted: 0,
    };

    try {
      // Pass 1 (cheap): walk the full window in 7-day slices, fetching only
      // HEADERS (no body hydrate). eBay order-event messages almost always
      // embed the order number directly in the subject line
      // (e.g. "Buyer requested a return · Order 17-14480-10344"), so we can
      // identify candidate messages without paying the body-fetch cost for
      // every message in the inbox. This keeps a 120-day targeted pull cheap
      // even on a store that moves 500+ messages/week.
      let windowEnd = now;
      const subjectHits: EbayMessageHeader[] = [];
      while (windowEnd.getTime() > horizon.getTime()) {
        const windowStart = new Date(
          Math.max(
            horizon.getTime(),
            windowEnd.getTime() - HEADERS_WINDOW_DAYS * 86_400_000,
          ),
        );
        const headers = await getMyMessagesHeaders(integration.id, config, {
          startTime: windowStart,
          endTime: windowEnd,
          folderID: folder.id,
        });
        summary.headersScanned += headers.length;
        const thisWindowHits = headers.filter((h) =>
          h.subject ? h.subject.includes(target) : false,
        );
        for (const h of thisWindowHits) subjectHits.push(h);

        log(
          `  [${integration.label} / ${folder.key}] window ${windowStart.toISOString().slice(0, 10)}..${windowEnd.toISOString().slice(0, 10)} headers=${headers.length} subjectHits=${thisWindowHits.length}`,
        );

        windowEnd = windowStart;
        if (windowStart.getTime() <= horizon.getTime()) break;
      }

      // Pass 2: hydrate bodies for the subject hits and re-check with the
      // canonical order-number extractor (which looks at body text too in
      // case we see an edge case where the subject is truncated). Any that
      // match the target get fed into the reconcile pipeline.
      const collectedBodies: EbayMessageBody[] = [];
      const ids = subjectHits
        .map((h) => h.messageID)
        .filter((id): id is string => Boolean(id));
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const bodies = await getMyMessagesBodies(integration.id, config, chunk);
        summary.bodiesFetched += bodies.length;
        for (const body of bodies) {
          const ord = extractEbayOrderNumber(body);
          if (ord === target) {
            collectedBodies.push(body);
            summary.bodiesMatched++;
          }
        }
      }

      if (collectedBodies.length > 0) {
        const reconciled = await reconcileMessages({
          integration,
          folderKey: folder.key,
          bodies: collectedBodies,
          filters,
        });
        summary.ticketsCreated = reconciled.ticketsCreated;
        summary.ticketsUpdated = reconciled.ticketsUpdated;
        summary.messagesInserted = reconciled.messagesInserted;
      }
    } catch (err) {
      summary.error = err instanceof Error ? err.message : String(err);
    }

    results.push(summary);
  }

  return results;
}

/**
 * Max conversations to pull per integration per tick via
 * `sort=-last_modified_date`. We client-side filter for unread within
 * this window. eBay's page cap is 200; we use 50 as a conservative
 * page size that still caps the sweep at ~8 API calls per integration.
 *
 * Tuning guidance:
 *   - TPP typically carries ~40 concurrent unreads against 170k+ total
 *     conversations, but unread convs can be scattered among a long
 *     tail of recently-touched reads (agent reply threads, archived
 *     bumps, etc.). 400 covers the active window comfortably.
 *   - TT is ~20 concurrent unreads against a much smaller total; 400
 *     is well past the unread window there too.
 *   - Anything bigger converges across subsequent ticks — we prioritize
 *     staying inside the per-tick budget over one-shot completeness.
 */
const RECENT_CONVERSATIONS_WINDOW = 800;
const COMMERCE_PAGE_SIZE = 50;
const TARGETED_LISTING_DISCOVERY_BUDGET = 10;
const TARGETED_LISTING_DISCOVERY_WINDOW_DAYS = 30;
const TARGETED_LISTING_DISCOVERY_SCAN_WINDOW = 50;

/**
 * Reconcile Help Desk unread state against the modern eBay web UI's
 * "Unread from members" list (Commerce Message API /conversation).
 *
 * Why this is separate from sweepStaleUnread/Read:
 *   Those sweeps hit the legacy Trading API GetMyMessages "Read" flag,
 *   which is a SEPARATE store from the one that drives the web UI. We've
 *   verified (see scripts/_probe-ebay-read.ts and _probe-ebay-bodies.ts)
 *   that a message can be Read=true in Trading API yet still show as
 *   unread on ebay.com/mesg, and vice versa. Relying on just the Trading
 *   API store is why our unread count drifted to 139 while the web UI
 *   only showed 61 unread.
 *
 * Strategy (pull only; never pushes state back to eBay):
 *   1. Page through the Commerce Message API sorted by
 *      `-last_modified_date` (up to RECENT_CONVERSATIONS_WINDOW rows).
 *      The unfiltered "FROM_MEMBERS" path 5xxs on high-volume accounts
 *      (TPP has 170k+ conversations); sort=... uses a different backend
 *      route that doesn't time out.
 *   2. Track every buyer username we scanned this tick (`allSeenBuyers`).
 *      For each row, compute whether it's unread from the buyer's side:
 *        `unreadMessageCount > 0` AND `latestMessage.readStatus === false`
 *        AND the latest sender isn't us.
 *   3. For each unread conversation, find the matching local ticket via
 *      otherPartyUsername == buyerUserId (case-insensitive, with a
 *      buyerName fallback for legacy tickets), preferring ebayItemId ==
 *      itemId when multiple tickets match; bump unreadCount=0→1.
 *   4. Clear local unread ONLY for buyers we actually scanned this tick
 *      and confirmed aren't in the unread set. Buyers beyond the
 *      scanned window are left alone — this is critical to avoid the
 *      "oscillation" bug where a legitimately-unread ticket flips to
 *      read because its conversation scrolled out of the window.
 *
 * Skips integrations whose token doesn't carry the `commerce.message`
 * scope yet (needsReauth) — the getConversations wrapper returns an
 * empty list + the flag, and we log once per integration.
 *
 * Gated by effectiveCanSyncReadState at the caller.
 */
/**
 * Signal captured by the unread sweep: eBay-side last-modified timestamp
 * for every conversation we scanned this tick. Consumed by the inbound
 * sweep to find tickets where eBay has newer activity than our DB (i.e.
 * the agent replied via the eBay web UI and the message never landed in
 * our legacy Trading-API scrape).
 *
 * Key = conversationId (globally unique across integrations, so a single
 * flat map is fine).
 */
type CommerceActivitySignals = Map<string, Date>;

async function sweepUnreadConversationsFromWebUi(
  integrations: Integration[],
): Promise<CommerceActivitySignals> {
  // Run integrations in parallel. The per-integration path is entirely
  // self-contained (scoped by integrationId in every DB query + API call),
  // so parallelism is safe and roughly halves wall time on 2-integration
  // setups — critical for staying under Vercel's gateway timeout.
  const results = await Promise.all(
    integrations.map((integration) =>
      sweepUnreadConversationsForIntegration(integration).catch((err) => {
        console.error(
          "[helpdesk-sync] commerce message unread sweep failed for integration",
          {
            integrationId: integration.id,
            integrationLabel: integration.label,
            error: err instanceof Error ? err.message : String(err),
          },
        );
        return new Map<string, Date>() as CommerceActivitySignals;
      }),
    ),
  );
  const merged: CommerceActivitySignals = new Map();
  for (const m of results) {
    for (const [k, v] of m) merged.set(k, v);
  }
  return merged;
}

async function sweepUnreadConversationsForIntegration(
  integration: Integration,
): Promise<CommerceActivitySignals> {
  // Signals we hand back to sweepCommerceMessageInbound so it can
  // prioritize tickets where eBay's last-modified timestamp is newer
  // than our local lastAgentMessageAt — the exact ones missing a web-UI
  // agent reply.
  const signals: CommerceActivitySignals = new Map();
  {
    if (
      integration.platform !== Platform.TPP_EBAY &&
      integration.platform !== Platform.TT_EBAY
    )
      return signals;
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) return signals;

    const selfUsername = getSellerUserId(integration) ?? undefined;

    // ── 1. Page through recent-modified conversations ─────────────────────
    // Use sort=-last_modified_date; the unfiltered path 5xxs on TPP.
    const unread: Array<{
      otherPartyUsername?: string;
      lastMessageDate?: string;
      itemId?: string;
      conversationId: string;
    }> = [];
    // Every buyer whose conversation we actually scanned this tick. Used
    // as the authoritative "I saw this buyer" set for the clear-stale
    // branch — we only clear local unread for buyers we KNOW we saw and
    // confirmed aren't unread. Buyers beyond the window are left alone.
    const allSeenBuyersLower = new Set<string>();
    // Every scanned conversation keyed by buyerUsername.toLowerCase().
    // Used post-scan to opportunistically bootstrap ebayConversationId on
    // tickets that lack one — including READ conversations, which aren't
    // touched by the unread-matching branch above. This is what lets the
    // new Commerce-Message inbound sweep (sweepCommerceMessageInbound)
    // operate on more than just tickets that went through an explicit
    // mark-read/unread action.
    const scannedByBuyer = new Map<
      string,
      {
        conversationId: string;
        lastMessageDate?: string;
        itemId?: string;
      }
    >();
    let needsReauthLogged = false;
    let totalScanned = 0;
    for (
      let offset = 0;
      offset < RECENT_CONVERSATIONS_WINDOW;
      offset += COMMERCE_PAGE_SIZE
    ) {
      const { conversations, needsReauth } = await getConversations(
        integration.id,
        config,
        {
          conversationType: "FROM_MEMBERS",
          sort: "-last_modified_date",
          limit: COMMERCE_PAGE_SIZE,
          offset,
          selfUsernameHint: selfUsername,
        },
      );
      if (needsReauth) {
        if (!needsReauthLogged) {
          console.info(
            "[helpdesk-sync] commerce.message scope missing — re-authorize integration",
            {
              integrationId: integration.id,
              integrationLabel: integration.label,
            },
          );
          needsReauthLogged = true;
        }
        break;
      }
      if (conversations.length === 0) break;
      totalScanned += conversations.length;
      for (const c of conversations) {
        if (c.otherPartyUsername) {
          const key = c.otherPartyUsername.toLowerCase();
          allSeenBuyersLower.add(key);
          // Keep the most recent conversation per buyer (we sort by
          // last_modified_date desc so earlier pages win).
          if (!scannedByBuyer.has(key)) {
            scannedByBuyer.set(key, {
              conversationId: c.conversationId,
              lastMessageDate: c.lastMessageDate,
              itemId: c.itemId,
            });
          }
        }
        // Record the eBay-side last-modified timestamp for this
        // conversation so the inbound sweep can identify tickets whose
        // DB state is stale relative to eBay.
        if (c.conversationId && c.lastMessageDate) {
          const d = new Date(c.lastMessageDate);
          if (!Number.isNaN(d.getTime())) signals.set(c.conversationId, d);
        }
        // Primary signal: unreadMessageCount. eBay always populates this
        // on the list response. The previous version additionally required
        // `latestMessage.readStatus === false` AND `senderUsername !=
        // selfUsername`, but eBay frequently omits `latestMessage` (or its
        // `readStatus` field) on older conversations. When that happened
        // the check collapsed to `undefined === false` → false, and genuine
        // unread conversations got dropped — the "stragglers" Adam saw on
        // tickets that were read on Help Desk but unread on eBay.
        //
        // New rule: trust unreadCount>0 as authoritative, and use the
        // sender/readStatus signals only to REJECT (not require). If the
        // latest message is explicitly from us (outbound), we still skip.
        const hasUnreadCount = (c.unreadMessageCount ?? 0) > 0;
        const latestFromSelf =
          !!selfUsername &&
          !!c.latestMessage?.senderUsername &&
          c.latestMessage.senderUsername === selfUsername;
        const latestExplicitlyRead = c.latestMessage?.readStatus === true;
        const isUnread = hasUnreadCount && !latestFromSelf && !latestExplicitlyRead;
        if (isUnread) {
          unread.push({
            otherPartyUsername: c.otherPartyUsername,
            lastMessageDate: c.lastMessageDate,
            itemId: c.itemId,
            conversationId: c.conversationId,
          });
        }
      }
      // Short page → eBay's end of data.
      if (conversations.length < COMMERCE_PAGE_SIZE) break;
    }
    if (needsReauthLogged) return signals;

    // ── 2. Bump local unread where eBay reports unread ───────────────────
    let bumpedUnread = 0;
    let convoIdsPersisted = 0;
    const unreadBuyersLower = new Set<string>();
    for (const c of unread) {
      if (!c.otherPartyUsername) continue;
      const buyerLower = c.otherPartyUsername.toLowerCase();
      unreadBuyersLower.add(buyerLower);
      // Match by buyerUserId first (preferred), falling back to buyerName
      // case-insensitively so tickets created before we persisted
      // buyerUserId cleanly still reconcile.
      const candidates = await db.helpdeskTicket.findMany({
        where: {
          integrationId: integration.id,
          isSpam: false,
          type: { not: HelpdeskTicketType.SYSTEM },
          OR: [
            { buyerUserId: { equals: c.otherPartyUsername, mode: "insensitive" } },
            {
              AND: [
                { buyerUserId: null },
                { buyerName: { equals: c.otherPartyUsername, mode: "insensitive" } },
              ],
            },
          ],
        },
        select: {
          id: true,
          unreadCount: true,
          ebayItemId: true,
          lastBuyerMessageAt: true,
          ebayConversationId: true,
        },
      });
      if (candidates.length === 0) {
        // Tier D — Conversation Discovery.
        //
        // We found an unread buyer conversation on eBay but have no
        // helpdesk ticket for it. Historically this could happen because:
        //   - The order's only local ticket is a SYSTEM notification
        //     (e.g. "return case opened"), which we intentionally exclude
        //     from the candidate set — SYSTEM tickets are for eBay
        //     bookkeeping, not for buyer conversation.
        //   - The conversation predates our first Trading-API sweep but
        //     the buyer just replied on it.
        //   - The Trading API inbox dropped the message (batching windows,
        //     API flakiness) but the Commerce Message API still shows it.
        //
        // Without this branch the buyer's message would be invisible
        // forever. Create a minimal ticket bound to the conversation ID,
        // seed lastBuyerMessageAt so Tier B of the inbound sweep picks
        // it up on the NEXT tick, and let ingestCommerceMessage hydrate
        // the actual message body.
        //
        // threadKey is namespaced `conv:<id>` so it can't collide with
        // Trading-API-derived tickets (`ord:…`, `itm:…`, `sub:…`) — if
        // a Trading sweep later creates its own ticket for the same
        // conversation they'll be separate rows; the read-time dedup in
        // /api/helpdesk/tickets/[id] already handles any message overlap.
        const lastMsgDate = c.lastMessageDate ? new Date(c.lastMessageDate) : null;
        const bootstrapLastBuyerAt =
          lastMsgDate && !Number.isNaN(lastMsgDate.getTime()) ? lastMsgDate : null;
        try {
          await db.helpdeskTicket.create({
            data: {
              integrationId: integration.id,
              channel: integration.platform,
              threadKey: `conv:${c.conversationId}`,
              buyerUserId: c.otherPartyUsername,
              buyerName: c.otherPartyUsername,
              ebayItemId: c.itemId ?? null,
              ebayConversationId: c.conversationId,
              type: HelpdeskTicketType.QUERY,
              kind: HelpdeskTicketKind.POST_SALES,
              status: HelpdeskTicketStatus.TO_DO,
              unreadCount: 1,
              lastBuyerMessageAt: bootstrapLastBuyerAt,
            },
          });
        } catch (err) {
          // Two ticks could race the same conversationId, so a unique-
          // constraint failure just means the other tick won — fine.
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Unique constraint")) {
            console.warn(
              "[helpdesk-sync] conversation-discovery create failed",
              {
                integrationId: integration.id,
                conversationId: c.conversationId,
                buyer: c.otherPartyUsername,
                error: msg,
              },
            );
          }
        }
        continue;
      }
      let picked = candidates;
      if (c.itemId) {
        const itemMatch = candidates.filter((t) => t.ebayItemId === c.itemId);
        if (itemMatch.length > 0) picked = itemMatch;
      }
      picked.sort((a, b) => {
        const ta = a.lastBuyerMessageAt?.getTime() ?? 0;
        const tb = b.lastBuyerMessageAt?.getTime() ?? 0;
        return tb - ta;
      });
      const target = picked[0];
      if (!target) continue;
      // Bootstrap ebayConversationId for the new Commerce Message inbound
      // sweep. We do this on EVERY matched ticket (even ones already at
      // unreadCount=1) so the sweep's working set grows over time without
      // requiring a mirror-read/unread action first.
      if (!target.ebayConversationId) {
        try {
          await db.helpdeskTicket.update({
            where: { id: target.id },
            data: { ebayConversationId: c.conversationId },
          });
          convoIdsPersisted += 1;
        } catch (err) {
          // Unique collisions would never happen (column isn't unique);
          // log other failures but keep the sweep going.
          console.warn(
            "[helpdesk-sync] failed to persist ebayConversationId",
            {
              ticketId: target.id,
              conversationId: c.conversationId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      if (target.unreadCount === 0) {
        await db.helpdeskTicket.update({
          where: { id: target.id },
          data: { unreadCount: 1 },
        });
        bumpedUnread += 1;
      }
    }

    // ── 2b. Bootstrap ebayConversationId for READ conversations ────────
    // The unread-matching branch above only persists IDs when a match
    // carries unreadCount>0. We want the inbound sweep (step 4) to have
    // the broadest possible working set, so do one batched lookup of
    // tickets whose buyer we scanned but whose ebayConversationId is
    // still null.
    //
    // IMPORTANT perf note: on the FIRST tick after deploy every ticket has
    // ebayConversationId=null, so naive per-ticket UPDATE loops blow past
    // Vercel's 60s gateway timeout. We cap total work per tick
    // (BOOTSTRAP_BUDGET) and collapse writes with one `updateMany` per
    // conversationId, which needs ~O(distinct buyers) round-trips
    // instead of O(tickets).
    const BOOTSTRAP_BUDGET = 300;
    if (scannedByBuyer.size > 0) {
      const buyerKeys = Array.from(scannedByBuyer.keys());
      const CHUNK = 200;
      // ticketId → conversationId, collected across chunks
      const pendingByConv = new Map<string, string[]>();
      let pendingTicketCount = 0;
      scan: for (let i = 0; i < buyerKeys.length; i += CHUNK) {
        const chunk = buyerKeys.slice(i, i + CHUNK);
        const chunkTickets = await db.helpdeskTicket.findMany({
          where: {
            integrationId: integration.id,
            ebayConversationId: null,
            isSpam: false,
            type: { not: HelpdeskTicketType.SYSTEM },
            OR: [
              { buyerUserId: { in: chunk, mode: "insensitive" } },
              {
                AND: [
                  { buyerUserId: null },
                  { buyerName: { in: chunk, mode: "insensitive" } },
                ],
              },
            ],
          },
          // Keep the per-tick budget bounded — any tickets we don't get to
          // this tick get picked up on the next one since they still have
          // ebayConversationId=null.
          take: BOOTSTRAP_BUDGET - pendingTicketCount,
          select: {
            id: true,
            buyerUserId: true,
            buyerName: true,
          },
        });
        for (const ticket of chunkTickets) {
          const key = (ticket.buyerUserId ?? ticket.buyerName ?? "").toLowerCase();
          const conv = scannedByBuyer.get(key);
          if (!conv) continue;
          const bucket = pendingByConv.get(conv.conversationId);
          if (bucket) bucket.push(ticket.id);
          else pendingByConv.set(conv.conversationId, [ticket.id]);
          pendingTicketCount += 1;
          if (pendingTicketCount >= BOOTSTRAP_BUDGET) break scan;
        }
      }
      for (const [conversationId, ids] of pendingByConv) {
        if (ids.length === 0) continue;
        try {
          const res = await db.helpdeskTicket.updateMany({
            where: { id: { in: ids } },
            data: { ebayConversationId: conversationId },
          });
          convoIdsPersisted += res.count;
        } catch (err) {
          console.warn(
            "[helpdesk-sync] failed to bootstrap ebayConversationId",
            {
              conversationId,
              ticketCount: ids.length,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }

    // ── 3. Clear local unread ONLY for buyers we confirmed are read ─────
    // Safety contract: a ticket is cleared back to read only when we
    // actually scanned the buyer's conversation this tick AND the
    // conversation is not unread. Buyers beyond the scanned window are
    // untouched — prevents the "oscillation" bug where local unread
    // flips to read because the conversation scrolled out of the window.
    let clearedStaleUnread = 0;
    const locallyUnread = await db.helpdeskTicket.findMany({
      where: {
        integrationId: integration.id,
        unreadCount: { gt: 0 },
        isSpam: false,
        type: { not: HelpdeskTicketType.SYSTEM },
      },
      select: { id: true, buyerUserId: true, buyerName: true },
    });
    const idsToClear = locallyUnread
      .filter((t) => {
        const buyerKey = (t.buyerUserId ?? t.buyerName)?.toLowerCase();
        if (!buyerKey) return false;
        // Only clear if we explicitly saw this buyer's conversation AND
        // confirmed it's not in the unread set.
        return (
          allSeenBuyersLower.has(buyerKey) && !unreadBuyersLower.has(buyerKey)
        );
      })
      .map((t) => t.id);
    if (idsToClear.length > 0) {
      const res = await db.helpdeskTicket.updateMany({
        where: { id: { in: idsToClear } },
        data: { unreadCount: 0 },
      });
      clearedStaleUnread = res.count;
    }

    const targetedDiscovery = await sweepSystemOrderListingConversations({
      integration,
      config,
      selfUsername,
      signals,
    });

    console.info(
      "[helpdesk-sync] commerce message unread sweep finished",
      {
        integrationId: integration.id,
        integrationLabel: integration.label,
        totalScanned,
        ebayUnreadConversations: unread.length,
        buyersSeen: allSeenBuyersLower.size,
        bumpedUnread,
        clearedStaleUnread,
        convoIdsPersisted,
        activitySignals: signals.size,
        targetedListingCandidates: targetedDiscovery.candidates,
        targetedListingApiCalls: targetedDiscovery.apiCalls,
        targetedListingTicketsCreated: targetedDiscovery.ticketsCreated,
        targetedListingTicketsUpdated: targetedDiscovery.ticketsUpdated,
        targetedListingMessagesInserted: targetedDiscovery.messagesInserted,
      },
    );
  }
  return signals;
}

type TargetedListingDiscoveryStats = {
  candidates: number;
  apiCalls: number;
  ticketsCreated: number;
  ticketsUpdated: number;
  messagesInserted: number;
};

type TargetedSystemTicket = {
  id: string;
  threadKey: string;
  buyerUserId: string | null;
  buyerName: string | null;
  ebayItemId: string | null;
  ebayOrderNumber: string | null;
  subject: string | null;
};

type TargetedConversationTicket = {
  id: string;
  status: HelpdeskTicketStatus;
  isArchived: boolean;
  unreadCount: number;
  ebayConversationId: string | null;
  buyerUserId: string | null;
  buyerName: string | null;
  lastBuyerMessageAt: Date | null;
  lastAgentMessageAt: Date | null;
};

function messageDateMs(message: CommerceMessage): number {
  const ms = message.createdDate ? Date.parse(message.createdDate) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function latestMessage(messages: CommerceMessage[]): CommerceMessage | null {
  let latest: CommerceMessage | null = null;
  for (const message of messages) {
    if (!latest || messageDateMs(message) > messageDateMs(latest)) {
      latest = message;
    }
  }
  return latest;
}

type ExistingCommerceMessageRow = {
  id: string;
  ebayMessageId: string | null;
  rawMedia: Prisma.JsonValue;
};

function commerceMediaForDb(message: CommerceMessage): CommerceMessageMedia[] {
  return (message.media ?? []).filter((media) => media.url.trim().length > 0);
}

function rawMediaUrlSet(rawMedia: Prisma.JsonValue): Set<string> {
  const urls = new Set<string>();
  if (!Array.isArray(rawMedia)) return urls;
  for (const item of rawMedia) {
    if (typeof item === "string") {
      urls.add(item.replace(/&amp;/gi, "&"));
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const rawUrl =
      typeof obj.url === "string"
        ? obj.url
        : typeof obj.URL === "string"
          ? obj.URL
          : typeof obj.MediaURL === "string"
            ? obj.MediaURL
            : typeof obj.mediaUrl === "string"
              ? obj.mediaUrl
              : typeof obj.mediaURL === "string"
                ? obj.mediaURL
                : typeof obj.href === "string"
                  ? obj.href
                  : typeof obj.downloadUrl === "string"
                    ? obj.downloadUrl
                    : null;
    if (rawUrl) urls.add(rawUrl.replace(/&amp;/gi, "&"));
  }
  return urls;
}

async function refreshExistingCommerceMessageMedia(args: {
  existingMessages: ExistingCommerceMessageRow[];
  messages: CommerceMessage[];
}): Promise<number> {
  const byMessageId = new Map(
    args.existingMessages
      .filter((row) => row.ebayMessageId)
      .map((row) => [row.ebayMessageId!, row]),
  );
  let updated = 0;
  for (const message of args.messages) {
    const media = commerceMediaForDb(message);
    if (media.length === 0) continue;
    const existing = byMessageId.get(message.messageId);
    if (!existing) continue;

    const existingUrls = rawMediaUrlSet(existing.rawMedia);
    const missing = media.filter((item) => !existingUrls.has(item.url));
    if (missing.length === 0) continue;

    const existingArray = Array.isArray(existing.rawMedia)
      ? (existing.rawMedia as Prisma.JsonArray)
      : [];
    const nextMedia = [
      ...existingArray,
      ...missing.map((item) => item as unknown as Prisma.JsonValue),
    ] as Prisma.JsonValue;

    try {
      await db.helpdeskMessage.update({
        where: { id: existing.id },
        data: { rawMedia: nextMedia as Prisma.InputJsonValue },
      });
      updated += 1;
    } catch (err) {
      console.warn("[helpdesk-sync] failed to refresh commerce message media", {
        messageId: message.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return updated;
}

function isMessageFromBuyer(
  message: CommerceMessage,
  buyerUsername: string,
): boolean {
  return message.senderUsername?.toLowerCase() === buyerUsername.toLowerCase();
}

function isMessageFromSelf(
  message: CommerceMessage,
  selfUsername?: string,
): boolean {
  return (
    !!selfUsername &&
    !!message.senderUsername &&
    message.senderUsername.toLowerCase() === selfUsername.toLowerCase()
  );
}

const TARGETED_DISCOVERY_BAD_BUYER_IDS = new Set([
  "adam",
  "hi",
  "ebay",
  "theperfectpart",
  "telitetech",
]);

function isUsableTargetedBuyerUsername(
  buyerUsername: string,
  selfUsername?: string,
): boolean {
  const value = buyerUsername.trim();
  const lower = value.toLowerCase();
  if (value.length < 3) return false;
  if (/\s/.test(value)) return false;
  if (TARGETED_DISCOVERY_BAD_BUYER_IDS.has(lower)) return false;
  if (selfUsername && lower === selfUsername.toLowerCase()) return false;
  return true;
}

async function findListingConversationForBuyer(args: {
  integrationId: string;
  config: Parameters<typeof getConversations>[1];
  buyerUsername: string;
  itemId: string;
  selfUsername?: string;
}): Promise<{
  conversation: CommerceMessageConversation | null;
  apiCalls: number;
  needsReauth: boolean;
}> {
  let apiCalls = 0;
  for (
    let offset = 0;
    offset < TARGETED_LISTING_DISCOVERY_SCAN_WINDOW;
    offset += COMMERCE_PAGE_SIZE
  ) {
    apiCalls += 1;
    const res = await getConversations(args.integrationId, args.config, {
      conversationType: "FROM_MEMBERS",
      referenceId: args.itemId,
      referenceType: "LISTING",
      limit: COMMERCE_PAGE_SIZE,
      offset,
      selfUsernameHint: args.selfUsername,
    });
    if (res.needsReauth) {
      return { conversation: null, apiCalls, needsReauth: true };
    }
    const match = res.conversations.find(
      (c) =>
        c.otherPartyUsername?.toLowerCase() ===
        args.buyerUsername.toLowerCase(),
    );
    if (match) return { conversation: match, apiCalls, needsReauth: false };
    if (res.conversations.length < COMMERCE_PAGE_SIZE) break;
  }
  return { conversation: null, apiCalls, needsReauth: false };
}

async function findOrCreateTargetedConversationTicket(args: {
  integration: Integration;
  systemTicket: TargetedSystemTicket;
  conversation: CommerceMessageConversation;
  latestBuyerAt: Date | null;
}): Promise<{ ticket: TargetedConversationTicket | null; created: boolean }> {
  const orderNumber = args.systemTicket.ebayOrderNumber;
  const buyerUserId =
    args.conversation.otherPartyUsername ?? args.systemTicket.buyerUserId;
  if (!orderNumber || !buyerUserId) return { ticket: null, created: false };

  const existing = await db.helpdeskTicket.findFirst({
    where: {
      integrationId: args.integration.id,
      isSpam: false,
      NOT: [
        { type: HelpdeskTicketType.SYSTEM },
        { threadKey: { startsWith: "sys:" } },
      ],
      OR: [
        { ebayConversationId: args.conversation.conversationId },
        { ebayOrderNumber: orderNumber },
      ],
    },
    select: {
      id: true,
      status: true,
      isArchived: true,
      unreadCount: true,
      ebayConversationId: true,
      buyerUserId: true,
      buyerName: true,
      lastBuyerMessageAt: true,
      lastAgentMessageAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (existing) {
    return { ticket: existing, created: false };
  }

  const threadKey = `ord:${orderNumber}|buyer:${buyerUserId.toLowerCase()}`;
  const buyerName = args.systemTicket.buyerName ?? buyerUserId;
  const subject =
    args.conversation.lastMessageSubject ?? `Message from ${buyerUserId}`;
  try {
    const created = await db.helpdeskTicket.create({
      data: {
        integrationId: args.integration.id,
        channel: args.integration.platform,
        threadKey,
        buyerUserId,
        buyerName,
        ebayItemId: args.conversation.itemId ?? args.systemTicket.ebayItemId,
        ebayOrderNumber: orderNumber,
        ebayConversationId: args.conversation.conversationId,
        subject,
        kind: HelpdeskTicketKind.POST_SALES,
        type: HelpdeskTicketType.QUERY,
        status: HelpdeskTicketStatus.TO_DO,
        unreadCount: 1,
        lastBuyerMessageAt: args.latestBuyerAt,
        metadata: {
          commerceDiscovery: {
            source: "system_order_listing_sweep",
            systemTicketId: args.systemTicket.id,
            discoveredAt: new Date().toISOString(),
          },
        } as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        status: true,
        isArchived: true,
        unreadCount: true,
        ebayConversationId: true,
        buyerUserId: true,
        buyerName: true,
        lastBuyerMessageAt: true,
        lastAgentMessageAt: true,
      },
    });
    return { ticket: created, created: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Unique constraint")) {
      console.warn("[helpdesk-sync] targeted conversation create failed", {
        integrationId: args.integration.id,
        orderNumber,
        conversationId: args.conversation.conversationId,
        error: msg,
      });
      return { ticket: null, created: false };
    }
    const raced = await db.helpdeskTicket.findUnique({
      where: {
        integrationId_threadKey: {
          integrationId: args.integration.id,
          threadKey,
        },
      },
      select: {
        id: true,
        status: true,
        isArchived: true,
        unreadCount: true,
        ebayConversationId: true,
        buyerUserId: true,
        buyerName: true,
        lastBuyerMessageAt: true,
        lastAgentMessageAt: true,
      },
    });
    return { ticket: raced, created: false };
  }
}

async function hydrateTargetedCommerceConversation(args: {
  integration: Integration;
  ticket: TargetedConversationTicket;
  systemTicket: TargetedSystemTicket;
  conversation: CommerceMessageConversation;
  messages: CommerceMessage[];
  selfUsername?: string;
}): Promise<{ messagesInserted: number; ticketUpdated: boolean }> {
  const incomingIds = args.messages
    .map((m) => m.messageId)
    .filter((id): id is string => !!id);
  const existingMessages =
    incomingIds.length > 0
      ? await db.helpdeskMessage.findMany({
          where: {
            ticketId: args.ticket.id,
            ebayMessageId: { in: incomingIds },
          },
          select: { id: true, ebayMessageId: true, rawMedia: true },
        })
      : [];
  await refreshExistingCommerceMessageMedia({
    existingMessages,
    messages: args.messages,
  });
  const existingIds = new Set(
    existingMessages
      .map((m) => m.ebayMessageId)
      .filter((id): id is string => !!id),
  );

  const arRows =
    incomingIds.length > 0 && args.systemTicket.ebayOrderNumber
      ? await db.autoResponderSendLog.findMany({
          where: {
            integrationId: args.integration.id,
            orderNumber: args.systemTicket.ebayOrderNumber,
            eventType: "SENT",
            OR: [
              { externalMessageId: { in: incomingIds } },
              { renderedBody: { not: null } },
            ],
          },
          select: { externalMessageId: true, renderedBody: true },
        })
      : [];
  const autoResponderMessageIds = new Set(
    arRows
      .map((row) => row.externalMessageId)
      .filter((id): id is string => !!id),
  );
  const autoResponderBodyHashes = new Set(
    arRows
      .map((row) => hashBodyForMatch(row.renderedBody))
      .filter((hash) => hash.length > 0),
  );

  let messagesInserted = 0;
  const novel = [...args.messages]
    .filter((m) => !existingIds.has(m.messageId))
    .sort((a, b) => messageDateMs(a) - messageDateMs(b));
  for (const message of novel) {
    const sourceOverride =
      isMessageFromSelf(message, args.selfUsername) &&
      (autoResponderMessageIds.has(message.messageId) ||
        autoResponderBodyHashes.has(hashBodyForMatch(message.messageBody)))
        ? HelpdeskMessageSource.AUTO_RESPONDER
        : undefined;
    await ingestCommerceMessage({
      ticketId: args.ticket.id,
      message,
      selfUsername: args.selfUsername,
      buyerName:
        args.ticket.buyerName ??
        args.systemTicket.buyerName ??
        args.conversation.otherPartyUsername ??
        args.systemTicket.buyerUserId,
      buyerUserId:
        args.ticket.buyerUserId ??
        args.conversation.otherPartyUsername ??
        args.systemTicket.buyerUserId,
      sourceOverride,
    });
    messagesInserted += 1;
  }

  let latestBuyerAt = args.ticket.lastBuyerMessageAt;
  let latestAgentAt = args.ticket.lastAgentMessageAt;
  for (const message of args.messages) {
    const sentAtMs = messageDateMs(message);
    if (sentAtMs <= 0) continue;
    const sentAt = new Date(sentAtMs);
    if (isMessageFromSelf(message, args.selfUsername)) {
      if (!latestAgentAt || sentAt > latestAgentAt) latestAgentAt = sentAt;
    } else {
      if (!latestBuyerAt || sentAt > latestBuyerAt) latestBuyerAt = sentAt;
    }
  }

  const newest = latestMessage(args.messages);
  const latestFromBuyer =
    !!newest &&
    !!(
      args.conversation.otherPartyUsername ?? args.systemTicket.buyerUserId
    ) &&
    isMessageFromBuyer(
      newest,
      (args.conversation.otherPartyUsername ?? args.systemTicket.buyerUserId)!,
    );

  const update: Prisma.HelpdeskTicketUpdateInput = {
    ebayConversationId: args.conversation.conversationId,
    ebayItemId: args.conversation.itemId ?? args.systemTicket.ebayItemId,
    ebayOrderNumber: args.systemTicket.ebayOrderNumber,
    buyerUserId:
      args.ticket.buyerUserId ??
      args.conversation.otherPartyUsername ??
      args.systemTicket.buyerUserId,
    buyerName:
      args.ticket.buyerName ??
      args.systemTicket.buyerName ??
      args.conversation.otherPartyUsername ??
      args.systemTicket.buyerUserId,
  };
  if (
    latestBuyerAt &&
    (!args.ticket.lastBuyerMessageAt || latestBuyerAt > args.ticket.lastBuyerMessageAt)
  ) {
    update.lastBuyerMessageAt = latestBuyerAt;
  }
  if (
    latestAgentAt &&
    (!args.ticket.lastAgentMessageAt || latestAgentAt > args.ticket.lastAgentMessageAt)
  ) {
    update.lastAgentMessageAt = latestAgentAt;
  }
  if (latestFromBuyer) {
    update.status = HelpdeskTicketStatus.TO_DO;
    update.unreadCount = 1;
    if (args.ticket.isArchived) {
      update.isArchived = false;
      update.archivedAt = null;
    }
    if (args.ticket.status === HelpdeskTicketStatus.RESOLVED) {
      update.reopenCount = { increment: 1 };
      update.lastReopenedAt = new Date();
    }
  }

  await db.helpdeskTicket.update({
    where: { id: args.ticket.id },
    data: update,
  });

  return { messagesInserted, ticketUpdated: true };
}

async function sweepSystemOrderListingConversations(args: {
  integration: Integration;
  config: Parameters<typeof getConversations>[1];
  selfUsername?: string;
  signals: CommerceActivitySignals;
}): Promise<TargetedListingDiscoveryStats> {
  const stats: TargetedListingDiscoveryStats = {
    candidates: 0,
    apiCalls: 0,
    ticketsCreated: 0,
    ticketsUpdated: 0,
    messagesInserted: 0,
  };

  const cutoff = new Date(
    Date.now() - TARGETED_LISTING_DISCOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  const systemTickets = await db.helpdeskTicket.findMany({
    where: {
      integrationId: args.integration.id,
      isSpam: false,
      ebayOrderNumber: { not: null },
      buyerUserId: { not: null },
      ebayItemId: { not: null },
      OR: [
        { type: HelpdeskTicketType.SYSTEM },
        { threadKey: { startsWith: "sys:" } },
        { systemMessageType: { not: null } },
      ],
      AND: [
        {
          OR: [
            { lastBuyerMessageAt: { gte: cutoff } },
            { lastAgentMessageAt: { gte: cutoff } },
            { updatedAt: { gte: cutoff } },
            { createdAt: { gte: cutoff } },
          ],
        },
      ],
    },
    select: {
      id: true,
      threadKey: true,
      buyerUserId: true,
      buyerName: true,
      ebayItemId: true,
      ebayOrderNumber: true,
      subject: true,
    },
    orderBy: [{ updatedAt: "desc" }],
    take: TARGETED_LISTING_DISCOVERY_BUDGET * 8,
  });

  const attemptedOrders = new Set<string>();
  for (const systemTicket of systemTickets) {
    if (stats.candidates >= TARGETED_LISTING_DISCOVERY_BUDGET) break;
    if (
      !systemTicket.buyerUserId ||
      !systemTicket.ebayItemId ||
      !systemTicket.ebayOrderNumber
    ) {
      continue;
    }
    if (
      !isUsableTargetedBuyerUsername(
        systemTicket.buyerUserId,
        args.selfUsername,
      )
    ) {
      continue;
    }
    if (attemptedOrders.has(systemTicket.ebayOrderNumber)) continue;
    attemptedOrders.add(systemTicket.ebayOrderNumber);

    const existingConversation = await db.helpdeskTicket.findFirst({
      where: {
        integrationId: args.integration.id,
        isSpam: false,
        ebayOrderNumber: systemTicket.ebayOrderNumber,
        NOT: [
          { type: HelpdeskTicketType.SYSTEM },
          { threadKey: { startsWith: "sys:" } },
        ],
      },
      select: { id: true },
    });
    if (existingConversation) continue;

    stats.candidates += 1;
    const found = await findListingConversationForBuyer({
      integrationId: args.integration.id,
      config: args.config,
      buyerUsername: systemTicket.buyerUserId,
      itemId: systemTicket.ebayItemId,
      selfUsername: args.selfUsername,
    });
    stats.apiCalls += found.apiCalls;
    if (found.needsReauth) break;
    if (!found.conversation) continue;

    const messagesResult = await getConversationMessages(
      args.integration.id,
      args.config,
      {
        conversationId: found.conversation.conversationId,
        limit: 50,
      },
    );
    stats.apiCalls += 1;
    if (messagesResult.needsReauth) break;
    if (messagesResult.status < 200 || messagesResult.status >= 300) continue;
    if (messagesResult.messages.length === 0) continue;

    const newest = latestMessage(messagesResult.messages);
    if (!newest || !isMessageFromBuyer(newest, systemTicket.buyerUserId)) {
      continue;
    }
    const latestBuyerAtMs = messageDateMs(newest);
    const latestBuyerAt =
      latestBuyerAtMs > 0 ? new Date(latestBuyerAtMs) : null;
    if (latestBuyerAt && latestBuyerAt < cutoff) continue;

    if (found.conversation.lastMessageDate) {
      const signalDate = new Date(found.conversation.lastMessageDate);
      if (!Number.isNaN(signalDate.getTime())) {
        args.signals.set(found.conversation.conversationId, signalDate);
      }
    }

    const { ticket, created } = await findOrCreateTargetedConversationTicket({
      integration: args.integration,
      systemTicket,
      conversation: found.conversation,
      latestBuyerAt,
    });
    if (!ticket) continue;
    if (created) stats.ticketsCreated += 1;

    const hydrated = await hydrateTargetedCommerceConversation({
      integration: args.integration,
      ticket,
      systemTicket,
      conversation: found.conversation,
      messages: messagesResult.messages,
      selfUsername: args.selfUsername,
    });
    stats.messagesInserted += hydrated.messagesInserted;
    if (!created && hydrated.ticketUpdated) stats.ticketsUpdated += 1;
  }

  return stats;
}

// ─── Commerce Message inbound ingest ────────────────────────────────────────

/** Max tickets we pull messages for per integration per tick. TPP typically
 *  has <10 conversations with new web-UI activity per tick; 15 keeps total
 *  Commerce Message calls (2 integrations × 15 = 30) comfortably under
 *  Vercel's 60s gateway timeout when stacked with the legacy sync + unread
 *  sweep. Tickets we don't get to this tick are re-ordered to the front on
 *  the next tick (activity-desc), so they still converge. */
const COMMERCE_INGEST_BUDGET = 15;

/** Activity window — only ingest for tickets whose last buyer or agent
 *  message is within this many days. Mirrors the web UI's "Last 60 days"
 *  default and keeps the working set bounded. */
const COMMERCE_INGEST_ACTIVITY_DAYS = 60;

/**
 * Re-read a recent tail of each Commerce Message conversation, not just
 * the last five minutes. eBay can attach buyer photos to messages we
 * already ingested as text-only; this window lets normal sync repair
 * those existing rows without a one-off data backfill.
 */
const COMMERCE_MESSAGE_MEDIA_REPAIR_WINDOW_MS = 36 * 60 * 60 * 1000;

/** Tier-C budget — maximum number of tickets per integration per tick for
 *  which we'll issue a fresh `resolveConversationIdForBuyer` call.
 *
 *  Rationale: Tiers A & B require ebayConversationId to already be bound
 *  on the ticket, which only happens via the unread-sweep bootstrap or
 *  mirrorReadStateToEbay. For high-volume accounts like TPP, the
 *  unread-sweep's scan window (top 800 FROM_MEMBERS by last_modified)
 *  can't possibly cover the full backlog, so read tickets whose
 *  conversations weren't recently touched sit forever with a null id and
 *  miss agent replies sent from the eBay web UI (the symptom: ticket
 *  09-14501-65972 never caught "Of course processing that for you now.").
 *
 *  Tier C closes that gap by resolving on demand. Each resolve is one
 *  extra API round-trip per ticket, so we cap it aggressively per tick
 *  (TICK_BUDGET). Once bound, the ticket graduates to Tier A/B and no
 *  longer hits this path. */
const COMMERCE_INGEST_RESOLVE_BUDGET = 5;

/**
 * Fetch messages directly from the eBay Commerce Message API for tickets
 * we've already bound to a conversationId, and ingest anything we don't
 * already have.
 *
 * Why this exists:
 *   runHelpdeskPoll scrapes agent outbound from the legacy Trading API
 *   "Sent" folder. Agent replies sent from eBay's modern web UI
 *   (ebay.com/mesg) are delivered through the Commerce Message API and
 *   NEVER appear in the Trading Sent folder. Without this sweep, those
 *   replies are invisible to Help Desk — the exact bug the user hit on
 *   ticket 09-14501-65972.
 *
 * Selection criteria:
 *   - `ebayConversationId IS NOT NULL` (bootstrapped by
 *     sweepUnreadConversationsFromWebUi + mirrorReadStateToEbay).
 *   - Active within the last COMMERCE_INGEST_ACTIVITY_DAYS. Tickets older
 *     than that are assumed to be closed out on eBay's side; agents
 *     almost never reply on them.
 *   - Non-SYSTEM, non-spam.
 *   - Ordered so the most-recently-active tickets consume the budget
 *     first.
 *
 * Dedupe:
 *   We use `ebayMessageId` + `externalId = "cm:<messageId>"` so Commerce
 *   Message IDs live in a separate namespace from Trading API IDs (there
 *   is no guaranteed overlap — eBay's systems assign them independently).
 *   The `@@unique([ticketId, externalId])` constraint catches any retries
 *   as a soft error we swallow.
 *
 * Direction:
 *   Re-derived locally via `senderUsername === selfUsername` because the
 *   raw `messageDirection` field is inconsistently populated. OUTBOUND =
 *   agent reply from eBay web UI (the whole reason this sweep exists).
 *
 * Gated by effectiveCanSyncReadState at the caller.
 */
async function sweepCommerceMessageInbound(
  integrations: Integration[],
  activitySignals: CommerceActivitySignals,
): Promise<void> {
  const cutoff = new Date(
    Date.now() - COMMERCE_INGEST_ACTIVITY_DAYS * 24 * 60 * 60 * 1000,
  );
  // Parallelize integrations — keeps the sweep inside Vercel's 60s
  // gateway timeout budget. Each integration's work is fully scoped
  // by integrationId in all reads and writes, so no cross-interference.
  await Promise.all(
    integrations.map((integration) =>
      sweepCommerceMessageInboundForIntegration(
        integration,
        cutoff,
        activitySignals,
      ).catch((err) => {
        console.error(
          "[helpdesk-sync] commerce message inbound ingest failed for integration",
          {
            integrationId: integration.id,
            integrationLabel: integration.label,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }),
    ),
  );
}

async function sweepCommerceMessageInboundForIntegration(
  integration: Integration,
  cutoff: Date,
  activitySignals: CommerceActivitySignals,
): Promise<void> {
  {
    if (
      integration.platform !== Platform.TPP_EBAY &&
      integration.platform !== Platform.TT_EBAY
    )
      return;
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) return;
    const selfUsername = getSellerUserId(integration) ?? undefined;

    // Selection strategy, in priority order:
    //
    //   (A) STALE tickets — tickets whose ebayConversationId appears in
    //       this tick's activitySignals AND where eBay's last-modified
    //       timestamp is newer than our max(lastBuyer,lastAgent). These
    //       are the exact tickets where an agent replied on the eBay web
    //       UI and the message is missing from Help Desk. The previous
    //       version ordered everything by lastAgentMessageAt DESC, which
    //       pushed these tickets to the BOTTOM of the list (their DB
    //       timestamps are stale by definition) so they never got
    //       serviced.
    //
    //   (B) Fresh tickets — the rest of the activity window, activity
    //       DESC. Fills any remaining budget.
    //
    // Per-integration budget is COMMERCE_INGEST_BUDGET (currently 15),
    // shared across both tiers.
    const candidateConvIds = Array.from(activitySignals.keys());
    let tickets: Array<{
      id: string;
      ebayConversationId: string | null;
      buyerUserId: string | null;
      buyerName: string | null;
      lastBuyerMessageAt: Date | null;
      lastAgentMessageAt: Date | null;
    }> = [];

    if (candidateConvIds.length > 0) {
      // Grab every ticket bound to a conversation eBay touched this
      // tick, then filter to the stale subset in JS (Prisma can't
      // express `max(a,b) < ebay_ts` natively).
      const maybeStale = await db.helpdeskTicket.findMany({
        where: {
          integrationId: integration.id,
          ebayConversationId: { in: candidateConvIds },
          isSpam: false,
          type: { not: HelpdeskTicketType.SYSTEM },
        },
        select: {
          id: true,
          ebayConversationId: true,
          buyerUserId: true,
          buyerName: true,
          lastBuyerMessageAt: true,
          lastAgentMessageAt: true,
        },
      });
      const stale = maybeStale
        .map((t) => {
          const ebayTs =
            t.ebayConversationId != null
              ? activitySignals.get(t.ebayConversationId)
              : undefined;
          if (!ebayTs) return null;
          const ourTs = Math.max(
            t.lastBuyerMessageAt?.getTime() ?? 0,
            t.lastAgentMessageAt?.getTime() ?? 0,
          );
          // Skew pad: ignore sub-minute clock skew so we don't spin on
          // the same tickets every tick.
          const SKEW_MS = 60 * 1000;
          if (ebayTs.getTime() <= ourTs + SKEW_MS) return null;
          return { ticket: t, delta: ebayTs.getTime() - ourTs };
        })
        .filter(
          (
            v,
          ): v is {
            ticket: (typeof maybeStale)[number];
            delta: number;
          } => v !== null,
        )
        // Most-stale first — the ticket the user is most likely to open.
        .sort((a, b) => b.delta - a.delta)
        .slice(0, COMMERCE_INGEST_BUDGET)
        .map((v) => v.ticket);
      tickets.push(...stale);
    }

    // Fill remaining budget with recent-activity tickets (tier B).
    if (tickets.length < COMMERCE_INGEST_BUDGET) {
      const fill = await db.helpdeskTicket.findMany({
        where: {
          integrationId: integration.id,
          ebayConversationId: { not: null },
          isSpam: false,
          type: { not: HelpdeskTicketType.SYSTEM },
          id: { notIn: tickets.map((t) => t.id) },
          OR: [
            { lastBuyerMessageAt: { gte: cutoff } },
            { lastAgentMessageAt: { gte: cutoff } },
          ],
        },
        select: {
          id: true,
          ebayConversationId: true,
          buyerUserId: true,
          buyerName: true,
          lastBuyerMessageAt: true,
          lastAgentMessageAt: true,
        },
        orderBy: [
          { lastAgentMessageAt: { sort: "desc", nulls: "last" } },
          { lastBuyerMessageAt: { sort: "desc", nulls: "last" } },
        ],
        take: COMMERCE_INGEST_BUDGET - tickets.length,
      });
      tickets.push(...fill);
    }

    // Tier C — on-demand conversationId resolution for recently-active
    // tickets that never got bootstrapped by the unread sweep. Has its
    // OWN budget (COMMERCE_INGEST_RESOLVE_BUDGET, additive on top of the
    // main ingest budget) so it can't be starved out on high-volume
    // accounts like TPP where tiers A+B routinely fill the entire
    // COMMERCE_INGEST_BUDGET.
    //
    // Each resolve costs one extra getConversations() call; capped to 5
    // per integration per tick to bound the overhead. Resolved tickets
    // are persisted and fall through to the ingest loop; on the next
    // tick they're picked up by Tier A/B for free.
    {
      const resolveSlot = COMMERCE_INGEST_RESOLVE_BUDGET;
      const unbound = await db.helpdeskTicket.findMany({
        where: {
          integrationId: integration.id,
          ebayConversationId: null,
          isSpam: false,
          type: { not: HelpdeskTicketType.SYSTEM },
          id: { notIn: tickets.map((t) => t.id) },
          // Must have enough identity to resolve against eBay.
          OR: [
            { buyerUserId: { not: null } },
            { buyerName: { not: null } },
          ],
          // Recent activity — otherwise no reason to suspect an agent
          // replied on the web UI.
          AND: [
            {
              OR: [
                { lastBuyerMessageAt: { gte: cutoff } },
                { lastAgentMessageAt: { gte: cutoff } },
              ],
            },
          ],
        },
        select: {
          id: true,
          ebayConversationId: true,
          buyerUserId: true,
          buyerName: true,
          lastBuyerMessageAt: true,
          lastAgentMessageAt: true,
        },
        orderBy: [
          { lastBuyerMessageAt: { sort: "desc", nulls: "last" } },
          { lastAgentMessageAt: { sort: "desc", nulls: "last" } },
        ],
        take: resolveSlot,
      });
      for (const ticket of unbound) {
        const buyer = ticket.buyerUserId ?? ticket.buyerName;
        if (!buyer) continue;
        try {
          const resolved = await resolveConversationIdForBuyer(
            integration.id,
            config,
            buyer,
          );
          const convId = resolved?.best?.conversationId;
          if (!convId) continue;
          // Persist so subsequent ticks skip this resolve.
          await db.helpdeskTicket
            .updateMany({
              where: { id: ticket.id, ebayConversationId: null },
              data: { ebayConversationId: convId },
            })
            .catch(() => undefined);
          tickets.push({ ...ticket, ebayConversationId: convId });
        } catch {
          // Swallow — don't let one buyer's resolution failure abort
          // the whole sweep. The ticket will be retried next tick.
          continue;
        }
      }
    }

    if (tickets.length === 0) return;

    let needsReauthLogged = false;
    let ticketsHit = 0;
    let messagesInserted = 0;
    let apiCalls = 0;

    for (const ticket of tickets) {
      if (!ticket.ebayConversationId) continue;

      // Pull everything newer than our most-recent known message for the
      // ticket, with a small skew pad so we don't miss borderline
      // timestamps. "since" is optional — if we've never had activity
      // on the ticket (unlikely given the WHERE clause), omit it and
      // let eBay return the first page.
      const lastKnownMs = Math.max(
        ticket.lastBuyerMessageAt?.getTime() ?? 0,
        ticket.lastAgentMessageAt?.getTime() ?? 0,
      );
      const since =
        lastKnownMs > 0
          ? new Date(
              lastKnownMs - COMMERCE_MESSAGE_MEDIA_REPAIR_WINDOW_MS,
            ).toISOString()
          : undefined;

      apiCalls += 1;
      const { messages, status, needsReauth } = await getConversationMessages(
        integration.id,
        config,
        {
          conversationId: ticket.ebayConversationId,
          since,
          limit: 50,
        },
      );
      if (needsReauth) {
        if (!needsReauthLogged) {
          console.info(
            "[helpdesk-sync] commerce.message scope missing — re-authorize integration",
            {
              integrationId: integration.id,
              integrationLabel: integration.label,
            },
          );
          needsReauthLogged = true;
        }
        break;
      }
      if (status < 200 || status >= 300) continue;
      if (messages.length === 0) continue;

      // Dedupe against messages we already have for this ticket. Match
      // by ebayMessageId primarily; the unique constraint on
      // (ticketId, externalId) is a safety net.
      const incomingIds = messages
        .map((m) => m.messageId)
        .filter((id): id is string => !!id);
      if (incomingIds.length === 0) continue;
      const existing = await db.helpdeskMessage.findMany({
        where: {
          ticketId: ticket.id,
          ebayMessageId: { in: incomingIds },
        },
        select: { id: true, ebayMessageId: true, rawMedia: true },
      });
      await refreshExistingCommerceMessageMedia({
        existingMessages: existing,
        messages,
      });
      const existingIds = new Set(
        existing.map((e) => e.ebayMessageId).filter((v): v is string => !!v),
      );
      const novel = messages.filter((m) => !existingIds.has(m.messageId));
      if (novel.length === 0) continue;

      // Snapshot for lastAgent/lastBuyerMessageAt recomputation.
      let latestBuyer = ticket.lastBuyerMessageAt ?? null;
      let latestAgent = ticket.lastAgentMessageAt ?? null;

      for (const m of novel) {
        await ingestCommerceMessage({
          ticketId: ticket.id,
          message: m,
          selfUsername,
          buyerName: ticket.buyerName ?? ticket.buyerUserId ?? null,
          buyerUserId: ticket.buyerUserId ?? null,
        });
        messagesInserted += 1;
        const sentAt = m.createdDate ? new Date(m.createdDate) : null;
        if (sentAt && !Number.isNaN(sentAt.getTime())) {
          const isOutbound =
            !!selfUsername &&
            !!m.senderUsername &&
            m.senderUsername === selfUsername;
          if (isOutbound) {
            if (!latestAgent || sentAt > latestAgent) latestAgent = sentAt;
          } else {
            if (!latestBuyer || sentAt > latestBuyer) latestBuyer = sentAt;
          }
        }
      }
      ticketsHit += 1;

      // Keep the ticket's activity timestamps in sync so folder routing
      // ("Waiting" vs "To Do") and the inbox's Latest Update column
      // reflect the new messages immediately. We intentionally DON'T
      // touch status/isArchived here — that's the ingest pipeline's job
      // in runHelpdeskPoll, and we'd rather not race it.
      const updates: Prisma.HelpdeskTicketUpdateInput = {};
      if (
        latestBuyer &&
        (!ticket.lastBuyerMessageAt ||
          latestBuyer > ticket.lastBuyerMessageAt)
      ) {
        updates.lastBuyerMessageAt = latestBuyer;
      }
      if (
        latestAgent &&
        (!ticket.lastAgentMessageAt ||
          latestAgent > ticket.lastAgentMessageAt)
      ) {
        updates.lastAgentMessageAt = latestAgent;
      }
      if (Object.keys(updates).length > 0) {
        try {
          await db.helpdeskTicket.update({
            where: { id: ticket.id },
            data: updates,
          });
        } catch (err) {
          console.warn(
            "[helpdesk-sync] failed to refresh ticket activity timestamps",
            {
              ticketId: ticket.id,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
    }
    if (needsReauthLogged) return;

    console.info("[helpdesk-sync] commerce message inbound ingest finished", {
      integrationId: integration.id,
      integrationLabel: integration.label,
      ticketsScanned: tickets.length,
      apiCalls,
      ticketsWithNewMessages: ticketsHit,
      messagesInserted,
    });
  }
}

/**
 * Insert a single Commerce Message API message into the ticket's thread.
 * Separated into its own function so the main sweep stays focused on
 * iteration + budget accounting, and so unit tests can hammer just the
 * direction/source classification rules in isolation.
 */
async function ingestCommerceMessage(args: {
  ticketId: string;
  message: CommerceMessage;
  selfUsername?: string;
  buyerName: string | null;
  buyerUserId: string | null;
  sourceOverride?: HelpdeskMessageSource;
}): Promise<void> {
  const {
    ticketId,
    message: m,
    selfUsername,
    buyerName,
    buyerUserId,
    sourceOverride,
  } = args;
  if (!m.messageId) return;

  // Direction: we trust senderUsername vs selfUsername over the API's
  // inconsistent `messageDirection` field. If selfUsername is missing we
  // default to INBOUND — better to file an agent reply as inbound than
  // lose it entirely, and manual correction is trivial.
  const direction =
    !!selfUsername && m.senderUsername === selfUsername
      ? HelpdeskMessageDirection.OUTBOUND
      : HelpdeskMessageDirection.INBOUND;

  // Source classification: messages from the eBay web UI are indirect
  // sends (agent typed into ebay.com/mesg, not Help Desk), so we tag
  // them as EBAY_UI. The existing source classifier is Trading-API
  // specific and doesn't map cleanly here — hard-code the source on
  // this path.
  const source = sourceOverride ?? HelpdeskMessageSource.EBAY_UI;

  const sentAt = m.createdDate ? new Date(m.createdDate) : new Date();

  const fromName =
    direction === HelpdeskMessageDirection.INBOUND
      ? buyerName ?? m.senderUsername ?? "Buyer"
      : source === HelpdeskMessageSource.AUTO_RESPONDER
        ? "Auto Responder"
        : "Agent (via eBay)";

  const fromIdentifier =
    direction === HelpdeskMessageDirection.INBOUND
      ? buyerUserId ?? m.senderUsername ?? null
      : null;

  const rawBody = m.messageBody ?? "";
  const bodyText = m.isHtml ? cleanMessageHtml(rawBody) : rawBody;
  const rawMedia = commerceMediaForDb(m);

  const finalSentAt = Number.isNaN(sentAt.getTime()) ? new Date() : sentAt;

  // If an auto-responder send was already mirrored directly into Help Desk,
  // do not add the same outbound again when Commerce Message later echoes it.
  // Promote any existing sent-copy row we find so the thread keeps one visible
  // AR bubble with the right source label.
  if (
    direction === HelpdeskMessageDirection.OUTBOUND &&
    source === HelpdeskMessageSource.AUTO_RESPONDER
  ) {
    const targetHash = hashBodyForMatch(bodyText);
    const windowMs = 10 * 60 * 1000;
    const candidates = await db.helpdeskMessage.findMany({
      where: {
        ticketId,
        direction: HelpdeskMessageDirection.OUTBOUND,
        deletedAt: null,
        sentAt: {
          gte: new Date(finalSentAt.getTime() - windowMs),
          lte: new Date(finalSentAt.getTime() + windowMs),
        },
      },
      select: { id: true, bodyText: true, source: true },
    });
    const existing = candidates.find(
      (candidate) => hashBodyForMatch(candidate.bodyText) === targetHash,
    );
    if (existing) {
      if (existing.source !== HelpdeskMessageSource.AUTO_RESPONDER) {
        await db.helpdeskMessage.update({
          where: { id: existing.id },
          data: { source: HelpdeskMessageSource.AUTO_RESPONDER },
        });
      }
      return;
    }
  }

  try {
    await db.helpdeskMessage.create({
      data: {
        ticketId,
        direction,
        source,
        // Namespace Commerce Message IDs to avoid colliding with
        // Trading API messageIDs, which flow through the same
        // (ticketId, externalId) unique constraint.
        externalId: `cm:${m.messageId}`,
        ebayMessageId: m.messageId,
        fromName,
        fromIdentifier,
        subject: null,
        bodyText,
        isHtml: !!m.isHtml,
        rawMedia: rawMedia as unknown as Prisma.InputJsonValue,
        rawData: {
          commerceMessage: true,
          conversationId: m.conversationId ?? null,
          senderUsername: m.senderUsername ?? null,
          recipientUsername: m.recipientUsername ?? null,
          readStatus: m.readStatus ?? null,
          messageDirection: m.messageDirection ?? null,
          mediaCount: rawMedia.length,
        } as Prisma.InputJsonValue,
        sentAt: finalSentAt,
      },
    });

    // Bump the ticket's last-activity timestamp on the matching side.
    // Without this, the stale-ticket selector in
    // sweepCommerceMessageInbound keeps flagging the same ticket as
    // stale every tick (eBay's last_modified_date stays newer than our
    // DB timestamp forever), burning budget and never converging. We
    // only advance the timestamp (never rewind it) — the WHERE clause
    // gates on the current DB value being older than what we just
    // ingested, so out-of-order backfills can't clobber a newer
    // legitimate value.
    try {
      if (direction === HelpdeskMessageDirection.INBOUND) {
        await db.helpdeskTicket.updateMany({
          where: {
            id: ticketId,
            OR: [
              { lastBuyerMessageAt: null },
              { lastBuyerMessageAt: { lt: finalSentAt } },
            ],
          },
          data: { lastBuyerMessageAt: finalSentAt },
        });
      } else {
        await db.helpdeskTicket.updateMany({
          where: {
            id: ticketId,
            OR: [
              { lastAgentMessageAt: null },
              { lastAgentMessageAt: { lt: finalSentAt } },
            ],
          },
          data: { lastAgentMessageAt: finalSentAt },
        });
        await db.helpdeskTicket.updateMany({
          where: { id: ticketId, firstResponseAt: null },
          data: { firstResponseAt: finalSentAt },
        });
      }
    } catch (err) {
      console.warn(
        "[helpdesk-sync] failed to bump ticket timestamp after commerce ingest",
        {
          ticketId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  } catch (err) {
    // Unique-constraint races are expected (two ticks racing the same
    // message). Anything else we want to see.
    if (
      !(err instanceof Error) ||
      !err.message.includes("Unique constraint failed")
    ) {
      console.error("[helpdesk-sync] commerce-message insert failed", {
        ticketId,
        messageId: m.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Re-export for tests / cron integration.
export { extractEbayOrderNumber, looksLikeHtmlBody, ingestCommerceMessage };
