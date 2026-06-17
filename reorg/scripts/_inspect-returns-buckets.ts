// One-off diagnostic: probe the live eBay Post-Order return/search per
// ReturnCountFilterEnum bucket (with and without a creation-date window) and
// dump seller options + tracking for a couple of specific returns. Read-only.
// Run against PROD (little-fire):
//
//   pwsh scripts/run-with-prod.ps1 -Script scripts/_inspect-returns-buckets.ts
//
// Goal: figure out why "Returns shipped / delivered / closed" come back empty
// in our list and what sellerAvailableOptions eBay actually returns.

import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import {
  searchReturns,
  getReturnDetail,
  getReturnTracking,
} from "@/lib/services/helpdesk-ebay-returns-client";

const BUCKETS = [
  "ALL_OPEN",
  "RETURN_STARTED",
  "SELLER_ACTION_DUE",
  "ITEM_SHIPPED",
  "ITEM_DELIVERED",
  "CLOSED",
];

const DETAIL_RETURN_IDS = ["5321809401", "5322121499", "5322205203"];

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[inspect] connected to ${host}`);

  const integration = await db.integration.findFirst({
    where: { platform: Platform.TPP_EBAY },
  });
  if (!integration) {
    console.error("[inspect] no TPP_EBAY integration");
    return;
  }
  const config = buildEbayConfig(integration);

  const from90 = new Date(Date.now() - 90 * 86_400_000);
  const from540 = new Date(Date.now() - 540 * 86_400_000);
  const to = new Date();

  for (const bucket of BUCKETS) {
    for (const [label, fromDate] of [
      ["90d", from90],
      ["540d", from540],
    ] as const) {
      const r = await searchReturns({
        integrationId: integration.id,
        config,
        fromDate,
        toDate: to,
        returnState: bucket,
        offset: 0,
        limit: 100,
      });
      const body = r.result.body as Record<string, unknown> | null;
      console.log(
        `\n=== ${bucket} [${label} window] ok=${r.result.status} ` +
          `members=${r.members.length} total=${r.total} totalPages=${r.totalPages}`,
      );
      if (!r.result.ok) {
        console.log("   error:", r.result.errorMessage, r.result.errors);
      }
      console.log("   countSummary:", JSON.stringify(body?.countSummary));
      const first = r.members[0] as Record<string, unknown> | undefined;
      if (first) {
        console.log("   first:", {
          returnId: first.returnId,
          state: first.state,
          status: first.status,
        });
      }
    }
  }

  for (const rid of DETAIL_RETURN_IDS) {
    const res = await getReturnDetail({
      integrationId: integration.id,
      config,
      returnId: rid,
      fieldgroups: "SUMMARY",
    });
    console.log(`\n=== Get Return ${rid} ok=${res.ok} status=${res.status} ===`);
    if (!res.ok) {
      console.log("   error:", res.errorMessage, res.errors);
      continue;
    }
    const b = res.body as Record<string, unknown>;
    const c = (b.summary ?? b.detail ?? b) as Record<string, unknown>;
    console.log({
      state: c.state,
      status: c.status,
      currentType: c.currentType,
      sellerAvailableOptions: c.sellerAvailableOptions,
      buyerAvailableOptions: c.buyerAvailableOptions,
      sellerResponseDue: c.sellerResponseDue,
      buyerResponseDue: c.buyerResponseDue,
    });

    const shipInfo = (c.returnShipmentInfo ?? {}) as Record<string, unknown>;
    const st = (shipInfo.shipmentTracking ?? {}) as Record<string, unknown>;
    const carrierUsed = String(st.carrierUsed ?? st.carrierEnum ?? "");
    const trackingNumber = String(st.trackingNumber ?? "");
    if (carrierUsed && trackingNumber) {
      const trk = await getReturnTracking({
        integrationId: integration.id,
        config,
        returnId: rid,
        carrierUsed,
        trackingNumber,
      });
      console.log(`   tracking ok=${trk.ok} status=${trk.status}`);
      if (trk.ok) {
        console.log("   tracking body:", JSON.stringify(trk.body)?.slice(0, 1500));
      } else {
        console.log("   tracking error:", trk.errorMessage);
      }
    } else {
      console.log("   tracking: no carrier/tracking on detail yet");
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
