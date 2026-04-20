/**
 * POST /api/helpdesk/tickets/batch
 *
 * Apply a single action to many tickets at once. Used by the bulk-select
 * checkboxes in the inbox.
 *
 * Supported actions:
 *   - addTags        { tagIds: string[] }    add tags (idempotent)
 *   - removeTags     { tagIds: string[] }    remove tags
 *   - setStatus      { status: HelpdeskTicketStatus }
 *   - assignPrimary  { userId: string | null }  null = unassign
 *   - markSpam       { isSpam: boolean }
 *   - archive        { isArchived: boolean }
 *   - markRead       { isRead: boolean }     toggles unreadCount (0 / 1)
 *
 * Each batch is audit-logged once with the affected ticket ids.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  HelpdeskMessageDirection,
  HelpdeskTicketStatus,
  Platform,
  Prisma,
} from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { helpdeskFlagsSnapshot } from "@/lib/helpdesk/flags";
import {
  buildEbayConfig,
  reviseMyMessages,
} from "@/lib/services/helpdesk-ebay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseSchema = z.object({
  ticketIds: z.array(z.string().min(1)).min(1).max(500),
});

const actionSchema = z.discriminatedUnion("action", [
  baseSchema.extend({
    action: z.literal("addTags"),
    tagIds: z.array(z.string().min(1)).min(1),
  }),
  baseSchema.extend({
    action: z.literal("removeTags"),
    tagIds: z.array(z.string().min(1)).min(1),
  }),
  baseSchema.extend({
    action: z.literal("setStatus"),
    status: z.nativeEnum(HelpdeskTicketStatus),
  }),
  baseSchema.extend({
    action: z.literal("assignPrimary"),
    userId: z.string().min(1).nullable(),
  }),
  baseSchema.extend({
    action: z.literal("markSpam"),
    isSpam: z.boolean(),
  }),
  baseSchema.extend({
    action: z.literal("archive"),
    isArchived: z.boolean(),
  }),
  baseSchema.extend({
    action: z.literal("markRead"),
    isRead: z.boolean(),
  }),
]);

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ids = Array.from(new Set(parsed.data.ticketIds));
  const userId = session.user.id;

  let summary: Record<string, unknown> = { count: 0 };

  const action = parsed.data;
  switch (action.action) {
    case "addTags": {
      const data = ids.flatMap((ticketId) =>
        action.tagIds.map((tagId) => ({
          ticketId,
          tagId,
          addedById: userId,
        })),
      );
      const r = await db.helpdeskTicketTag.createMany({
        data,
        skipDuplicates: true,
      });
      summary = { count: r.count, tagIds: action.tagIds };
      break;
    }
    case "removeTags": {
      const r = await db.helpdeskTicketTag.deleteMany({
        where: {
          ticketId: { in: ids },
          tagId: { in: action.tagIds },
        },
      });
      summary = { count: r.count, tagIds: action.tagIds };
      break;
    }
    case "setStatus": {
      const r = await db.helpdeskTicket.updateMany({
        where: { id: { in: ids } },
        data: {
          status: action.status,
          ...(action.status === HelpdeskTicketStatus.RESOLVED
            ? { resolvedAt: new Date(), resolvedById: userId }
            : {}),
        },
      });
      summary = { count: r.count, status: action.status };
      break;
    }
    case "assignPrimary": {
      const r = await db.helpdeskTicket.updateMany({
        where: { id: { in: ids } },
        data: { primaryAssigneeId: action.userId },
      });
      summary = { count: r.count, userId: action.userId };
      break;
    }
    case "markSpam": {
      const r = await db.helpdeskTicket.updateMany({
        where: { id: { in: ids } },
        data: { isSpam: action.isSpam },
      });
      summary = { count: r.count, isSpam: action.isSpam };
      break;
    }
    case "archive": {
      const r = await db.helpdeskTicket.updateMany({
        where: { id: { in: ids } },
        data: {
          isArchived: action.isArchived,
          archivedAt: action.isArchived ? new Date() : null,
        },
      });
      summary = { count: r.count, isArchived: action.isArchived };
      break;
    }
    case "markRead": {
      // We don't have a per-message read flag — `unreadCount` is the source
      // of truth surfaced in the inbox. Setting to 0 marks read; setting to
      // 1 makes the row visibly unread again so an agent can defer follow-up.
      const r = await db.helpdeskTicket.updateMany({
        where: { id: { in: ids } },
        data: { unreadCount: action.isRead ? 0 : 1 },
      });
      summary = { count: r.count, isRead: action.isRead };

      // Mirror to eBay when the read-sync flag is on AND safe-mode is off.
      // Best-effort: eBay rejection must never block the local update — the
      // user already sees the row as read. Surfaced through the audit log.
      const flags = helpdeskFlagsSnapshot();
      if (flags.effectiveCanSyncReadState) {
        const ebaySummary = await mirrorReadStateToEbay(ids, action.isRead);
        summary = { ...summary, ebay: ebaySummary };
      } else if (flags.enableEbayReadSync && flags.safeMode) {
        summary = {
          ...summary,
          ebay: { skipped: "safeMode" } as Record<string, unknown>,
        };
      }
      break;
    }
  }

  // Single grouping audit row that captures what was attempted batch-wide.
  // Used by the engine room / dashboards.
  await db.auditLog.create({
    data: {
      userId,
      action: `HELPDESK_BATCH_${action.action.toUpperCase()}`,
      entityType: "HelpdeskTicket",
      details: { ticketIds: ids, ...summary },
    },
  });

  // Per-ticket audit rows so the reader timeline (events endpoint) can show
  // "Adam marked this ticket as Resolved" on each specific ticket. We only
  // write per-ticket rows for the actions that meaningfully change the
  // ticket's visible state — addTags / removeTags are summarised in the
  // batch row alone since the timeline shows the resulting tag chips.
  const perTicketAction = perTicketActionFor(action);
  if (perTicketAction) {
    await db.auditLog.createMany({
      data: ids.map((ticketId) => ({
        userId,
        action: perTicketAction.action,
        entityType: "HelpdeskTicket",
        entityId: ticketId,
        details: perTicketAction.details,
      })),
    });
  }

  return NextResponse.json({ data: summary });
}

/**
 * Translate a batch action into the per-ticket audit row we want stamped on
 * each affected HelpdeskTicket. Returning `null` means the action is purely
 * batch-shaped and shouldn't generate per-ticket rows.
 */
