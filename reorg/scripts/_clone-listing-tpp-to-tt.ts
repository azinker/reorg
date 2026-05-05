/**
 * CLI wrapper for listing clone (TPP eBay → TT eBay default).
 *
 * Prefer the in-app Listing Clone page (`/listing-clone`) for normal use.
 *
 * Usage:
 *   cd reorg && npx tsx scripts/_clone-listing-tpp-to-tt.ts [SOURCE_ITEM_ID]
 *
 * Dry-run (default): VerifyAddFixedPriceItem only.
 * Live:
 *   CLONE_LISTING_CONFIRM_LIVE=true npx tsx scripts/_clone-listing-tpp-to-tt.ts [SOURCE_ITEM_ID]
 *   or: --live
 *
 * Options mirror {@link listing-clone-ebay.ts}: env EBAY_CLONE_TT_* policies,
 * EBAY_CLONE_ITEM_TYPE, CLONE_SKIP_PICTURE_UPLOAD, etc.
 */

import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { checkWriteSafety } from "@/lib/safety";
import { isLivePushEnabled } from "@/lib/automation-settings";
import {
  runListingCloneEbayExecute,
  runListingCloneEbayPreview,
} from "@/lib/services/listing-clone-ebay";

const DEFAULT_SOURCE_ITEM_ID = "204226527330";

const LIVE =
  process.argv.includes("--live") ||
  process.env.CLONE_LISTING_CONFIRM_LIVE === "true";

const SKIP_PIC_UPLOAD = process.env.CLONE_SKIP_PICTURE_UPLOAD === "true";

async function main() {
  const sourceItemId =
    process.argv.find((a) => /^\d{10,}$/.test(a)) ?? DEFAULT_SOURCE_ITEM_ID;

  console.log(`[clone] SOURCE_ITEM_ID=${sourceItemId}`);
  console.log(`[clone] LIVE=${LIVE} SKIP_PIC_UPLOAD=${SKIP_PIC_UPLOAD}`);

  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "";
  console.log(`[clone] DATABASE_URL host=${host || "(unset)"}`);
  if (host && !host.includes("little-fire")) {
    console.warn(
      `[clone] WARNING: prod listings usually use DB host containing 'little-fire'.`,
    );
  }

  const options = {
    skipPictureUpload: SKIP_PIC_UPLOAD,
    itemTypeAspect: process.env.EBAY_CLONE_ITEM_TYPE?.trim(),
    shippingPolicyId: process.env.EBAY_CLONE_TT_SHIPPING_POLICY_ID?.trim(),
    returnPolicyId: process.env.EBAY_CLONE_TT_RETURN_POLICY_ID?.trim(),
    paymentPolicyId: process.env.EBAY_CLONE_TT_PAYMENT_POLICY_ID?.trim(),
    policySourceItemId: process.env.EBAY_CLONE_TT_POLICY_SOURCE_ITEM_ID?.trim(),
  };

  const sourcePlatform = Platform.TPP_EBAY;
  const targetPlatform = Platform.TT_EBAY;

  if (LIVE) {
    const enabled = await isLivePushEnabled();
    if (!enabled) {
      console.error(
        "[clone] Live push disabled in app settings (same gate as Catalog). Enable live_push_enabled or use preview-only.",
      );
      process.exit(1);
    }
    const safety = await checkWriteSafety(targetPlatform);
    if (!safety.allowed) {
      console.error("[clone] Write blocked:", safety.reason);
      process.exit(1);
    }
    const result = await runListingCloneEbayExecute(
      sourcePlatform,
      targetPlatform,
      sourceItemId,
      options,
    );
    console.log("[clone] Live listing created. ItemID=", result.newItemId);
  } else {
    const result = await runListingCloneEbayPreview(
      sourcePlatform,
      targetPlatform,
      sourceItemId,
      options,
    );
    console.log("[clone] Verify OK", result.ack, result.summary.title);
    console.log(
      `[clone] Dry-run complete. Publish via app /listing-clone or CLONE_LISTING_CONFIRM_LIVE=true`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
