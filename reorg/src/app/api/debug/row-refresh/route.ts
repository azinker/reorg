import { NextResponse, type NextRequest } from "next/server";
import { Platform, type Integration } from "@prisma/client";
import { db } from "@/lib/db";
import { startIntegrationSync } from "@/lib/services/sync-control";
import { runBigCommerceWebhookReconcile } from "@/lib/services/bigcommerce-sync";
import { runShopifyWebhookReconcile } from "@/lib/services/shopify-sync";

export const maxDuration = 60;

type Step = { step: string; ok: boolean; ms: number; detail: unknown };

function normalizeRowId(rowId: string) {
  if (rowId.startsWith("child-")) {
    return { dbRowId: rowId.slice("child-".length), includeChildListings: false };
  }
  if (rowId.startsWith("variation-parent:")) {
    const familyKey = rowId.slice("variation-parent:".length);
    if (familyKey.startsWith("child-")) {
      const firstChildMasterRowId = familyKey.split("|")[0].slice("child-".length);
      return { dbRowId: firstChildMasterRowId, includeChildListings: true };
    }
    const titleSep = familyKey.indexOf("::");
    if (titleSep !== -1) return { dbRowId: familyKey, includeChildListings: true };
    return { dbRowId: familyKey, includeChildListings: true };
  }
  return { dbRowId: rowId, includeChildListings: true };
}

