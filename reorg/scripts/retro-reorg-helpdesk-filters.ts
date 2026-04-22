/**
 * Retroactive reorganization for the Help Desk filter hard-coding pass.
 *
 * Three user-defined filters are being deleted and replaced by hard-coded
 * sync rules. This script walks every existing ticket, evaluates the new
 * rules against its message history, and brings stored state in line with
 * what the new sync code would produce on a clean ingest:
 *
 *   1. From eBay messages
 *      ─────────────────────
 *      For every ticket where ANY INBOUND message looks like an eBay
 *      system notification (per `detectFromEbay`), set:
 *        - type              = SYSTEM
 *        - systemMessageType = matched event type from the LATEST such
 *                              message (so a thread that morphed from
 *                              "Return approved" → "Return closed" lands
 *                              on the most recent label)
 *
 *      We DON'T touch tickets the agent manually retyped
 *      (`typeOverridden = true`).
 *
 *   2. Cancellation requests
 *      ──────────────────────
 *      For every ticket where ANY INBOUND message qualifies under
 *      `detectCancellationRequest`, set type = CANCELLATION (unless
 *      agent-overridden) and attach the BUYER_CANCELLATION_TAG_NAME tag.
 *      Cancellation wins over SYSTEM — once eBay sent us "A buyer wants
 *      to cancel an order", the ticket is a cancellation regardless of
 *      follow-up notifications. The tag is what the existing
 *      buyer_cancellation folder keys off, so once attached the ticket
 *      appears in Cancel Requests automatically and drops out of All
 *      Tickets / To Do / Waiting.
 *
 *   3. Auto-Responder-only Archive
 *      ────────────────────────────
 *      Forward sweep: any ticket with exactly one message where that
 *      message looks like our Auto Responder → mark archived + RESOLVED.
 *      Reverse sweep: any ticket archived by the OLD AR filter (heuristic:
 *      archived AND first message looks like an AR AND has a buyer
 *      INBOUND strictly newer than the AR) → un-archive and re-derive
 *      status, because the new rule explicitly forbids re-archiving once
 *      the buyer has replied.
 *
 *      AR detection — historical messages are not tagged with
 *      `source = AUTO_RESPONDER` (that enum value was added later). Real
 *      AR rows in production carry `source = EBAY` or `EBAY_UI` with the
 *      tell-tale subject "…Your item has been Shipped to your address!"
 *      and/or the body marker "🚨🚨 Great News! Your item was shipped on
 *      time! 🚨🚨". The retro sweep matches on EITHER signal, then ALSO
 *      promotes the row's `source` to `AUTO_RESPONDER` so the new sync
 *      logic (which keys off the enum) treats it consistently going
 *      forward. New AR rows from `helpdesk-ar-ingest.ts` are tagged
 *      correctly already.
 *
 *   4. From eBay un-archive
 *      ────────────────────
 *      Tickets that were archived purely by the old "From eBay Messages"
 *      filter (i.e. their type is now SYSTEM and they're sitting in
 *      Archived) get un-archived so they appear under the new
 *      `from_ebay` folder. Status is re-derived: NEW → unread INBOUND
 *      first message, TO_DO → unread INBOUND with a prior reply,
 *      RESOLVED → no unread INBOUND, etc.
 *
 *   5. Filter cleanup
 *      ───────────────
 *      Finally, the obsolete filters are deleted. We match BOTH the
 *      original prompt names ("From eBay Messages", "A buyer wants to
 *      cancel an order", "Auto Responder Initial Message") AND the
 *      currently-stored production names ("Buyer Request Cancellation",
 *      "Shipped notifications → Archive") because the filters were
 *      renamed at some point. Anything else stays put.
 *
 * Safety:
 *   - DRY-RUN by default. Pass `--apply` to write.
 *   - All updates batched with `db.$transaction` per ticket so a single
 *     bad row can't roll back the whole sweep.
 *   - Idempotent: running twice is a no-op the second time.
 *
 * Usage (PowerShell):
 *   pnpm tsx ./scripts/retro-reorg-helpdesk-filters.ts            # dry run
 *   pnpm tsx ./scripts/retro-reorg-helpdesk-filters.ts -- --apply # commit
 */

import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  HelpdeskTicketStatus,
  HelpdeskTicketType,
  type Prisma,
} from "@prisma/client";
import { db } from "@/lib/db";
import {
  detectFromEbay,
  detectCancellationRequest,
} from "@/lib/helpdesk/from-ebay-detect";
import { BUYER_CANCELLATION_TAG_NAME } from "@/lib/helpdesk/folders";

const APPLY = process.argv.includes("--apply");
const PAGE = 200;

