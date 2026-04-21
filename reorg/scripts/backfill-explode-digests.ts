/**
 * Backfill: re-explode every existing HelpdeskMessage whose body still
 * contains an eBay digest (`<div id="UserInputtedText[N]">`) into one
 * row per logical sub-message.
 *
 * Why
 * ───
 * Pre-fix, the live sync stored each eBay GetMyMessages notification as
 * a single HelpdeskMessage even though the HTML body actually carried
 * the entire conversation history (one `<div id="UserInputtedText[N]">`
 * per turn). The agent only ever saw the digest envelope, so:
 *   - Auto Responder messages that used to ship were missing.
 *   - Buyer history older than 24h was effectively invisible.
 *   - Agent replies sent on eBay.com directly were lost.
 *
 * The new sync code (helpdesk-ebay-sync.ts) explodes every digest into
 * N rows on insert. This script applies the same transform to all rows
 * the *old* sync wrote, so historical tickets are also fully populated.
 *
 * Idempotency
 * ───────────
 * The parser produces stable `externalId`s of form `<digestId>:<n>`
 * (matching the `UserInputtedText` suffix). Re-running this script is
 * safe — Prisma's (ticketId, externalId) unique constraint dedupes.
 * Within a ticket we also dedupe by body-hash, so the same message
 * appearing in two different digests only generates one row.
 *
 * Usage
 * ─────
 *   # Dry run (no writes, just stats):
 *   powershell scripts/run-with-prod.ps1 -Script scripts/backfill-explode-digests.ts
 *
 *   # Apply for real:
 *   powershell scripts/run-with-prod.ps1 -Script scripts/backfill-explode-digests.ts -- --apply
 *
 *   # Limit to a single ticket while debugging:
 *   powershell scripts/run-with-prod.ps1 -Script scripts/backfill-explode-digests.ts -- --apply --ticket=<ticketId>
 */
import { db } from "@/lib/db";
import {
  HelpdeskMessageDirection,
  HelpdeskMessageSource,
  Platform,
  Prisma,
} from "@prisma/client";
import {
  parseEbayDigest,
  hashBodyForMatch,
} from "@/lib/helpdesk/ebay-digest-parser";

const APPLY = process.argv.includes("--apply");
const TICKET_FILTER = (() => {
  const arg = process.argv.find((a) => a.startsWith("--ticket="));
  return arg ? arg.slice("--ticket=".length) : null;
})();

interface Counts {
  ticketsScanned: number;
  digestsFound: number;
  subsParsed: number;
  subsInserted: number;
  subsSkippedDup: number;
  subsSkippedUnknown: number;
  errors: number;
}

const counts: Counts = {
  ticketsScanned: 0,
  digestsFound: 0,
  subsParsed: 0,
  subsInserted: 0,
  subsSkippedDup: 0,
  subsSkippedUnknown: 0,
  errors: 0,
};