export async function GET(request: NextRequest) {
  const rowId = request.nextUrl.searchParams.get("rowId");
  if (!rowId) {
    return NextResponse.json({ error: "Missing ?rowId= query parameter" }, { status: 400 });
  }

  const steps: Step[] = [];
  const t = () => Date.now();

  // Step 1: Normalize rowId
  let s = t();
  const { dbRowId, includeChildListings } = normalizeRowId(rowId);
  steps.push({ step: "normalizeRowId", ok: true, ms: t() - s, detail: { dbRowId, includeChildListings, originalRowId: rowId } });

  // Step 2: Find MasterRow
  s = t();
  let masterRow: { id: string; sku: string; listings: unknown[] } | null = null;
  try {
    masterRow = await db.masterRow.findUnique({
      where: { id: dbRowId },
      select: {
        id: true,
        sku: true,
        listings: {
          select: {
            platformItemId: true,
            integration: { select: { id: true, platform: true, label: true, enabled: true } },
            childListings: {
              select: {
                platformItemId: true,
                integration: { select: { id: true, platform: true, label: true, enabled: true } },
              },
            },
          },
        },
      },
    });
    steps.push({ step: "findMasterRow", ok: !!masterRow, ms: t() - s, detail: masterRow ? { id: masterRow.id, sku: masterRow.sku, listingCount: masterRow.listings.length } : "not found" });
  } catch (error) {
    steps.push({ step: "findMasterRow", ok: false, ms: t() - s, detail: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ rowId, steps });
  }

  if (!masterRow) {
    return NextResponse.json({ rowId, steps, error: `MasterRow "${dbRowId}" not found` });
  }

  // Step 3: Collect refresh buckets
  s = t();
  type BucketInfo = { integrationId: string; platform: string; label: string; enabled: boolean; itemIds: string[] };
  const bucketInfos: BucketInfo[] = [];
  for (const listing of masterRow.listings as Array<{ platformItemId: string; integration: { id: string; platform: string; label: string; enabled: boolean }; childListings: Array<{ platformItemId: string; integration: { id: string; platform: string; label: string; enabled: boolean } }> }>) {
    const int = listing.integration;
    const existing = bucketInfos.find((b) => b.platform === int.platform);
    if (existing) {
      if (!existing.itemIds.includes(listing.platformItemId)) existing.itemIds.push(listing.platformItemId);
    } else {
      bucketInfos.push({ integrationId: int.id, platform: int.platform, label: int.label, enabled: int.enabled, itemIds: [listing.platformItemId] });
    }
    if (includeChildListings) {
      for (const child of listing.childListings) {
        const cint = child.integration;
        const cexisting = bucketInfos.find((b) => b.platform === cint.platform);
        if (cexisting) {
          if (!cexisting.itemIds.includes(child.platformItemId)) cexisting.itemIds.push(child.platformItemId);
        } else {
          bucketInfos.push({ integrationId: cint.id, platform: cint.platform, label: cint.label, enabled: cint.enabled, itemIds: [child.platformItemId] });
        }
      }
    }
  }
  steps.push({ step: "collectBuckets", ok: bucketInfos.length > 0, ms: t() - s, detail: bucketInfos.map((b) => ({ platform: b.platform, label: b.label, enabled: b.enabled, itemCount: b.itemIds.length, itemIds: b.itemIds })) });

  if (bucketInfos.length === 0) {
    return NextResponse.json({ rowId, steps, message: "No marketplace listings linked" });
  }

  // Step 4: Fetch integrations
  s = t();
  const integrationIds = [...new Set(bucketInfos.map((b) => b.integrationId))];
  let integrations: Integration[] = [];
  try {
    integrations = await db.integration.findMany({ where: { id: { in: integrationIds } } });
    steps.push({ step: "fetchIntegrations", ok: true, ms: t() - s, detail: integrations.map((i) => ({ id: i.id, platform: i.platform, label: i.label, enabled: i.enabled })) });
  } catch (error) {
    steps.push({ step: "fetchIntegrations", ok: false, ms: t() - s, detail: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ rowId, steps });
  }

  // Step 5: Try each platform refresh with detailed error capture
  for (const bucket of bucketInfos) {
    const integration = integrations.find((i) => i.id === bucket.integrationId);
    if (!integration || !integration.enabled) {
      steps.push({ step: `refresh:${bucket.platform}`, ok: false, ms: 0, detail: "integration not found or disabled" });
      continue;
    }

    s = t();
    try {
      const isEbay = bucket.platform === "TPP_EBAY" || bucket.platform === "TT_EBAY";
      const isBigCommerce = bucket.platform === "BIGCOMMERCE";
      const isShopify = bucket.platform === "SHOPIFY";

      if (isEbay) {
        const result = await startIntegrationSync(
          integration,
          {
            requestedMode: "incremental",
            targetedPlatformItemIds: bucket.itemIds,
            triggerSource: "manual",
            triggeredBy: "manual:debug_refresh",
            skipHeavyOperations: true,
          },
          "inline",
        );
        steps.push({ step: `refresh:${bucket.platform}`, ok: result.status === "COMPLETED", ms: t() - s, detail: { status: result.status, message: result.message, jobId: result.jobId } });
      } else if (isBigCommerce) {
        const result = await runBigCommerceWebhookReconcile(
          { productIds: bucket.itemIds },
          { requestedMode: "incremental", effectiveMode: "incremental", triggerSource: "manual", triggeredBy: "manual:debug_refresh", skipHeavyOperations: true },
        );
        steps.push({ step: `refresh:${bucket.platform}`, ok: result.status === "completed", ms: t() - s, detail: { status: result.status, errors: result.errors ?? [], syncJobId: result.syncJobId } });
      } else if (isShopify) {
        const result = await runShopifyWebhookReconcile(
          { productIds: bucket.itemIds },
          { requestedMode: "incremental", effectiveMode: "incremental", triggerSource: "manual", triggeredBy: "manual:debug_refresh", skipHeavyOperations: true },
        );
        steps.push({ step: `refresh:${bucket.platform}`, ok: result.status === "COMPLETED", ms: t() - s, detail: { status: result.status, errors: result.errors ?? [], jobId: result.jobId } });
      } else {
        steps.push({ step: `refresh:${bucket.platform}`, ok: false, ms: t() - s, detail: "unsupported platform" });
      }
    } catch (error) {
      steps.push({
        step: `refresh:${bucket.platform}`,
        ok: false,
        ms: t() - s,
        detail: {
          errorType: error instanceof Error ? error.constructor.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack?.split("\n").slice(0, 5) : undefined,
        },
      });
    }
  }

  const totalMs = steps.reduce((sum, st) => sum + st.ms, 0);
  return NextResponse.json({ rowId, totalMs, steps });
}
