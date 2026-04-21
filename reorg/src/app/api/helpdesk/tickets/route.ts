import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  buildFolderWhere,
  type HelpdeskFolderKey,
} from "@/lib/helpdesk/folders";
import { resolveHelpdeskSearch } from "@/lib/helpdesk/search";
import { Platform, type Prisma } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build a one-line preview from a message body. HTML bodies get tags stripped
 * and entities decoded; whitespace is collapsed; the result is truncated to
 * 240 chars to keep the inbox payload small while leaving the table room to
 * truncate further with CSS for visual polish.
 *
 * `stripGreetingFor` (optional): when supplied, we look at the very first
 * tokens of the cleaned text and, if they spell out the buyer's name
 * followed by a comma, drop them. The Customer column already shows the
 * buyer's name — repeating "Jonathan Towers," at the start of the preview
 * just steals horizontal space from the actual message content.
 */
const PREVIEW_MAX = 240;
function summarizeBody(
  body: string | null | undefined,
  isHtml: boolean,
  stripGreetingFor?: string | null,
): string {
  if (!body) return "";
  let text = body;
  if (isHtml) {
    text = text
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  text = text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();

  // If the message opens with a greeting matching the known buyer name
  // (eg. AR "Jonathan Towers, 🚨🚨 Great News!" or buyer "Hi/Hello/Dear"
  // forms), peel it off so the Customer column and the preview don't show
  // the same string back-to-back.
  if (stripGreetingFor) {
    const nameEsc = stripGreetingFor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 1) "<First Last>,\s+rest"  (AR shape)
    const direct = new RegExp(`^${nameEsc}\\s*,\\s*`, "i");
    if (direct.test(text)) text = text.replace(direct, "");
    // 2) "Hi <First Last>," / "Hello …" / "Dear …"
    const salutation = new RegExp(
      `^(?:Hi|Hello|Dear)\\s+${nameEsc}\\s*,\\s*`,
      "i",
    );
    if (salutation.test(text)) text = text.replace(salutation, "");
  }

  if (text.length > PREVIEW_MAX) {
    text = text.slice(0, PREVIEW_MAX - 1).trimEnd() + "…";
  }
  return text;
}

const folderEnum = z.enum([
  "pre_sales",
  "my_tickets",
  "all_tickets",
  "all_new",
  "all_to_do",
  "all_waiting",
  "buyer_cancellation",
  "snoozed",
  "resolved",
  "unassigned",
  "mentioned",
  "favorites",
  "spam",
  "archived",
]);

const querySchema = z.object({
  folder: folderEnum.default("all_tickets"),
  channel: z.enum(["TPP_EBAY", "TT_EBAY"]).optional(),
  search: z.string().trim().min(1).max(120).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse(Object.fromEntries(sp.entries()));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { folder, channel, search, cursor, limit } = parsed.data;
  // When a global search is active we deliberately ignore the folder filter
  // so the agent can find resolved / spam / archived tickets too — this is
  // how eDesk behaves and matches user expectation ("search the whole
  // mailbox"). The folder still drives the count badges in the sidebar
  // (separate endpoint), so the UX remains coherent.
  const where: Prisma.HelpdeskTicketWhereInput = search
    ? {}
    : {
        ...buildFolderWhere(folder as HelpdeskFolderKey, { userId: session.user.id }),
      };
  if (channel) where.channel = channel as Platform;

  // Global search: STRICT mode — eBay Order ID OR buyer username, never both.
  // The shape resolution lives in `lib/helpdesk/search.ts` so it's unit-
  // testable and the route stays a thin Prisma wrapper.
  const resolved = resolveHelpdeskSearch(search);
  if (resolved) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      resolved.where,
    ];
  }

  // Inbox list: keep the included relations minimal. We previously also
  // selected `_count: { messages, notes }`, but neither field is consumed by
  // the client (verified — `messageCount`/`noteCount` only appear in the
  // type, never in JSX) and they each issue an extra correlated subquery per
  // row. With `limit=50` that meant 100 extra subqueries per inbox load,
  // contributing materially to the 10s+ TTFB on this endpoint.
  const tickets = await db.helpdeskTicket.findMany({
    where,
    orderBy: [{ lastBuyerMessageAt: "desc" }, { updatedAt: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      integration: { select: { label: true, platform: true } },
      primaryAssignee: {
        select: { id: true, name: true, email: true, avatarUrl: true, handle: true },
      },
      tags: { include: { tag: true } },
    },
  });

  const hasMore = tickets.length > limit;
  const page = hasMore ? tickets.slice(0, limit) : tickets;

  // Compute a one-line `latestPreview` per ticket from the most recent real
  // message (excluding raw eBay digest envelopes — those still contain a
  // `<div id="UserInputtedText...">` block; the exploded sub-messages don't).
  // Done as a single batched query keyed off the page's ticket ids so the
  // inbox stays one-roundtrip even at limit=50.
  const previewByTicket = new Map<string, string>();
  if (page.length > 0) {
    const ticketIds = page.map((t) => t.id);
    const recent = await db.helpdeskMessage.findMany({
      where: {
        ticketId: { in: ticketIds },
        deletedAt: null,
        // Exclude un-exploded digest envelopes — their body is the entire
        // notification chrome, not a real message. Exploded sub-messages
        // still have HTML bodies but never contain the marker div, so we
        // can filter the envelopes out cheaply at the SQL layer.
        NOT: { bodyText: { contains: "UserInputtedText" } },
      },
      orderBy: { sentAt: "desc" },
      select: { ticketId: true, bodyText: true, isHtml: true },
    });
    // Build a fast ticketId -> buyerName map so we can pass the right
    // greeting-strip target to summarizeBody for each row without an
    // extra lookup.
    const buyerNameByTicket = new Map<string, string | null>();
    for (const t of page) {
      buyerNameByTicket.set(t.id, t.buyerName);
    }
    for (const m of recent) {
      if (previewByTicket.has(m.ticketId)) continue;
      previewByTicket.set(
        m.ticketId,
        summarizeBody(
          m.bodyText,
          m.isHtml,
          buyerNameByTicket.get(m.ticketId) ?? null,
        ),
      );
    }
  }

  return NextResponse.json({
    data: page.map((t) => ({
      id: t.id,
      channel: t.channel,
      integrationLabel: t.integration.label,
      threadKey: t.threadKey,
      buyerUserId: t.buyerUserId,
      buyerName: t.buyerName,
      buyerEmail: t.buyerEmail,
      ebayItemId: t.ebayItemId,
      ebayItemTitle: t.ebayItemTitle,
      ebayOrderNumber: t.ebayOrderNumber,
      subject: t.subject,
      latestPreview: previewByTicket.get(t.id) ?? null,
      kind: t.kind,
      type: t.type,
      typeOverridden: t.typeOverridden,
      status: t.status,
      isSpam: t.isSpam,
      isArchived: t.isArchived,
      isFavorite: t.isFavorite,
      isImportant: t.isImportant,
      snoozedUntil: t.snoozedUntil,
      primaryAssignee: t.primaryAssignee,
      unreadCount: t.unreadCount,
      lastBuyerMessageAt: t.lastBuyerMessageAt,
      lastAgentMessageAt: t.lastAgentMessageAt,
      firstResponseAt: t.firstResponseAt,
      reopenCount: t.reopenCount,
      // messageCount / noteCount intentionally omitted; not rendered.
      tags: t.tags.map((tt) => ({
        id: tt.tag.id,
        name: tt.tag.name,
        color: tt.tag.color,
      })),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
}
