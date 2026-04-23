/**
 * Push helpdesk read/unread state back to eBay via ReviseMyMessages.
 *
 * Why this lives in its own file:
 *   The batch API route (`/api/helpdesk/tickets/batch`) and the CLI
 *   diagnostic (`scripts/helpdesk-diagnose-read-mirror.ts`) both need to
 *   execute the identical mirror path. Duplicating the query + API-call
 *   logic invites drift; keeping it in a shared lib ensures anything the
 *   script reports matches exactly what the UI does in prod.
 *
 * Safety:
 *   - CALLERS are responsible for gating. This function assumes the caller
 *     already evaluated `helpdeskFlagsSnapshotAsync().effectiveCanSyncReadState`
 *     and decided to proceed. The function itself will still skip SYSTEM
 *     tickets and any message without an `ebayMessageId` because those are
 *     structural preconditions for a successful ReviseMyMessages call.
 *   - Per-integration write locks are NOT checked here because eBay's
 *     read/unread mirror is a "read-state sync", not a marketplace write
 *     that competes with listing pushes. It's gated entirely by the
 *     helpdesk-level flags exposed via `helpdeskFlagsSnapshotAsync`.
 */

import {
  HelpdeskMessageDirection,
  HelpdeskTicketType,
  Platform,
} from "@prisma/client";
import { db } from "@/lib/db";
import { buildEbayConfig, reviseMyMessages } from "@/lib/services/helpdesk-ebay";

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

  const messages = await db.helpdeskMessage.findMany({
    where: {
      ticketId: { in: ticketIds },
      direction: HelpdeskMessageDirection.INBOUND,
      ebayMessageId: { not: null },
      // FROM EBAY (SYSTEM) tickets must NEVER push read/unread state to eBay
      ticket: { type: { not: HelpdeskTicketType.SYSTEM } },
    },
    select: {
      ebayMessageId: true,
      ticket: { select: { integrationId: true } },
    },
  });
  console.info("[helpdesk.mirrorReadStateToEbay] eligible messages", {
    ticketIds,
    isRead,
    messageCount: messages.length,
  });
  if (messages.length === 0) {
    return { ...out, skippedReason: "noEligibleEbayMessages" };
  }

  const byIntegration = new Map<string, string[]>();
  for (const m of messages) {
    if (!m.ebayMessageId) continue;
    const list = byIntegration.get(m.ticket.integrationId) ?? [];
    list.push(m.ebayMessageId);
    byIntegration.set(m.ticket.integrationId, list);
  }

  for (const [integrationId, msgIds] of byIntegration.entries()) {
    const integration = await db.integration.findUnique({
      where: { id: integrationId },
    });
    const integrationLabel = integration?.label ?? "(unknown integration)";
    const platform = integration?.platform ?? "UNKNOWN";
    const perRow = {
      integrationId,
      integrationLabel,
      platform: String(platform),
      messageCount: msgIds.length,
      succeeded: 0,
      failed: 0,
      errors: [] as string[],
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

    // ReviseMyMessages caps at 10 IDs per call.
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
