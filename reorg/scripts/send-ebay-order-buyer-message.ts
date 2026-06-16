/**
 * Resolve an eBay extended order ID against TPP_EBAY and TT_EBAY, then send
 * AddMemberMessageAAQToPartner using the auto-responder Trading send/fallback helpers
 * (line items × QuestionType CustomizedSubject, then General) — same path as the worker.
 *
 * Dry-run (default): prints which store owns the order + buyer/item IDs.
 * Live: pass --send (requires correct DATABASE_URL + OAuth for that environment).
 *
 * From reorg/:
 *   npx tsx -r dotenv/config scripts/send-ebay-order-buyer-message.ts --order=16-14619-21317
 *   $env:DOTENV_CONFIG_PATH=".env.prod"; npx tsx -r dotenv/config scripts/send-ebay-order-buyer-message.ts --order=... --send
 */

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import {
  buildEbayConfig,
  ebayOrderLineAttempts,
  fetchEbayOrderDetails,
  itemIdFromOutboundWinningStrategy,
  sendEbayBuyerMessageWithFallback,
  type EbayOrderDetails,
} from "@/lib/services/auto-responder-ebay";

const STORES: Platform[] = [Platform.TPP_EBAY, Platform.TT_EBAY];

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const hit = process.argv.find((a) => a === name || a.startsWith(prefix));
  if (!hit) return undefined;
  if (hit === name) return undefined;
  return hit.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const DEFAULT_SUBJECT = "Update regarding your order and shipment";

const DEFAULT_BODY = `Thank you for your order. Due to a glitch recently on eBay and while reviewing your shipment to ensure it arrives on time, I identified a potential issue with the package. To avoid any delay, I immediately sent out a replacement package using expedited Priority Service so your item can arrive as quickly as possible. This package will leave first thing this Monday (5/18) which is the next possible day USPS can take the package.

Because this was done as a precautionary measure, there is a possibility that the original package may still arrive as well. If you happen to receive a second package, it would truly mean a lot to me if you could reach out so I can provide you with a prepaid return label to return the 2nd duplicate package.

I sincerely apologize for the inconvenience, and if you experience any other issues or have any questions, please do not hesitate to message us. Thank you again for your patience and understanding.`;

async function main(): Promise<void> {
  const orderId =
    argValue("--order") ??
    process.argv
      .slice(2)
      .find((a) => !a.startsWith("--") && /^\d{2}-\d{5}-\d{5}$/.test(a));
  if (!orderId) {
    console.error("Missing --order=##-#####-#####");
    process.exit(1);
  }

  const liveSend = hasFlag("--send");
  const subject = argValue("--subject") ?? DEFAULT_SUBJECT;
  const body = argValue("--body") ? String(argValue("--body")).replace(/\\n/g, "\n") : DEFAULT_BODY;

  console.log(`Order ${orderId} — mode: ${liveSend ? "LIVE SEND" : "dry run"}`);
  console.log(`Subject: ${subject}`);

  let resolved:
    | { store: Platform; integrationId: string; ebayDetail: EbayOrderDetails }
    | undefined;

  for (const platform of STORES) {
    const integration = await db.integration.findUnique({ where: { platform } });
    if (!integration) {
      console.log(`Skip ${platform}: no integration row`);
      continue;
    }
    const config = buildEbayConfig(integration);
    const map = await fetchEbayOrderDetails(integration.id, config, [orderId]);
    const d = map.get(orderId);
    if (!d?.buyerUserId || !d.itemId) {
      console.log(`${platform}: not found or missing buyer/item`);
      continue;
    }
    resolved = {
      store: platform,
      integrationId: integration.id,
      ebayDetail: d,
    };
    console.log(`Found on ${platform}: buyer=${d.buyerUserId} itemId=${d.itemId}`);
    console.log(`  Line title: ${d.itemTitle}`);
    if (d.lineItems && d.lineItems.length > 1) {
      console.log(`  Line items (${d.lineItems.length}): ${d.lineItems.map((l) => l.itemId).join(", ")}`);
    }
    break;
  }

  if (!resolved) {
    console.error("Order not found on TPP_EBAY or TT_EBAY (check order id and OAuth / env).");
    process.exit(2);
  }

  if (!liveSend) {
    console.log("\nDry run only. Re-run with --send to dispatch AddMemberMessageAAQToPartner.");
    process.exit(0);
  }

  const integrationRow = await db.integration.findUniqueOrThrow({ where: { id: resolved.integrationId } });
  const cfg = buildEbayConfig(integrationRow);
  const lineAttempts = ebayOrderLineAttempts(null, resolved.ebayDetail);
  const result = await sendEbayBuyerMessageWithFallback(
    resolved.integrationId,
    cfg,
    resolved.ebayDetail.buyerUserId,
    subject,
    body,
    lineAttempts,
  );

  if (!result.success) {
    console.error("eBay send failed:", result.error);
    if (result.attempted?.length) console.error(`  Tried strategies: ${result.attempted.join("; ")}`);
    process.exit(3);
  }

  const via = result.winningStrategy ?? "?";
  const sentAsItem = itemIdFromOutboundWinningStrategy(result.winningStrategy) ?? resolved.ebayDetail.itemId;
  console.log(`Message sent (${via}), item ${sentAsItem}.`);
}

main().finally(() =>
  db.$disconnect().catch(() => {
    /* ignore */
  }),
);