interface Counters {
  scanned: number;
  systemTagged: number;
  cancellationTagged: number;
  cancellationTagAttached: number;
  arOnlyArchived: number;
  arOnlyUnarchived: number;
  arSourcePromoted: number;
  fromEbayUnarchived: number;
  filtersDeleted: number;
}

/**
 * Subject + body markers that identify a message as one of our Auto
 * Responder sends. Historical AR rows weren't tagged with
 * `source = AUTO_RESPONDER` (that enum landed later), so the retro sweep
 * has to fall back to content matching. Both signals are taken from the
 * exact patterns the old user-defined filter "Auto Responder Initial
 * Message" / "Shipped notifications → Archive" matched on.
 */
const AR_SUBJECT_RE = /Your item has been Shipped/i;
const AR_BODY_RE = /Great News! Your item was shipped on time/i;

function isAutoResponderMessage(m: {
  direction: HelpdeskMessageDirection;
  source: HelpdeskMessageSource;
  subject: string | null;
  bodyText: string | null;
}): boolean {
  if (m.direction !== HelpdeskMessageDirection.OUTBOUND) return false;
  if (m.source === HelpdeskMessageSource.AUTO_RESPONDER) return true;
  if (m.subject && AR_SUBJECT_RE.test(m.subject)) return true;
  if (m.bodyText && AR_BODY_RE.test(m.bodyText)) return true;
  return false;
}

