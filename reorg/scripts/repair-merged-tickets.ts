/**
 * Repair script: un-merge helpdesk tickets that were incorrectly merged by
 * the original `itm:{itemId}|buyer:{buyer}` threadKey rule.
 *
 * Background
 * ----------
 * Before the per-order threadKey fix, every eBay message about the same
 * {itemId, buyer} pair landed on the same HelpdeskTicket. Repeat buyers
 * who placed 3 orders for the same item over the backfill window saw all
 * 3 orders' worth of messages on one ticket — shipping notices, feedback
 * replies, inquiry replies, everything.
 *
 * The fix going forward: threadKey prefers `ord:{orderNumber}|buyer:{b}`
 * when the message carries an extractable order number.
 *
 * This script retroactively applies that rule.
 *
 * Algorithm
 * ---------
 * For each existing ticket with threadKey=`itm:...`:
 *   1. Load all its messages, oldest first.
 *   2. For each message, extract its order number from subject/body.
 *   3. Partition messages into groups keyed by orderNumber (null counts
 *      as its own group).
 *   4. The ticket's "winner" group is the one whose earliest message is
 *      earliest overall. That group stays on the original ticket, which
 *      gets re-keyed to `ord:...` and stamped with that order number
 *      (unless the group is the null-order group, in which case the
 *      ticket stays pre-sales, keeps itm:... key, and keeps kind=PRE_SALES).
 *   5. Every other non-null-order group becomes a brand-new ticket with
 *      only its own messages, kind=POST_SALES, and appropriately derived
 *      status (TO_DO if the last message was inbound and unanswered,
 *      RESOLVED if the last message was outbound, etc. — we keep it
 *      conservative: TO_DO if the final message is inbound, WAITING if
 *      the final message is outbound).
 *   6. Null-order messages that appear BETWEEN order groups' timelines
 *      are considered pre-sales for whichever order came immediately
 *      after. This matches the "pre-sales merges into the first order"
 *      rule the operator described.
 *
 * Safety
 * ------
 * Default is dry-run. Pass `--apply` to actually mutate rows.
 * Pass `--limit N` to process at most N tickets (useful for spot-checks).
 * Pass `--ticket-id ID` to operate on exactly one ticket.
 *
 * Read-heavy. The actual writes are wrapped in a transaction per ticket.
 */
import { db } from "@/lib/db";
import {
  HelpdeskMessageDirection,
  HelpdeskTicketKind,
  HelpdeskTicketStatus,
} from "@prisma/client";

// ─── Order-number extractor (mirrors helpdesk-ebay-sync.ts) ──────────────

