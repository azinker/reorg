// One-off: list delivered, not-yet-refunded returns so we can inspect whether
// eBay's amountEditable / overwritableBySeller flags are reliable while a return
// is still ACTIONABLE (before any refund is issued). Read-only. PROD (little-fire).
//
//   pwsh scripts/run-with-prod.ps1 -Script scripts/_list-actionable-returns.ts

import { db } from "@/lib/db";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[list] connected to ${host}`);

  const rows = await db.helpdeskReturnCase.findMany({
    where: {
      refundIsActual: false,
      returnState: { in: ["ITEM_DELIVERED", "ITEM_SHIPPED"] },
    },
    select: {
      returnId: true,
      ebayOrderNumber: true,
      returnState: true,
      reason: true,
      reasonType: true,
      sellerRefundValue: true,
      sku: true,
    },
    orderBy: { lastSyncedAt: "desc" },
    take: 20,
  });
  console.log(`[list] ${rows.length} actionable (unrefunded) returns:`);
  for (const r of rows) {
    console.log(
      `${r.returnId}  ${r.ebayOrderNumber ?? "-"}  ${r.returnState}  ${r.reasonType}/${r.reason}  $${r.sellerRefundValue ?? "?"}  ${r.sku ?? "-"}`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