async function main(): Promise<void> {
  const c: Counters = {
    scanned: 0,
    systemTagged: 0,
    cancellationTagged: 0,
    cancellationTagAttached: 0,
    arOnlyArchived: 0,
    arOnlyUnarchived: 0,
    arSourcePromoted: 0,
    fromEbayUnarchived: 0,
    filtersDeleted: 0,
  };

  const totalTickets = await db.helpdeskTicket.count();
  console.log(
    `[retro] mode=${APPLY ? "APPLY" : "DRY-RUN"} tickets=${totalTickets}`,
  );

  // Resolve / upsert the cancellation tag once so per-row hot path is a
  // single createMany. Only created when --apply is set; in dry-run we
  // skip the upsert so a read-only inspection stays read-only.
  let cancellationTagId: string | null = null;
  if (APPLY) {
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
    cancellationTagId = tag.id;
  }

  // Walk tickets in stable id order so re-runs always cover the same
  // ground in the same order — much easier to debug than a randomized
  // sweep when something goes sideways mid-script.
  let cursor: string | null = null;
  for (;;) {
    const page: Array<{
      id: string;
      type: HelpdeskTicketType;
      typeOverridden: boolean;
      systemMessageType: string | null;
      isArchived: boolean;
      status: HelpdeskTicketStatus;
    }> = await db.helpdeskTicket.findMany({
      take: PAGE,
      skip: cursor ? 1 : 0,
      ...(cursor ? { cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: {
        id: true,
        type: true,
        typeOverridden: true,
        systemMessageType: true,
        isArchived: true,
        status: true,
      },
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    for (const t of page) {
      c.scanned++;
      await processTicket(t, c, cancellationTagId);
    }

    if (c.scanned % 1000 === 0) {
      console.log(`[retro] scanned=${c.scanned}`);
    }
  }

  // Step 5 — drop the obsolete filters. We match on exact name to avoid
  // clobbering any future filter the agent might create with similar
  // wording. The list covers BOTH the names used in the original product
  // brief AND the actual production names (filters were renamed at some
  // point).
  const obsoleteNames = [
    // Original product-brief names.
    "From eBay Messages",
    "A buyer wants to cancel an order",
    "Auto Responder Initial Message",
    // Current production names (verified via prod query).
    "Buyer Request Cancellation",
    "Shipped notifications → Archive",
  ];
  if (APPLY) {
    const del = await db.helpdeskFilter.deleteMany({
      where: { name: { in: obsoleteNames } },
    });
    c.filtersDeleted = del.count;
  } else {
    const found = await db.helpdeskFilter.findMany({
      where: { name: { in: obsoleteNames } },
      select: { id: true, name: true },
    });
    c.filtersDeleted = found.length;
    for (const f of found) {
      console.log(`[retro] would delete filter "${f.name}" (${f.id})`);
    }
  }

  console.log("\n[retro] summary");
  console.log(`  scanned                  = ${c.scanned}`);
  console.log(`  systemTagged             = ${c.systemTagged}`);
  console.log(`  cancellationTagged       = ${c.cancellationTagged}`);
  console.log(`  cancellationTagAttached  = ${c.cancellationTagAttached}`);
  console.log(`  arOnlyArchived           = ${c.arOnlyArchived}`);
  console.log(`  arOnlyUnarchived         = ${c.arOnlyUnarchived}`);
  console.log(`  arSourcePromoted         = ${c.arSourcePromoted}`);
  console.log(`  fromEbayUnarchived       = ${c.fromEbayUnarchived}`);
  console.log(`  filtersDeleted           = ${c.filtersDeleted}`);
  console.log(APPLY ? "[retro] applied." : "[retro] dry-run only.");

  await db.$disconnect();
}

async function processTicket(
  t: {
    id: string;
    type: HelpdeskTicketType;
    typeOverridden: boolean;
    systemMessageType: string | null;
    isArchived: boolean;
    status: HelpdeskTicketStatus;
  },
  c: Counters,
  cancellationTagId: string | null,
): Promise<void> {
  // Pull the message backbone once per ticket — direction, source, sentAt
  // and just enough body context to feed `detectFromEbay`.
  const messages = await db.helpdeskMessage.findMany({
    where: { ticketId: t.id },
    orderBy: { sentAt: "asc" },
    select: {
      id: true,
      direction: true,
      source: true,
      sentAt: true,
      subject: true,
      bodyText: true,
      fromName: true,
      fromIdentifier: true,
    },
  });
  if (messages.length === 0) return;

  const inbound = messages.filter(
    (m) => m.direction === HelpdeskMessageDirection.INBOUND,
  );

  // ── Rule 1 / 2 — type + systemMessageType + cancellation tag ──────────
  //
  // Scan every INBOUND message, not just the latest, so a ticket whose
  // origin trigger was "A buyer wants to cancel an order" or a "From
  // eBay" notification keeps the right type even after follow-up
  // messages arrive (buyer thanks, eBay confirms cancellation, etc.).
  //
  // Priority ladder:
  //   1. ANY message qualifies as a cancellation request → CANCELLATION
  //      (use the FIRST such match — the original trigger is what
  //      defines the ticket).
  //   2. ANY message is a From-eBay notification → SYSTEM
  //      (use the LATEST such match for `systemMessageType` so the
  //      surfaced sub-type reflects the most recent state — e.g. a
  //      "Return approved" thread that became "Return closed" shows
  //      "Return Closed").
  let nextType: HelpdeskTicketType | null = null;
  let nextSystemType: string | null = null;
  let isCancellation = false;

  for (const m of inbound) {
    const senderHint = m.fromName ?? m.fromIdentifier;
    if (
      !isCancellation &&
      detectCancellationRequest({
        sender: senderHint,
        subject: m.subject,
        bodyText: m.bodyText,
      })
    ) {
      isCancellation = true;
    }
    const fromEbay = detectFromEbay({
      sender: senderHint,
      subject: m.subject,
      bodyText: m.bodyText,
    });
    if (fromEbay.isFromEbay) {
      // Latest-wins for the systemMessageType chip — overwrite as we walk.
      nextSystemType = fromEbay.systemMessageType;
      // Inside the loop we only ever tag SYSTEM. The post-loop block below
      // promotes to CANCELLATION when applicable, so the cancellation case
      // is handled in one place rather than guarded here per-iteration.
      nextType = HelpdeskTicketType.SYSTEM;
    }
  }
  if (isCancellation) {
    nextType = HelpdeskTicketType.CANCELLATION;
    // CANCELLATION tickets don't use systemMessageType — the dedicated
    // Cancel Requests folder is the surfacing surface.
    nextSystemType = null;
  }

  // ── Rule 3 — AR-only archive forward + reverse ────────────────────────
  // Detect AR by content (see `isAutoResponderMessage`) because most
  // historical AR rows still carry source=EBAY/EBAY_UI.
  let archiveAction: "archive" | "unarchive" | null = null;
  // Track AR rows that should have their source promoted to
  // AUTO_RESPONDER so the live sync's AR-aware code paths (which key
  // off the enum) treat them consistently going forward.
  const arRowsToPromote: string[] = [];

  if (messages.length === 1) {
    const lone = messages[0]!;
    if (isAutoResponderMessage(lone)) {
      if (lone.source !== HelpdeskMessageSource.AUTO_RESPONDER) {
        arRowsToPromote.push(lone.id);
      }
      if (!t.isArchived) archiveAction = "archive";
    }
  } else if (t.isArchived) {
    // Reverse sweep — was this archive done by the OLD AR filter and
    // does the buyer message history say it should bounce? Heuristic:
    // earliest message looks like an AR AND there is at least one
    // INBOUND message strictly newer than it. The OLD filter re-archived
    // such tickets on every sync; the new rule never would.
    const first = messages[0]!;
    if (isAutoResponderMessage(first)) {
      if (first.source !== HelpdeskMessageSource.AUTO_RESPONDER) {
        arRowsToPromote.push(first.id);
      }
      const hasLaterInbound = messages.some(
        (m, i) =>
          i > 0 &&
          m.direction === HelpdeskMessageDirection.INBOUND &&
          m.sentAt.getTime() > first.sentAt.getTime(),
      );
      if (hasLaterInbound) archiveAction = "unarchive";
    }
  } else {
    // Tickets with multiple messages where the FIRST is an AR but it's
    // not currently archived: still promote the source so the AR row is
    // labelled correctly in ThreadView, but don't change archive state.
    const first = messages[0]!;
    if (
      isAutoResponderMessage(first) &&
      first.source !== HelpdeskMessageSource.AUTO_RESPONDER
    ) {
      arRowsToPromote.push(first.id);
    }
  }

  // ── Rule 4 — From eBay un-archive ─────────────────────────────────────
  // If the new classifier says this is a SYSTEM ticket but it's still
  // sitting in Archived (because the OLD "From eBay Messages" filter
  // routed it there), un-archive so it shows in the new From eBay
  // sub-folder. We override the AR-only sweep above only if both fired —
  // SYSTEM tickets should generally not be auto-archived.
  if (nextType === HelpdeskTicketType.SYSTEM && t.isArchived) {
    archiveAction = "unarchive";
  }

  // Decide what we'd actually write.
  const update: Prisma.HelpdeskTicketUpdateInput = {};
  let writes = false;

  if (
    nextType &&
    !t.typeOverridden &&
    (t.type !== nextType || t.systemMessageType !== (nextSystemType ?? null))
  ) {
    update.type = nextType;
    if (nextType === HelpdeskTicketType.SYSTEM) {
      update.systemMessageType = nextSystemType;
    }
    writes = true;
    if (nextType === HelpdeskTicketType.SYSTEM) c.systemTagged++;
    if (nextType === HelpdeskTicketType.CANCELLATION) c.cancellationTagged++;
  }

  if (archiveAction === "archive") {
    update.isArchived = true;
    update.archivedAt = new Date();
    update.status = HelpdeskTicketStatus.RESOLVED;
    writes = true;
    c.arOnlyArchived++;
  } else if (archiveAction === "unarchive") {
    update.isArchived = false;
    update.archivedAt = null;
    // Re-derive a sensible open status so the ticket lands in TO_DO if
    // there's an unanswered buyer message; otherwise RESOLVED stays.
    const hasInbound = inbound.length > 0;
    const lastIsInbound =
      messages[messages.length - 1]?.direction ===
      HelpdeskMessageDirection.INBOUND;
    if (hasInbound && lastIsInbound) {
      update.status = HelpdeskTicketStatus.TO_DO;
    }
    writes = true;
    if (nextType === HelpdeskTicketType.SYSTEM) c.fromEbayUnarchived++;
    else c.arOnlyUnarchived++;
  }

  if (!writes && !isCancellation && arRowsToPromote.length === 0) return;

  if (!APPLY) {
    if (writes) {
      console.log(
        `[retro][dry] ticket=${t.id} → ${JSON.stringify({
          type: update.type,
          sysType: update.systemMessageType,
          isArchived: update.isArchived,
          status: update.status,
        })}`,
      );
    }
    if (isCancellation) {
      console.log(`[retro][dry] ticket=${t.id} → attach cancellation tag`);
    }
    if (arRowsToPromote.length > 0) {
      c.arSourcePromoted += arRowsToPromote.length;
      console.log(
        `[retro][dry] ticket=${t.id} → promote ${arRowsToPromote.length} msg(s) source → AUTO_RESPONDER`,
      );
    }
    return;
  }

  // Live write — wrap in a transaction so the type flip + tag attach +
  // AR promotion are atomic per ticket. A bad row aborts only its own
  // work.
  await db.$transaction(async (tx) => {
    if (writes) {
      await tx.helpdeskTicket.update({
        where: { id: t.id },
        data: update,
      });
    }
    if (isCancellation && cancellationTagId) {
      const result = await tx.helpdeskTicketTag.createMany({
        data: [{ ticketId: t.id, tagId: cancellationTagId }],
        skipDuplicates: true,
      });
      if (result.count > 0) c.cancellationTagAttached++;
    }
    if (arRowsToPromote.length > 0) {
      const promoted = await tx.helpdeskMessage.updateMany({
        where: { id: { in: arRowsToPromote } },
        data: { source: HelpdeskMessageSource.AUTO_RESPONDER },
      });
      c.arSourcePromoted += promoted.count;
    }
  });
}

main().catch((err) => {
  console.error("[retro] fatal", err);
  process.exit(1);
});
