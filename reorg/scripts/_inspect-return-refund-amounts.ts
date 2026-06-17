// One-off: dump the live eBay return detail refund/estimate fields so we can see
// what eBay considers the max refundable (PURCHASE_PRICE vs total) for a return.
// Read-only. Run against PROD (little-fire).
//
//   pwsh scripts/run-with-prod.ps1 -Script scripts/_inspect-return-refund-amounts.ts -Args "<returnId>"

import { db } from "@/lib/db";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import { getReturnDetail } from "@/lib/services/helpdesk-ebay-returns-client";

const RETURN_ID = process.argv[2] ?? "5320155729";

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === "object") {
    for (const k of keys) {
      const v = (obj as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[inspect] connected to ${host}`);

  const row = await db.helpdeskReturnCase.findFirst({ where: { returnId: RETURN_ID } });
  if (!row) {
    console.error(`[inspect] no HelpdeskReturnCase for ${RETURN_ID}`);
    return;
  }
  console.log("\n=== PERSISTED REFUND FIELDS ===");
  console.log({
    returnState: row.returnState,
    returnQuantity: row.returnQuantity,
    sellerRefundValue: row.sellerRefundValue,
    sellerRefundCurrency: row.sellerRefundCurrency,
    buyerRefundValue: row.buyerRefundValue,
    refundIsActual: row.refundIsActual,
  });

  const integration = await db.integration.findUnique({ where: { id: row.integrationId } });
  if (!integration) return;
  const config = buildEbayConfig(integration);

  const res = await getReturnDetail({
    integrationId: integration.id,
    config,
    returnId: RETURN_ID,
    fieldgroups: "FULL",
  });
  if (!res.ok) {
    console.log("error:", res.errorMessage, res.errors);
    return;
  }
  const body = res.body as Record<string, unknown>;
  const c = (body.detail ?? body.summary ?? body) as Record<string, unknown>;

  console.log("\n=== eBay refund / estimate containers ===");
  console.log("detail keys:", Object.keys(c));
  console.log("sellerTotalRefund:", JSON.stringify(c.sellerTotalRefund ?? null, null, 2));
  console.log("buyerTotalRefund:", JSON.stringify(c.buyerTotalRefund ?? null, null, 2));
  console.log("refundInfo:", JSON.stringify(c.refundInfo ?? null, null, 2));
  console.log("estimatedRefundDetail:", JSON.stringify(c.estimatedRefundDetail ?? null, null, 2));
  console.log("returnTotal:", JSON.stringify(c.returnTotal ?? null, null, 2));
  const detailLevel = c.detail as Record<string, unknown> | undefined;
  if (detailLevel) {
    console.log("\n=== nested detail.* refund fields ===");
    console.log(JSON.stringify(pick(detailLevel, [
      "sellerTotalRefund", "buyerTotalRefund", "refundInfo", "estimatedRefundDetail", "returnTotal",
    ]), null, 2));
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
