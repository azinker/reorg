/**
 * Push helpdesk read/unread state back to eBay.
 *
 * We hit TWO eBay APIs in sequence:
 *
 *   1. Commerce Message API (REST, /commerce/message/v1/update_conversation)
 *      This is what drives the modern eBay web UI ("From members" /
 *      "Unread from members" badge). It's what agents see when they log
 *      into ebay.com/mesg. If we don't flip this, the count on the web
 *      UI stays wrong even though Help Desk shows the ticket as read.
 *
 *   2. Trading API (ReviseMyMessages, XML)
 *      Legacy message-level flag. Kept as a "belt and suspenders"
 *      fallback so any consumer still driven by the Trading API store
 *      (older integrations, reporting jobs) sees the same state. This
 *      was our ORIGINAL mirror target before we discovered it doesn't
 *      fully drive the web UI for modern buyer Q&A threads.
 *
 * Both calls are best-effort per integration — one failing does not
 * block the other. We return an aggregated result so the caller
 * (/api/helpdesk/tickets/batch and scripts/helpdesk-diagnose-read-mirror)
 * can surface partial failures without aborting the overall operation.
 *
 * Why this lives in its own file:
 *   The batch API route and the CLI diagnostic both need to execute the
 *   identical mirror path. Duplicating the logic invites drift; keeping
 *   it in a shared lib ensures anything the script reports matches
 *   exactly what the UI does in prod.
 *
 * Safety:
 *   - CALLERS are responsible for gating via
 *     `helpdeskFlagsSnapshotAsync().effectiveCanSyncReadState`.
 *   - SYSTEM tickets (FROM_EBAY notifications) are skipped on both paths.
 *   - Commerce Message calls gracefully no-op (with a `needsReauth=true`
 *     flag in per-integration row) when the integration hasn't had
 *     commerce.message scope granted yet. The Trading API fallback
 *     still fires in that case, so the system degrades gracefully until
 *     the agent re-authorizes.
 */

import {
  HelpdeskMessageDirection,
  HelpdeskTicketType,
  Platform,
} from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildEbayConfig,
  reviseMyMessages,
} from "@/lib/services/helpdesk-ebay";
import {
  resolveConversationIdForBuyer,
  updateConversationRead,
} from "@/lib/services/helpdesk-commerce-message";

export interface MirrorReadStateResult {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: string[];
  skippedReason?: string;
  perIntegration: Array<{
    integrationId: string;
    integrationLabel: string;
    platform: string;
    messageCount: number;
    succeeded: number;
    failed: number;
    errors: string[];
    // New: Commerce Message API detail so callers can see whether the
    // modern web UI was actually flipped vs. only the legacy store.
    commerceMessage?: {
      attempted: number;
      succeeded: number;
      failed: number;
      needsReauth: boolean;
      errors: string[];
    };
  }>;
}

