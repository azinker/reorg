/**
 * Repair tickets whose buyerUserId / buyerName were stored as the eBay
 * system value ("eBay") or as our own seller user id (e.g. "theperfectpart"
 * / "telitetech") because the old sync code naively trusted whatever the
 * GetMyMessages payload had in `sender`.
 *
 * Strategy
 * ────────
 * For each TPP_EBAY / TT_EBAY ticket whose buyerUserId is bad:
 *
 *   1. If the ticket has an `ebayOrderNumber`, look up the matching
 *      MarketplaceSaleOrder and copy `buyerIdentifier` / `buyerDisplayLabel` /
 *      `buyerEmail` onto the ticket. Highest-confidence path.
 *
 *   2. Else, walk the ticket's messages and run the same body-text extractor
 *      (`extractBuyerFromBody`) we use at sync time. The auto-responder
 *      messages always start with "<First Name> <Last Name>," and many
 *      eBay system messages start with "Hi <handle>," — both are caught.
 *
 *   3. Else, leave the ticket alone but null out the bad value so the
 *      Customer column shows "Unknown buyer" instead of the seller's
 *      handle. The next inbound message will populate it via sync.
 *
 * Run dry-run first:
 *   powershell scripts/run-with-prod.ps1 -Script scripts/repair-ticket-buyers.ts
 *
 * Apply for real:
 *   powershell scripts/run-with-prod.ps1 -Script scripts/repair-ticket-buyers.ts -- --apply
 */
import { db } from "@/lib/db";
import { Platform, type HelpdeskTicket } from "@prisma/client";
import {
  getSellerUserId,
  isSystemOrSellerSender,
  extractBuyerFromBody,
  resolveBuyerFromSaleOrder,
} from "@/lib/helpdesk/buyer-resolve";

const APPLY = process.argv.includes("--apply");

type SellerMap = Map<string, string | null>; // integrationId -> sellerUserId (lowercase)

async function buildSellerMap(): Promise<SellerMap> {
  const integrations = await db.integration.findMany({
    where: { platform: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] } },
  });
  const map: SellerMap = new Map();
  for (const i of integrations) {
    map.set(i.id, getSellerUserId(i)?.toLowerCase() ?? null);
  }
  return map;
}

async function tryBodyExtraction(ticketId: string): Promise<string | null> {
  // Prefer the FIRST inbound message (least likely to have been a quoted
  // reply chain), then fall back to the first auto-responder message which
  // always contains "<FirstName LastName>," at the top.
  const messages = await db.helpdeskMessage.findMany({
    where: { ticketId },
    orderBy: { sentAt: "asc" },
    select: { bodyText: true, source: true, direction: true },
    take: 6,
  });
  for (const m of messages) {
    const candidate = extractBuyerFromBody(m.bodyText);
    if (candidate) return candidate;
  }
  return null;
}

interface RepairCounts {
  scanned: number;
  fixedFromOrder: number;
  fixedFromBody: number;
  cleared: number;
  leftAlone: number;
}

async function repairOne(
  ticket: Pick<HelpdeskTicket, "id" | "buyerUserId" | "buyerName" | "ebayOrderNumber" | "channel" | "integrationId">,
  sellerMap: SellerMap,
): Promise<keyof RepairCounts> {
  const seller = sellerMap.get(ticket.integrationId);
  const existing = ticket.buyerUserId?.trim().toLowerCase() ?? null;
  const isBad =
    !existing ||
    existing === "ebay" ||
    (seller !== null && existing === seller);

  if (!isBad) return "leftAlone";

  // 1) Sale-order lookup.
  if (ticket.ebayOrderNumber) {
    const fromOrder = await resolveBuyerFromSaleOrder(
      ticket.channel,
      ticket.ebayOrderNumber,
    );
    if (fromOrder?.userId && !isSystemOrSellerSender(fromOrder.userId, seller ?? null)) {
      if (APPLY) {
        await db.helpdeskTicket.update({
          where: { id: ticket.id },
          data: {
            buyerUserId: fromOrder.userId,
            buyerName: fromOrder.label ?? fromOrder.userId,
            ...(fromOrder.email ? { buyerEmail: fromOrder.email } : {}),
          },
        });
      }
      return "fixedFromOrder";
    }
  }

  // 2) Body-text extraction.
  const fromBody = await tryBodyExtraction(ticket.id);
  if (fromBody && !isSystemOrSellerSender(fromBody, seller ?? null)) {
    if (APPLY) {
      await db.helpdeskTicket.update({
        where: { id: ticket.id },
        data: {
          buyerUserId: fromBody,
          buyerName: fromBody,
        },
      });
    }
    return "fixedFromBody";
  }

  // 3) Clear so Customer column shows "Unknown buyer" instead of our name.
  if (APPLY) {
    await db.helpdeskTicket.update({
      where: { id: ticket.id },
      data: {
        buyerUserId: null,
        buyerName: null,
      },
    });
  }
  return "cleared";
}

async function main() {
  console.log(
    APPLY
      ? "*** APPLY MODE — writing changes to the database ***"
      : "Dry run (no writes). Pass --apply to commit.",
  );
  const sellerMap = await buildSellerMap();
  console.log("Seller user ids by integration:", [...sellerMap.entries()]);

  // Pull every ticket whose buyerUserId is null, "eBay", or matches the
  // integration's seller user id. We can't express the seller-equality
  // half in a single SQL where without coupling to the Integration row,
  // so we over-fetch (just add buyerUserId IN [null, "eBay", seller1, seller2])
  // and then filter precisely in JS. Cheap because eBay system noise only
  // surfaces a few seller-style strings.
  const sellerVals = [...new Set([...sellerMap.values()].filter((v): v is string => !!v))];
  const where = {
    channel: { in: [Platform.TPP_EBAY, Platform.TT_EBAY] },
    OR: [
      { buyerUserId: null },
      { buyerUserId: { equals: "eBay", mode: "insensitive" as const } },
      ...sellerVals.map((s) => ({
        buyerUserId: { equals: s, mode: "insensitive" as const },
      })),
    ],
  };

  const total = await db.helpdeskTicket.count({ where });
  console.log(`Tickets to scan: ${total}`);

  const counts: RepairCounts = {
    scanned: 0,
    fixedFromOrder: 0,
    fixedFromBody: 0,
    cleared: 0,
    leftAlone: 0,
  };

  const PAGE = 200;
  for (let offset = 0; offset < total; offset += PAGE) {
    const batch = await db.helpdeskTicket.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: offset,
      take: PAGE,
      select: {
        id: true,
        buyerUserId: true,
        buyerName: true,
        ebayOrderNumber: true,
        channel: true,
        integrationId: true,
      },
    });
    for (const t of batch) {
      counts.scanned += 1;
      const action = await repairOne(t, sellerMap);
      counts[action] += 1;
    }
    console.log(
      `  progress: ${counts.scanned}/${total} ` +
        `fromOrder=${counts.fixedFromOrder} fromBody=${counts.fixedFromBody} cleared=${counts.cleared} leftAlone=${counts.leftAlone}`,
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