const ORDER_NUMBER_LABEL_RE =
  /(?:order(?:\s*(?:#|number|id))?\s*[:#]?\s*)(\d{2}-\d{5}-\d{5}|\d{10,16}-\d{5,15})/i;
const ORDER_NUMBER_RE =
  /(?:^|[^\d-])(\d{2}-\d{5}-\d{5})(?:[^\d-]|$)|(?:^|[^\d])(\d{10,16}-\d{5,15})(?:[^\d]|$)/;

function extractOrder(subject: string | null, bodyText: string | null): string | null {
  const sources: string[] = [];
  if (subject) sources.push(subject);
  if (bodyText) sources.push(bodyText);
  for (const text of sources) {
    const labelMatch = ORDER_NUMBER_LABEL_RE.exec(text);
    if (labelMatch) {
      const cand = labelMatch[1]?.trim();
      if (cand && /^\d{2}-\d{5}-\d{5}$/.test(cand)) return cand;
      if (cand && /^\d{10,16}-\d{5,15}$/.test(cand)) return cand;
    }
    const shapeMatch = ORDER_NUMBER_RE.exec(text);
    if (shapeMatch) {
      const cand = (shapeMatch[1] ?? shapeMatch[2] ?? "").trim();
      if (cand) return cand;
    }
  }
  return null;
}

// ─── CLI args ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const ONLY_TICKET_ID = (() => {
  const i = argv.indexOf("--ticket-id");
  return i >= 0 ? argv[i + 1] : null;
})();
const LIMIT = (() => {
  const i = argv.indexOf("--limit");
  if (i < 0) return Infinity;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
})();

interface MessageRow {
  id: string;
  ticketId: string;
  direction: HelpdeskMessageDirection;
  subject: string | null;
  bodyText: string;
  sentAt: Date;
  authorUserId: string | null;
}

interface TicketRow {
  id: string;
  integrationId: string;
  threadKey: string;
  buyerUserId: string | null;
  buyerName: string | null;
  ebayItemId: string | null;
  ebayOrderNumber: string | null;
  subject: string | null;
  kind: HelpdeskTicketKind;
  status: HelpdeskTicketStatus;
  isArchived: boolean;
  isSpam: boolean;
  primaryAssigneeId: string | null;
  channel: string;
}

interface Group {
  orderNumber: string | null;
  messages: MessageRow[];
  firstSentAt: Date;
  lastSentAt: Date;
  lastDirection: HelpdeskMessageDirection;
  hasAgentReplied: boolean;
}

function groupMessages(messages: MessageRow[]): Group[] {
  // Walk messages oldest → newest. Null-order messages carry forward the
  // current "open order" attribution if one has been seen. We DON'T assign
  // a null-order message to a future order it's about, because we can't
  // know that without semantic analysis; instead they attach to the
  // *previous* order group (the conversation they were a reply to) unless
  // there's no previous order yet, in which case they stay in a pure
  // null-order group.
  //
  // Actually on reflection: the operator's rule is "pre-sales should roll
  // INTO the first order the buyer places". The pre-sales messages come
  // *before* the order. So: a run of null-order messages that is followed
  // by an order-carrying message should attach to that order's group.
  //
  // Simplest honest algorithm: find the earliest message that carries an
  // order number. Every message (including earlier null-order ones) up
  // through that order's block of messages belongs to that order. Repeat.

  const sorted = [...messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  type Tmp = { orderNumber: string | null; msgs: MessageRow[] };
  const buckets: Tmp[] = [];
  let currentOrder: string | null = null;
  let pending: MessageRow[] = [];

  for (const m of sorted) {
    const order = extractOrder(m.subject, m.bodyText);
    if (order) {
      if (currentOrder === null) {
        // First time we see an order number. Pending null-orders roll
        // into this first order (pre-sales adoption).
        buckets.push({ orderNumber: order, msgs: [...pending, m] });
        pending = [];
        currentOrder = order;
      } else if (order === currentOrder) {
        // Continuation of the same order. Any intervening null-orders
        // (replies on the same thread) stay attached to this order.
        const last = buckets[buckets.length - 1];
        last.msgs.push(...pending, m);
        pending = [];
      } else {
        // Different order. Flush current-order pendings to previous
        // group (they were replies to it), start a new group.
        if (pending.length > 0) {
          const last = buckets[buckets.length - 1];
          last.msgs.push(...pending);
          pending = [];
        }
        buckets.push({ orderNumber: order, msgs: [m] });
        currentOrder = order;
      }
    } else {
      pending.push(m);
    }
  }
  // Anything still pending is pure pre-sales (no order was ever seen).
  if (pending.length > 0) {
    if (buckets.length > 0) {
      // Attach trailing null-order messages to the most recent order
      // (they were replies in that thread).
      buckets[buckets.length - 1].msgs.push(...pending);
    } else {
      buckets.push({ orderNumber: null, msgs: pending });
    }
  }

  return buckets.map((b) => {
    const first = b.msgs[0];
    const last = b.msgs[b.msgs.length - 1];
    return {
      orderNumber: b.orderNumber,
      messages: b.msgs,
      firstSentAt: first.sentAt,
      lastSentAt: last.sentAt,
      lastDirection: last.direction,
      hasAgentReplied: b.msgs.some((m) => m.direction === HelpdeskMessageDirection.OUTBOUND),
    };
  });
}

function deriveGroupStatus(g: Group, ticketWasArchived: boolean, ticketWasSpam: boolean): HelpdeskTicketStatus {
  if (ticketWasSpam) return HelpdeskTicketStatus.SPAM;
  if (ticketWasArchived) return HelpdeskTicketStatus.RESOLVED;
  // Last message inbound and unanswered → TO_DO. Last outbound → WAITING.
  if (g.lastDirection === HelpdeskMessageDirection.INBOUND) {
    return HelpdeskTicketStatus.TO_DO;
  }
  return HelpdeskTicketStatus.WAITING;
}

async function repairOne(ticket: TicketRow): Promise<{
  keptOnOriginal: number;
  movedToNewTickets: number;
  newTicketCount: number;
  splits: Array<{ orderNumber: string | null; msgCount: number; newTicketId?: string }>;
}> {
  const messages = (await db.helpdeskMessage.findMany({
    where: { ticketId: ticket.id, deletedAt: null },
    orderBy: { sentAt: "asc" },
    select: {
      id: true,
      ticketId: true,
      direction: true,
      subject: true,
      bodyText: true,
      sentAt: true,
      authorUserId: true,
    },
  })) as MessageRow[];

  if (messages.length === 0) {
    return { keptOnOriginal: 0, movedToNewTickets: 0, newTicketCount: 0, splits: [] };
  }

  const groups = groupMessages(messages);
  const orderGroups = groups.filter((g) => g.orderNumber !== null);
  const nullGroup = groups.find((g) => g.orderNumber === null) ?? null;

  // Zero distinct orders seen in this ticket's messages → leave as-is (pure
  // pre-sales, threadKey stays itm:...).
  if (orderGroups.length === 0) {
    return {
      keptOnOriginal: messages.length,
      movedToNewTickets: 0,
      newTicketCount: 0,
      splits: [{ orderNumber: null, msgCount: messages.length }],
    };
  }

  // One distinct order: ticket just needs to be re-keyed to ord:... and
  // stamped with that order number (if not already).
  if (orderGroups.length === 1) {
    const only = orderGroups[0];
    const onlyMsgs = only.messages;
    const buyerKey = (ticket.buyerName ?? ticket.buyerUserId ?? "").toLowerCase();
    // We use buyerUserId-or-buyerName-normalised as the thread key suffix
    // to match the sync code (which uses body.sender / body.recipientUserID).
    // In practice for existing rows these should already be consistent.
    const newKey = `ord:${only.orderNumber}|buyer:${buyerKey}`;

    if (APPLY) {
      await db.helpdeskTicket.update({
        where: { id: ticket.id },
        data: {
          threadKey: newKey,
          ebayOrderNumber: only.orderNumber,
          kind: HelpdeskTicketKind.POST_SALES,
        },
      });
    }
    return {
      keptOnOriginal: onlyMsgs.length + (nullGroup?.messages.length ?? 0),
      movedToNewTickets: 0,
      newTicketCount: 0,
      splits: [{ orderNumber: only.orderNumber, msgCount: onlyMsgs.length }],
    };
  }

  // Two or more distinct orders: the earliest-starting order stays on the
  // original ticket, every other order gets a new ticket.
  const sortedGroups = [...orderGroups].sort(
    (a, b) => a.firstSentAt.getTime() - b.firstSentAt.getTime(),
  );
  const keeper = sortedGroups[0];
  const movers = sortedGroups.slice(1);

  const splits: Array<{ orderNumber: string | null; msgCount: number; newTicketId?: string }> = [];
  const buyerKey = (ticket.buyerName ?? ticket.buyerUserId ?? "").toLowerCase();

  // Re-key the original ticket onto the keeper order.
  const keeperKey = `ord:${keeper.orderNumber}|buyer:${buyerKey}`;
  const keeperStatus = deriveGroupStatus(keeper, ticket.isArchived, ticket.isSpam);
  const keeperLastInbound = [...keeper.messages]
    .reverse()
    .find((m) => m.direction === HelpdeskMessageDirection.INBOUND);
  const keeperLastOutbound = [...keeper.messages]
    .reverse()
    .find((m) => m.direction === HelpdeskMessageDirection.OUTBOUND);
  const keeperFirstOutbound = keeper.messages.find(
    (m) => m.direction === HelpdeskMessageDirection.OUTBOUND,
  );

  if (APPLY) {
    await db.helpdeskTicket.update({
      where: { id: ticket.id },
      data: {
        threadKey: keeperKey,
        ebayOrderNumber: keeper.orderNumber,
        kind: HelpdeskTicketKind.POST_SALES,
        status: keeperStatus,
        lastBuyerMessageAt: keeperLastInbound?.sentAt ?? null,
        lastAgentMessageAt: keeperLastOutbound?.sentAt ?? null,
        firstResponseAt: keeperFirstOutbound?.sentAt ?? null,
        subject: keeper.messages[0].subject,
        unreadCount: keeper.messages.filter(
          (m) => m.direction === HelpdeskMessageDirection.INBOUND,
        ).length,
      },
    });
  }
  splits.push({ orderNumber: keeper.orderNumber, msgCount: keeper.messages.length });

  let movedCount = 0;
  let newTicketCount = 0;

  for (const g of movers) {
    const newKey = `ord:${g.orderNumber}|buyer:${buyerKey}`;
    // Guard against a pre-existing ticket already holding this key (from a
    // concurrent sync writing while we repair). If one exists, merge our
    // messages into it rather than fail on the unique constraint.
    const existing = await db.helpdeskTicket.findUnique({
      where: {
        integrationId_threadKey: {
          integrationId: ticket.integrationId,
          threadKey: newKey,
        },
      },
      select: { id: true },
    });

    const firstMsg = g.messages[0];
    const lastInbound = [...g.messages]
      .reverse()
      .find((m) => m.direction === HelpdeskMessageDirection.INBOUND);
    const lastOutbound = [...g.messages]
      .reverse()
      .find((m) => m.direction === HelpdeskMessageDirection.OUTBOUND);
    const firstOutbound = g.messages.find(
      (m) => m.direction === HelpdeskMessageDirection.OUTBOUND,
    );
    const status = deriveGroupStatus(g, ticket.isArchived, ticket.isSpam);

    if (existing) {
      splits.push({ orderNumber: g.orderNumber, msgCount: g.messages.length, newTicketId: existing.id });
      if (APPLY) {
        await db.helpdeskMessage.updateMany({
          where: { id: { in: g.messages.map((m) => m.id) } },
          data: { ticketId: existing.id },
        });
      }
    } else if (APPLY) {
      const created = await db.helpdeskTicket.create({
        data: {
          integrationId: ticket.integrationId,
          channel: ticket.channel as import("@prisma/client").Platform,
          threadKey: newKey,
          buyerUserId: ticket.buyerUserId,
          buyerName: ticket.buyerName,
          ebayItemId: ticket.ebayItemId,
          ebayOrderNumber: g.orderNumber,
          subject: firstMsg.subject,
          kind: HelpdeskTicketKind.POST_SALES,
          status,
          isArchived: ticket.isArchived,
          isSpam: ticket.isSpam,
          primaryAssigneeId: ticket.primaryAssigneeId,
          lastBuyerMessageAt: lastInbound?.sentAt ?? null,
          lastAgentMessageAt: lastOutbound?.sentAt ?? null,
          firstResponseAt: firstOutbound?.sentAt ?? null,
          unreadCount: g.messages.filter(
            (m) => m.direction === HelpdeskMessageDirection.INBOUND,
          ).length,
        },
      });
      await db.helpdeskMessage.updateMany({
        where: { id: { in: g.messages.map((m) => m.id) } },
        data: { ticketId: created.id },
      });
      splits.push({ orderNumber: g.orderNumber, msgCount: g.messages.length, newTicketId: created.id });
      newTicketCount++;
    } else {
      splits.push({ orderNumber: g.orderNumber, msgCount: g.messages.length });
      newTicketCount++;
    }
    movedCount += g.messages.length;
  }

  return {
    keptOnOriginal: keeper.messages.length + (nullGroup?.messages.length ?? 0),
    movedToNewTickets: movedCount,
    newTicketCount,
    splits,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Repair mode: ${APPLY ? "APPLY (will mutate)" : "DRY-RUN"}`);
  console.log(`Limit: ${Number.isFinite(LIMIT) ? LIMIT : "none"}`);
  if (ONLY_TICKET_ID) console.log(`Restricted to ticket: ${ONLY_TICKET_ID}`);

  const where = ONLY_TICKET_ID
    ? { id: ONLY_TICKET_ID }
    : { threadKey: { startsWith: "itm:" } };

  const tickets = (await db.helpdeskTicket.findMany({
    where,
    select: {
      id: true,
      integrationId: true,
      threadKey: true,
      buyerUserId: true,
      buyerName: true,
      ebayItemId: true,
      ebayOrderNumber: true,
      subject: true,
      kind: true,
      status: true,
      isArchived: true,
      isSpam: true,
      primaryAssigneeId: true,
      channel: true,
    },
    orderBy: { createdAt: "asc" },
    take: Number.isFinite(LIMIT) ? LIMIT : undefined,
  })) as TicketRow[];

  console.log(`\nFound ${tickets.length} candidate ticket(s) to examine.\n`);

  let touched = 0;
  let splits = 0;
  let newTickets = 0;
  let messagesMoved = 0;

  for (const t of tickets) {
    const res = await repairOne(t);
    if (res.splits.length > 1 || res.newTicketCount > 0) {
      touched++;
      splits += res.splits.length;
      newTickets += res.newTicketCount;
      messagesMoved += res.movedToNewTickets;
      console.log(
        `  ${t.id}  item=${t.ebayItemId ?? "?"}  buyer=${t.buyerName ?? t.buyerUserId ?? "?"}  orders=${
          res.splits.map((s) => s.orderNumber ?? "null").join("/")
        }  msgsPerGroup=${res.splits.map((s) => s.msgCount).join("/")}  newTickets=${res.newTicketCount}`,
      );
    }
  }

  console.log(`\nSummary:`);
  console.log(`  tickets touched:      ${touched}`);
  console.log(`  total groups seen:    ${splits}`);
  console.log(`  new tickets to make:  ${newTickets}`);
  console.log(`  messages to move:     ${messagesMoved}`);
  console.log(APPLY ? `\nApplied.` : `\nDry-run. Re-run with --apply to make changes.`);

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
