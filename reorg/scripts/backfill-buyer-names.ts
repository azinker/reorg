/**
 * One-shot backfill: populate `HelpdeskTicket.buyerName` with the buyer's
 * real first/last name where we can derive one.
 *
 * Why
 * ───
 * `resolveBuyer` historically set `buyerName = buyerUserId` (the eBay
 * username) for every ticket whose only buyer signal came from the message
 * envelope. The Customer column in the inbox then ended up showing the
 * username — exactly the same thing as the eBay Username column, and never
 * the actual person's name.
 *
 * The Auto Responder *does* know each buyer's real first/last name (it
 * pulls it from `Buyer.UserFirstName`/`Buyer.UserLastName` in `GetOrders`)
 * and renders it as the opening greeting of every AR body:
 *
 *     "Jonathan Towers,<br /><br />🚨🚨 Great News! …"
 *
 * That greeting is preserved both in the rendered `HelpdeskMessage.bodyText`
 * for AR sub-messages AND in `AutoResponderSendLog.renderedBody`. This
 * backfill scans both sources for every ticket whose `buyerName` is null
 * or equal to its `buyerUserId`, and writes the extracted name back.
 *
 * Safety
 * ──────
 * - Read-only by default. Pass `--apply` to actually write.
 * - Never overwrites a `buyerName` that already differs from `buyerUserId`
 *   (i.e. a name we trust has been set by a previous run or by the live
 *   sync code).
 * - Never sets `buyerName` to the username (skips matches that don't add
 *   information).
 */
import { db } from "@/lib/db";
import { extractBuyerNameFromAutoResponderBody } from "@/lib/helpdesk/buyer-resolve";
import { HelpdeskMessageSource } from "@prisma/client";

const APPLY = process.argv.includes("--apply");

interface Stats {
  scanned: number;
  fromMessage: number;
  fromSendLog: number;
  unchanged: number;
  skipped: number;
}

async function deriveName(args: {
  ticketId: string;
  integrationId: string;
  ebayOrderNumber: string | null;
  buyerUserId: string | null;
}): Promise<string | null> {
  // 1) Look at AR sub-messages on this ticket — these have the greeting
  //    in their body verbatim.
  const arMessages = await db.helpdeskMessage.findMany({
    where: {
      ticketId: args.ticketId,
      source: HelpdeskMessageSource.AUTO_RESPONDER,
      deletedAt: null,
    },
    orderBy: { sentAt: "asc" },
    select: { bodyText: true },
  });
  for (const m of arMessages) {
    const name = extractBuyerNameFromAutoResponderBody(m.bodyText);
    if (
      name &&
      name.toLowerCase() !== (args.buyerUserId ?? "").toLowerCase()
    ) {
      return name;
    }
  }

  // 2) Fall back to AutoResponderSendLog.renderedBody for the same order.
  //    This catches tickets whose AR sub-message wasn't ingested as
  //    source=AUTO_RESPONDER (eg. older rows from before the digest
  //    backfill ran) but where the AR DID send something we logged.
  if (args.ebayOrderNumber) {
    const logs = await db.autoResponderSendLog.findMany({
      where: {
        integrationId: args.integrationId,
        orderNumber: args.ebayOrderNumber,
        eventType: "SENT",
        renderedBody: { not: null },
      },
      select: { renderedBody: true },
    });
    for (const l of logs) {
      const name = extractBuyerNameFromAutoResponderBody(l.renderedBody);
      if (
        name &&
        name.toLowerCase() !== (args.buyerUserId ?? "").toLowerCase()
      ) {
        return name;
      }
    }
  }

  return null;
}

async function main() {
  const mode = APPLY ? "APPLY" : "DRY-RUN";
  console.log(`[backfill-buyer-names] starting (${mode})`);

  // Candidate tickets: buyerName is null OR equal to buyerUserId.
  // We use raw SQL for the equality match because Prisma doesn't support
  // column-to-column comparisons in a typed where clause.
  const candidates = await db.$queryRaw<
    Array<{
      id: string;
      integrationId: string;
      ebayOrderNumber: string | null;
      buyerUserId: string | null;
      buyerName: string | null;
    }>
  >`
    SELECT id, "integrationId", "ebayOrderNumber", "buyerUserId", "buyerName"
    FROM helpdesk_tickets
    WHERE "buyerName" IS NULL
       OR LOWER("buyerName") = LOWER("buyerUserId")
  `;

  console.log(`  candidates: ${candidates.length}`);

  const stats: Stats = {
    scanned: 0,
    fromMessage: 0,
    fromSendLog: 0,
    unchanged: 0,
    skipped: 0,
  };

  let i = 0;
  for (const t of candidates) {
    i++;
    stats.scanned++;
    if (i % 200 === 0) {
      console.log(`  ... ${i}/${candidates.length}`);
    }

    const name = await deriveName({
      ticketId: t.id,
      integrationId: t.integrationId,
      ebayOrderNumber: t.ebayOrderNumber,
      buyerUserId: t.buyerUserId,
    });
    if (!name) {
      stats.unchanged++;
      continue;
    }

    // Don't write if the value would be a no-op (case-insensitive).
    if ((t.buyerName ?? "").toLowerCase() === name.toLowerCase()) {
      stats.skipped++;
      continue;
    }

    if (APPLY) {
      try {
        await db.helpdeskTicket.update({
          where: { id: t.id },
          data: { buyerName: name },
        });
      } catch (err) {
        console.error(`  failed to update ${t.id}:`, err);
        continue;
      }
    }
    // We treat both AR-message and send-log derivations as "fromMessage"
    // for the dry-run summary; the rate limit on the diagnostic granularity
    // isn't worth a second DB call.
    stats.fromMessage++;
  }

  console.log("\n[backfill-buyer-names] done");
  console.log(`  scanned:     ${stats.scanned}`);
  console.log(`  updated:     ${stats.fromMessage}`);
  console.log(`  no name found: ${stats.unchanged}`);
  console.log(`  no-op (already same): ${stats.skipped}`);
  if (!APPLY) {
    console.log("\n  (dry-run — pass --apply to actually update the database)");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