function perTicketActionFor(
  action: z.infer<typeof actionSchema>,
): { action: string; details: Prisma.InputJsonValue } | null {
  switch (action.action) {
    case "setStatus":
      return {
        action: "HELPDESK_TICKET_STATUS_CHANGED",
        details: { status: action.status } satisfies Prisma.InputJsonValue,
      };
    case "assignPrimary":
      return {
        action: "HELPDESK_TICKET_ASSIGNED",
        details: { userId: action.userId } satisfies Prisma.InputJsonValue,
      };
    case "markSpam":
      return {
        action: "HELPDESK_BATCH_MARKSPAM",
        details: { isSpam: action.isSpam } satisfies Prisma.InputJsonValue,
      };
    case "archive":
      return {
        action: "HELPDESK_BATCH_ARCHIVE",
        details: {
          isArchived: action.isArchived,
        } satisfies Prisma.InputJsonValue,
      };
    case "markRead":
      return {
        action: "HELPDESK_BATCH_MARKREAD",
        details: { isRead: action.isRead } satisfies Prisma.InputJsonValue,
      };
    default:
      return null;
  }
}

/**
 * Best-effort mirror of reorG read-state into eBay's "Read" flag on the
 * underlying message rows. Only inbound messages that originated on eBay
 * (have an `ebayMessageId`) are eligible. Per-integration grouped so each
 * `ReviseMyMessages` call uses the right credentials.
 *
 * Failures are recorded but never thrown — the local update already happened
 * and the inbox is showing the new state to the agent. eBay disagreement
 * shows up in the audit log so we can investigate later.
 */
async function mirrorReadStateToEbay(
  ticketIds: string[],
  isRead: boolean,
): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  errors: string[];
}> {
  const out = { attempted: 0, succeeded: 0, failed: 0, errors: [] as string[] };
  if (ticketIds.length === 0) return out;

  const messages = await db.helpdeskMessage.findMany({
    where: {
      ticketId: { in: ticketIds },
      direction: HelpdeskMessageDirection.INBOUND,
      ebayMessageId: { not: null },
    },
    select: {
      ebayMessageId: true,
      ticket: { select: { integrationId: true } },
    },
  });
  if (messages.length === 0) return out;

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
    if (!integration || !integration.enabled) continue;
    if (
      integration.platform !== Platform.TPP_EBAY &&
      integration.platform !== Platform.TT_EBAY
    ) {
      continue;
    }
    const config = buildEbayConfig(integration);
    if (!config.appId || !config.refreshToken) continue;

    // ReviseMyMessages caps at 10 IDs per call.
    for (let i = 0; i < msgIds.length; i += 10) {
      const chunk = msgIds.slice(i, i + 10);
      out.attempted += chunk.length;
      try {
        const res = await reviseMyMessages(integrationId, config, {
          messageIDs: chunk,
          read: isRead,
        });
        if (res.success) {
          out.succeeded += chunk.length;
        } else {
          out.failed += chunk.length;
          if (res.error) out.errors.push(res.error);
        }
      } catch (err) {
        out.failed += chunk.length;
        out.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  return out;
}
