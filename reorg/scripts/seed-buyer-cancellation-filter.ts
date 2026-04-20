/**
 * Seed (or refresh) the "Buyer Request Cancellation" tag and filter rule, then
 * run the filter retroactively over the existing inbox so any historical
 * cancellation requests get sorted into the new sidebar folder.
 *
 * Run with:
 *   npx tsx scripts/seed-buyer-cancellation-filter.ts
 *
 * Idempotent: if the tag or filter already exist (matched by name) they are
 * updated in place rather than duplicated.
 *
 * What it does:
 *   1. Upserts a `HelpdeskTag` named "Buyer Request Cancellation".
 *   2. Upserts a `HelpdeskFilter` whose conditions match `subject contains
 *      "A buyer wants to cancel an order"` (case-insensitive) and whose
 *      action adds the tag.
 *   3. Calls `runFilterOverInbox` so already-synced tickets get tagged.
 *
 * SAFETY:
 *   - Touches local DB only. Does not call eBay.
 *   - The filter action only adds a tag; it never archives, resolves, or
 *     mutates ticket status, so this can be re-run safely.
 */

import { db } from "../src/lib/db";
import { BUYER_CANCELLATION_TAG_NAME } from "../src/lib/helpdesk/folders";
import {
  runFilterOverInbox,
  type FilterAction,
  type FilterConditions,
} from "../src/lib/helpdesk/filters";

const FILTER_NAME = "Buyer Request Cancellation";
const FILTER_DESCRIPTION =
  "Auto-tags tickets whose subject is the eBay 'A buyer wants to cancel an order' notification so they appear in the Cancel Requests folder.";
const SUBJECT_NEEDLE = "A buyer wants to cancel an order";

async function main(): Promise<void> {
  console.log("[seed-buyer-cancellation-filter] starting");

  // 1) Tag --------------------------------------------------------------------
  const tag = await db.helpdeskTag.upsert({
    where: { name: BUYER_CANCELLATION_TAG_NAME },
    update: {
      description:
        "Buyer asked to cancel the order. Routed by the matching filter rule.",
      color: "#ef4444",
    },
    create: {
      name: BUYER_CANCELLATION_TAG_NAME,
      description:
        "Buyer asked to cancel the order. Routed by the matching filter rule.",
      color: "#ef4444",
    },
  });
  console.log(`[seed-buyer-cancellation-filter] tag id=${tag.id}`);

  // 2) Filter -----------------------------------------------------------------
  const conditions: FilterConditions = {
    match: "ALL",
    rules: [
      {
        field: "subject",
        op: "contains",
        value: SUBJECT_NEEDLE,
        caseSensitive: false,
      },
    ],
  };
  const action: FilterAction = {
    type: "MOVE_TO_FOLDER",
    // `inbox` is a no-op against ticket status/flags; the real work happens via
    // `addTagIds` so the ticket stays in its normal status (NEW/TO_DO/WAITING)
    // AND picks up the cancellation tag for the sidebar query.
    folder: "inbox",
    addTagIds: [tag.id],
  };

  const existing = await db.helpdeskFilter.findFirst({
    where: { name: FILTER_NAME },
    select: { id: true },
  });

  const filter = existing
    ? await db.helpdeskFilter.update({
        where: { id: existing.id },
        data: {
          description: FILTER_DESCRIPTION,
          enabled: true,
          conditions: conditions as unknown as object,
          action: action as unknown as object,
        },
      })
    : await db.helpdeskFilter.create({
        data: {
          name: FILTER_NAME,
          description: FILTER_DESCRIPTION,
          enabled: true,
          isSystem: false,
          sortOrder: 100,
          conditions: conditions as unknown as object,
          action: action as unknown as object,
        },
      });
  console.log(
    `[seed-buyer-cancellation-filter] filter id=${filter.id} (${existing ? "updated" : "created"})`,
  );

  // 3) Run it retroactively ---------------------------------------------------
  const result = await runFilterOverInbox(filter.id, null);
  console.log("[seed-buyer-cancellation-filter] run result:", {
    scanned: result.scanned,
    matched: result.matched,
    applied: result.applied,
    examples: result.examples,
  });

  console.log("[seed-buyer-cancellation-filter] done");
}

main()
  .catch((err) => {
    console.error("[seed-buyer-cancellation-filter] FAILED", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