export async function mirrorReadStateToEbay(
  ticketIds: string[],
  isRead: boolean,
): Promise<MirrorReadStateResult> {
  const out: MirrorReadStateResult = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
    perIntegration: [],
  };
  if (ticketIds.length === 0) {
    return { ...out, skippedReason: "noTicketIds" };
  }

  // Fetch the tickets themselves so we can group by integration AND reach
  // buyerUserId/ebayItemId for the Commerce Message conversation lookup.
  // SYSTEM tickets (eBay notifications) are excluded on both mirror paths —
  // they never originate from a buyer conversation and the Commerce Message
  // API has no FROM_EBAY write surface for third-party apps.
  const tickets = await db.helpdeskTicket.findMany({
    where: {
      id: { in: ticketIds },
      type: { not: HelpdeskTicketType.SYSTEM },
    },
    select: {
      id: true,
      integrationId: true,
      buyerUserId: true,
      buyerName: true,
      ebayItemId: true,
    },
  });
  if (tickets.length === 0) {
    return { ...out, skippedReason: "noEligibleTickets" };
  }

  // Messages for the Trading API path. Same query as before — eligible
  // inbound messages with ebayMessageId, from non-SYSTEM tickets.
  const messages = await db.helpdeskMessage.findMany({
    where: {
      ticketId: { in: tickets.map((t) => t.id) },
      direction: HelpdeskMessageDirection.INBOUND,
      ebayMessageId: { not: null },
    },
    select: {
      ebayMessageId: true,
      ticket: { select: { integrationId: true } },
    },
  });
  console.info("[helpdesk.mirrorReadStateToEbay] eligible", {
    ticketIds,
    isRead,
    ticketCount: tickets.length,
    messageCount: messages.length,
  });

  // Group both sets by integration.
  const ticketsByIntegration = new Map<
    string,
    Array<(typeof tickets)[number]>
  >();
  for (const t of tickets) {
    const list = ticketsByIntegration.get(t.integrationId) ?? [];
    list.push(t);
    ticketsByIntegration.set(t.integrationId, list);
  }

  const msgsByIntegration = new Map<string, string[]>();
  for (const m of messages) {
    if (!m.ebayMessageId) continue;
    const list = msgsByIntegration.get(m.ticket.integrationId) ?? [];
    list.push(m.ebayMessageId);
    msgsByIntegration.set(m.ticket.integrationId, list);
  }

  // Every integrationId that has work to do on either path.
  const allIntegrationIds = new Set<string>([
    ...ticketsByIntegration.keys(),
    ...msgsByIntegration.keys(),
  ]);

  for (const integrationId of allIntegrationIds) {
    const integration = await db.integration.findUnique({
      where: { id: integrationId },
    });
    const integrationLabel = integration?.label ?? "(unknown integration)";
    const platform = integration?.platform ?? "UNKNOWN";
    const integrationTickets = ticketsByIntegration.get(integrationId) ?? [];
    const msgIds = msgsByIntegration.get(integrationId) ?? [];

    const perRow = {
      integrationId,
      integrationLabel,
      platform: String(platform),
      messageCount: msgIds.length,
      succeeded: 0,
      failed: 0,
      errors: [] as string[],
      commerceMessage: {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        needsReauth: false,
        errors: [] as string[],
      },
    };

    if (!integration || !integration.enabled) {
      perRow.errors.push(
        integration ? "integration disabled" : "integration not found",
      );
      perRow.failed = msgIds.length;
      out.perIntegration.push(perRow);
      continue;
    }
    if (
      integration.platform !== Platform.TPP_EBAY &&
      integration.platform !== Platform.TT_EBAY
    ) {
      perRow.errors.push(`unsupported platform ${integration.platform}`);
      perRow.failed = msgIds.length;
      out.perIntegration.push(perRow);
      continue;
    }
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) {
      perRow.errors.push("missing appId or refreshToken");
      perRow.failed = msgIds.length;
      out.perIntegration.push(perRow);
      continue;
    }

    // ── Path 1: Commerce Message API (drives the web UI) ─────────────────
    // Per-ticket conversation lookup. We resolve each ticket's
    // conversationId via `other_party_username=<buyerUserId>` against the
    // FROM_MEMBERS list, then call update_conversation to flip `read`.
    // Buyers typically have 1 active conversation — when multiple match,
    // we prefer the one whose itemId matches our stored ebayItemId, then
    // fall back to most-recent lastMessageDate.
    for (const ticket of integrationTickets) {
      const buyer = ticket.buyerUserId ?? ticket.buyerName;
      if (!buyer) {
        // No buyer to look up — legitimate for some edge tickets. Skip
        // silently; Trading API path may still work off ebayMessageIds.
        continue;
      }
      perRow.commerceMessage.attempted += 1;
      try {
        const resolved = await resolveConversationIdForBuyer(
          integrationId,
          config,
          buyer,
          { itemIdHint: ticket.ebayItemId ?? undefined },
        );
        if (resolved.needsReauth) {
          perRow.commerceMessage.needsReauth = true;
          perRow.commerceMessage.failed += 1;
          perRow.commerceMessage.errors.push(
            `ticket ${ticket.id}: needs re-authorization (commerce.message scope missing)`,
          );
          // Don't spam — only log once per integration.
          continue;
        }
        if (!resolved.best) {
          perRow.commerceMessage.failed += 1;
          perRow.commerceMessage.errors.push(
            `ticket ${ticket.id}: no conversation found for buyer ${buyer}`,
          );
          continue;
        }
        const result = await updateConversationRead(integrationId, config, {
          conversationId: resolved.best.conversationId,
          conversationType: "FROM_MEMBERS",
          read: isRead,
        });
        console.info(
          "[helpdesk.mirrorReadStateToEbay] updateConversationRead",
          {
            integrationId,
            integrationLabel,
            ticketId: ticket.id,
            buyer,
            conversationId: resolved.best.conversationId,
            read: isRead,
            status: result.status,
            success: result.success,
            errorId: result.errorId,
          },
        );
        if (result.success) {
          perRow.commerceMessage.succeeded += 1;
        } else {
          if (result.needsReauth) perRow.commerceMessage.needsReauth = true;
          perRow.commerceMessage.failed += 1;
          perRow.commerceMessage.errors.push(
            `ticket ${ticket.id}: status ${result.status}${
              result.errorMessage ? ` - ${result.errorMessage}` : ""
            }`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          "[helpdesk.mirrorReadStateToEbay] commerceMessage exception",
          {
            integrationId,
            integrationLabel,
            ticketId: ticket.id,
            error: msg,
          },
        );
        perRow.commerceMessage.failed += 1;
        perRow.commerceMessage.errors.push(`ticket ${ticket.id}: ${msg}`);
      }
    }

    // ── Path 2: Trading API (belt-and-suspenders for legacy store) ───────
    // ReviseMyMessages caps at 10 IDs per call. Errors here feed the main
    // `succeeded/failed/errors` counters so the existing UI surface (the
    // batch endpoint's response + the diagnose script output) keeps its
    // existing semantics. The Commerce Message path is reported separately
    // via `perRow.commerceMessage` so agents can see whether the modern
    // web UI flip landed.
    for (let i = 0; i < msgIds.length; i += 10) {
      const chunk = msgIds.slice(i, i + 10);
      out.attempted += chunk.length;
      try {
        const res = await reviseMyMessages(integrationId, config, {
          messageIDs: chunk,
          read: isRead,
        });
        console.info("[helpdesk.mirrorReadStateToEbay] reviseMyMessages", {
          integrationId,
          integrationLabel,
          platform: String(platform),
          chunkSize: chunk.length,
          sampleIds: chunk.slice(0, 3),
          isRead,
          success: res.success,
          ack: res.ack,
          error: res.error,
        });
        if (res.success) {
          out.succeeded += chunk.length;
          perRow.succeeded += chunk.length;
        } else {
          out.failed += chunk.length;
          perRow.failed += chunk.length;
          if (res.error) {
            out.errors.push(res.error);
            perRow.errors.push(res.error);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[helpdesk.mirrorReadStateToEbay] exception", {
          integrationId,
          integrationLabel,
          platform: String(platform),
          error: msg,
        });
        out.failed += chunk.length;
        perRow.failed += chunk.length;
        out.errors.push(msg);
        perRow.errors.push(msg);
      }
    }
    out.perIntegration.push(perRow);
  }

  return out;
}