async function processTicket(ticketId: string): Promise<void> {
  // Pull every message for this ticket once. We need:
  //   - the digest rows we'll explode (bodyText contains UserInputtedText)
  //   - all existing rows so we can dedupe by externalId / bodyHash
  const all = await db.helpdeskMessage.findMany({
    where: { ticketId },
    select: {
      id: true,
      externalId: true,
      ebayMessageId: true,
      bodyText: true,
      sentAt: true,
      direction: true,
    },
    orderBy: { sentAt: "asc" },
  });

  // Build dedupe sets for this ticket up-front. We'll add to them as we
  // insert sub-messages so subsequent digests in the same ticket dedupe
  // against earlier ones automatically.
  const existingExternalIds = new Set<string>();
  const existingHashes = new Set<string>();
  for (const m of all) {
    if (m.externalId) existingExternalIds.add(m.externalId);
    existingHashes.add(hashBodyForMatch(m.bodyText));
  }

  // Pull the parent ticket to get integrationId + orderNumber for AR
  // attribution. One query per ticket; the cost is amortized over N
  // sub-messages.
  const ticket = await db.helpdeskTicket.findUnique({
    where: { id: ticketId },
    select: { integrationId: true, ebayOrderNumber: true, buyerUserId: true, buyerName: true },
  });
  if (!ticket) return;

  // AR attribution: one query per ticket for all SENT log rows for this
  // order, hashed against the same normalizer the parser uses.
  const arHashes = new Set<string>();
  if (ticket.ebayOrderNumber) {
    const logs = await db.autoResponderSendLog.findMany({
      where: {
        integrationId: ticket.integrationId,
        orderNumber: ticket.ebayOrderNumber,
        eventType: "SENT",
        renderedBody: { not: null },
      },
      select: { renderedBody: true },
    });
    for (const log of logs) {
      if (log.renderedBody) arHashes.add(hashBodyForMatch(log.renderedBody));
    }
  }

  // Now iterate the digest envelopes and explode each.
  for (const digest of all) {
    if (!digest.bodyText) continue;
    if (!/<div\s+id="UserInputtedText\d*"/i.test(digest.bodyText)) continue;
    if (!digest.ebayMessageId) continue;

    counts.digestsFound += 1;

    const parsed = parseEbayDigest({
      bodyHtml: digest.bodyText,
      digestExternalId: digest.ebayMessageId,
    });
    if (!parsed.isDigest) continue;

    counts.subsParsed += parsed.subMessages.length;

    for (const sub of parsed.subMessages) {
      if (sub.direction === "unknown") {
        counts.subsSkippedUnknown += 1;
        continue;
      }
      if (existingExternalIds.has(sub.externalId)) {
        counts.subsSkippedDup += 1;
        continue;
      }
      if (existingHashes.has(sub.bodyHash)) {
        counts.subsSkippedDup += 1;
        continue;
      }

      const subDirection =
        sub.direction === "inbound"
          ? HelpdeskMessageDirection.INBOUND
          : HelpdeskMessageDirection.OUTBOUND;

      const subSource =
        subDirection === HelpdeskMessageDirection.OUTBOUND &&
        arHashes.has(sub.bodyHash)
          ? HelpdeskMessageSource.AUTO_RESPONDER
          : HelpdeskMessageSource.EBAY;

      // Approximate per-sub timestamps by offsetting from the digest
      // envelope's sentAt — older subs get earlier timestamps so the
      // ThreadView's chronological sort lines up correctly.
      const sentAt = new Date(
        digest.sentAt.getTime() -
          (parsed.subMessages.length - 1 - sub.index) * 1000,
      );

      if (!APPLY) {
        counts.subsInserted += 1;
        existingExternalIds.add(sub.externalId);
        existingHashes.add(sub.bodyHash);
        continue;
      }

      try {
        await db.helpdeskMessage.create({
          data: {
            ticketId,
            direction: subDirection,
            source: subSource,
            externalId: sub.externalId,
            ebayMessageId: digest.ebayMessageId,
            fromName:
              subDirection === HelpdeskMessageDirection.INBOUND
                ? ticket.buyerName ?? ticket.buyerUserId ?? "Buyer"
                : null,
            fromIdentifier:
              subDirection === HelpdeskMessageDirection.INBOUND
                ? ticket.buyerUserId
                : null,
            subject: null,
            bodyText: sub.bodyHtml,
            isHtml: true,
            rawMedia: [] as Prisma.InputJsonValue,
            rawData: {
              digestSource: digest.ebayMessageId,
              subIndex: sub.index,
              isLive: sub.isLive,
              backfilledFromDigest: true,
            } as Prisma.InputJsonValue,
            sentAt,
          },
        });
        counts.subsInserted += 1;
        existingExternalIds.add(sub.externalId);
        existingHashes.add(sub.bodyHash);
      } catch (err) {
        // Tolerate races and unique-constraint duplicates.
        if (
          err instanceof Error &&
          err.message.includes("Unique constraint failed")
        ) {
          counts.subsSkippedDup += 1;
        } else {
          counts.errors += 1;
          console.error(`[backfill-explode] insert failed for sub ${sub.externalId}`, err);
        }
      }
    }
  }
}

async function main(): Promise<void> {
  console.log(
    APPLY
      ? "*** APPLY MODE — writing exploded sub-messages to the DB ***"
      : "Dry run (no writes). Pass --apply to commit.",
  );
  if (TICKET_FILTER) {
    console.log(`Filter: ticketId=${TICKET_FILTER}`);
  }

  // Find every ticket that has at least one digest-shaped message. We
  // page through tickets (not messages) so the per-ticket dedupe sets
  // and AR-log queries amortize cleanly.
  const where = TICKET_FILTER
    ? { id: TICKET_FILTER }
    : {
        channel: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
        messages: {
          some: {
            // PostgreSQL: case-insensitive substring against the body
            bodyText: { contains: 'id="UserInputtedText' },
          },
        },
      };

  const total = await db.helpdeskTicket.count({ where });
  console.log(`Tickets with at least one digest message: ${total}`);

  const PAGE = 100;
  for (let offset = 0; offset < total; offset += PAGE) {
    const batch = await db.helpdeskTicket.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: offset,
      take: PAGE,
      select: { id: true },
    });
    for (const t of batch) {
      counts.ticketsScanned += 1;
      try {
        await processTicket(t.id);
      } catch (err) {
        counts.errors += 1;
        console.error(`[backfill-explode] ticket ${t.id} failed`, err);
      }
    }
    console.log(
      `  progress: ${counts.ticketsScanned}/${total} ` +
        `digests=${counts.digestsFound} subsParsed=${counts.subsParsed} ` +
        `inserted=${counts.subsInserted} skippedDup=${counts.subsSkippedDup} ` +
        `skippedUnknown=${counts.subsSkippedUnknown} errors=${counts.errors}`,
    );
  }

  console.log("\n=== Done ===");
  console.log(counts);
  if (!APPLY) {
    console.log("\n(dry run — no DB writes performed)");
  }
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
