// One-off: dump the live eBay Get Return payload (SUMMARY + FULL) for a single
// return so we can see the authoritative reason / reasonType / available
// options vs what we persisted. Read-only. Run against PROD (little-fire).
//
//   pwsh scripts/run-with-prod.ps1 -Script scripts/_inspect-return-5322195906.ts

import { db } from "@/lib/db";
import { buildEbayConfig } from "@/lib/services/helpdesk-ebay";
import { getReturnDetail } from "@/lib/services/helpdesk-ebay-returns-client";

const RETURN_ID = process.argv[2] ?? "5322195906";

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "<unknown>";
  console.log(`[inspect] connected to ${host}`);

  const row = await db.helpdeskReturnCase.findFirst({ where: { returnId: RETURN_ID } });
  if (!row) {
    console.error(`[inspect] no HelpdeskReturnCase for ${RETURN_ID}`);
    return;
  }
  console.log("\n=== PERSISTED ROW ===");
  console.log({
    returnId: row.returnId,
    platform: row.platform,
    reason: row.reason,
    reasonType: row.reasonType,
    returnState: row.returnState,
    returnStatus: row.returnStatus,
    sellerActionDue: row.sellerActionDue,
    itemTitle: row.itemTitle,
    sellerAvailableOptions: row.sellerAvailableOptions,
  });

  const integration = await db.integration.findUnique({ where: { id: row.integrationId } });
  if (!integration) {
    console.error("[inspect] integration not found");
    return;
  }
  const config = buildEbayConfig(integration);

  for (const fg of ["SUMMARY", "FULL"] as const) {
    const res = await getReturnDetail({
      integrationId: integration.id,
      config,
      returnId: RETURN_ID,
      fieldgroups: fg,
    });
    console.log(`\n=== LIVE Get Return (fieldgroups=${fg}) ok=${res.ok} status=${res.status} ===`);
    if (!res.ok) {
      console.log("error:", res.errorMessage, res.errors);
      continue;
    }
    const body = res.body as Record<string, unknown>;
    const container = (body.summary ?? body.detail ?? body) as Record<string, unknown>;
    const creationInfo = container.creationInfo as Record<string, unknown> | undefined;
    console.log({
      state: container.state,
      status: container.status,
      currentType: container.currentType,
      reason: creationInfo?.reason,
      reasonType: creationInfo?.reasonType,
      sellerAvailableOptions: container.sellerAvailableOptions,
      sellerResponseDue: container.sellerResponseDue,
    });
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
