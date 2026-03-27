import { NextResponse } from "next/server";
import { Platform, Prisma, type Integration } from "@prisma/client";
import { db } from "@/lib/db";
import { getGridRowById } from "@/lib/grid-query";
import { startIntegrationSync } from "@/lib/services/sync-control";
import { runBigCommerceWebhookReconcile } from "@/lib/services/bigcommerce-sync";
import { runShopifyWebhookReconcile } from "@/lib/services/shopify-sync";
import {
  getEbayTradingRateLimitSnapshotForIntegration,
  getEbayCooldownUntilFromSnapshot,
} from "@/lib/services/ebay-analytics";

export const maxDuration = 60;

type RefreshablePlatform = "TPP_EBAY" | "TT_EBAY" | "BIGCOMMERCE" | "SHOPIFY";

type RefreshBucket = {
  integrationId: string;
  platform: RefreshablePlatform;
  itemIds: Set<string>;
};

type RefreshResult =
  | {
      platform: RefreshablePlatform;
      status: "COMPLETED" | "STARTED" | "ALREADY_RUNNING";
      message: string;
      jobId: string | null;
    }
  | {
      platform: RefreshablePlatform;
      status: "FAILED";
      message: string;
      jobId: string | null;
    };

const PLATFORM_REFRESH_TIMEOUT_MS = 25_000;

const PLATFORM_SHORT: Record<string, string> = {
  TPP_EBAY: "eBay TPP",
  TT_EBAY: "eBay TT",
  BIGCOMMERCE: "BC",
  SHOPIFY: "SHPFY",
};

function shortPlatform(platform: string): string {
  return PLATFORM_SHORT[platform] ?? platform;
}

const masterRowSelect = Prisma.validator<Prisma.MasterRowDefaultArgs>()({
  select: {
    id: true,
    sku: true,
    listings: {
      select: {
        platformItemId: true,
        integration: {
          select: {
            id: true,
            platform: true,
          },
        },
        childListings: {
          select: {
            platformItemId: true,
            integration: {
              select: {
                id: true,
                platform: true,
              },
            },
          },
        },
      },
    },
  },
});

type SelectedMasterRow = Prisma.MasterRowGetPayload<typeof masterRowSelect>;

function normalizeRowId(rowId: string) {
  if (rowId.startsWith("child-")) {
    return {
      dbRowId: rowId.slice("child-".length),
      includeChildListings: false,
    };
  }

  if (rowId.startsWith("variation-parent:")) {
    const familyKey = rowId.slice("variation-parent:".length);

    if (familyKey.startsWith("child-")) {
      const firstChildMasterRowId = familyKey.split("|")[0].slice("child-".length);
      return {
        dbRowId: firstChildMasterRowId,
        includeChildListings: true,
      };
    }

    const titleSep = familyKey.indexOf("::");
    if (titleSep !== -1) {
      return {
        dbRowId: familyKey,
        includeChildListings: true,
      };
    }

    return {
      dbRowId: familyKey,
      includeChildListings: true,
    };
  }

  return {
    dbRowId: rowId,
    includeChildListings: true,
  };
}

function isRefreshablePlatform(platform: Platform): platform is RefreshablePlatform {
  return (
    platform === Platform.TPP_EBAY ||
    platform === Platform.TT_EBAY ||
    platform === Platform.BIGCOMMERCE ||
    platform === Platform.SHOPIFY
  );
}

function collectRefreshBuckets(
  masterRow: SelectedMasterRow,
  includeChildListings: boolean,
): Map<RefreshablePlatform, RefreshBucket> {
  const buckets = new Map<RefreshablePlatform, RefreshBucket>();

  function appendListing(
    integrationId: string,
    platform: Platform,
    platformItemId: string,
  ) {
    if (!isRefreshablePlatform(platform) || !platformItemId.trim()) {
      return;
    }

    const existing = buckets.get(platform);
    if (existing) {
      existing.itemIds.add(platformItemId);
      return;
    }

    buckets.set(platform, {
      integrationId,
      platform,
      itemIds: new Set([platformItemId]),
    });
  }

  for (const listing of masterRow.listings) {
    appendListing(
      listing.integration.id,
      listing.integration.platform,
      listing.platformItemId,
    );

    if (!includeChildListings) {
      continue;
    }

    for (const childListing of listing.childListings) {
      appendListing(
        childListing.integration.id,
        childListing.integration.platform,
        childListing.platformItemId,
      );
    }
  }

  return buckets;
}

async function refreshBucket(
  integration: Integration,
  bucket: RefreshBucket,
): Promise<RefreshResult> {
  const targetedPlatformItemIds = [...bucket.itemIds];

  try {
    switch (bucket.platform) {
      case Platform.TPP_EBAY:
      case Platform.TT_EBAY: {
        const result = await startIntegrationSync(
          integration,
          {
            requestedMode: "incremental",
            targetedPlatformItemIds,
            triggerSource: "manual",
            triggeredBy: "manual:row_refresh",
            skipHeavyOperations: true,
          },
          "inline",
        );

        return {
          platform: bucket.platform,
          status: result.status === "UNSUPPORTED" ? "FAILED" : result.status,
          message: result.message,
          jobId: result.jobId,
        };
      }
      case Platform.BIGCOMMERCE: {
        const result = await runBigCommerceWebhookReconcile(
          { productIds: targetedPlatformItemIds },
          {
            requestedMode: "incremental",
            effectiveMode: "incremental",
            triggerSource: "manual",
            triggeredBy: "manual:row_refresh",
            skipHeavyOperations: true,
          },
        );

        const bcError = result.errors?.[0];
        return {
          platform: bucket.platform,
          status: result.status === "completed" ? "COMPLETED" : "FAILED",
          message:
            result.status === "completed"
              ? `${integration.label} row refresh completed.`
              : bcError
                ? `${shortPlatform(bucket.platform)}: ${bcError}`
                : `${integration.label} row refresh failed.`,
          jobId: result.syncJobId,
        };
      }
      case Platform.SHOPIFY: {
        const result = await runShopifyWebhookReconcile(
          { productIds: targetedPlatformItemIds },
          {
            requestedMode: "incremental",
            effectiveMode: "incremental",
            triggerSource: "manual",
            triggeredBy: "manual:row_refresh",
            skipHeavyOperations: true,
          },
        );

        const shpfyError = result.errors?.[0]?.message;
        return {
          platform: bucket.platform,
          status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED",
          message:
            result.status === "COMPLETED"
              ? `${integration.label} row refresh completed.`
              : shpfyError
                ? `${shortPlatform(bucket.platform)}: ${shpfyError}`
                : `${integration.label} row refresh failed.`,
          jobId: result.jobId,
        };
      }
      default:
        return {
          platform: bucket.platform,
          status: "FAILED",
          message: `${bucket.platform} row refresh is not implemented.`,
          jobId: null,
        };
    }
  } catch (error) {
    return {
      platform: bucket.platform,
      status: "FAILED",
      message: error instanceof Error ? error.message : "Row refresh failed",
      jobId: null,
    };
  }
}

function refreshBucketWithTimeout(
  integration: Integration,
  bucket: RefreshBucket,
): Promise<RefreshResult> {
  const timeoutResult: RefreshResult = {
    platform: bucket.platform,
    status: "FAILED",
    message: `Timed out after ${PLATFORM_REFRESH_TIMEOUT_MS / 1000}s — try again later.`,
    jobId: null,
  };

  return Promise.race([
    refreshBucket(integration, bucket),
    new Promise<RefreshResult>((resolve) =>
      setTimeout(() => resolve(timeoutResult), PLATFORM_REFRESH_TIMEOUT_MS),
    ),
  ]);
}

function summarizeMessage(msg: string, maxLen = 80): string {
  const trimmed = msg.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ rowId: string }> },
) {
  try {
    const startedAt = Date.now();
    const { rowId } = await params;
    const { dbRowId, includeChildListings } = normalizeRowId(rowId);

    const masterRow = await db.masterRow.findUnique({
      where: { id: dbRowId },
      ...masterRowSelect,
    });

    if (!masterRow) {
      return NextResponse.json(
        { error: `Row "${rowId}" not found` },
        { status: 404 },
      );
    }

    const buckets = collectRefreshBuckets(masterRow, includeChildListings);
    if (buckets.size === 0) {
      const currentRow = await getGridRowById(rowId);
      return NextResponse.json({
        data: {
          rowId,
          sku: masterRow.sku,
          row: currentRow,
          results: [] as RefreshResult[],
          message: "No marketplace listings linked to this row — nothing to refresh.",
        },
      });
    }

    const integrations = await db.integration.findMany({
      where: {
        id: {
          in: [...new Set([...buckets.values()].map((bucket) => bucket.integrationId))],
        },
      },
    });
    const integrationById = new Map(integrations.map((integration) => [integration.id, integration]));

    // Pre-check eBay rate limits in parallel — skip eBay platforms instantly if quota is exhausted.
    const ebayRateLimitedPlatforms = new Set<RefreshablePlatform>();
    const ebayRateLimitMessages = new Map<RefreshablePlatform, string>();
    const ebayBuckets = [...buckets.values()].filter(
      (b) => b.platform === Platform.TPP_EBAY || b.platform === Platform.TT_EBAY,
    );
    await Promise.all(
      ebayBuckets.map(async (bucket) => {
        const integration = integrationById.get(bucket.integrationId);
        if (!integration?.enabled) return;
        try {
          const snapshot = await getEbayTradingRateLimitSnapshotForIntegration(integration);
          const cooldownUntil = getEbayCooldownUntilFromSnapshot(snapshot, "GetItem");
          if (cooldownUntil && cooldownUntil.getTime() > Date.now()) {
            ebayRateLimitedPlatforms.add(bucket.platform);
            const resetLabel = cooldownUntil.toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              timeZone: "America/New_York",
            });
            ebayRateLimitMessages.set(
              bucket.platform,
              `Daily API limit reached — resets around ${resetLabel} ET.`,
            );
          }
        } catch {
          // Rate limit check failed — proceed with the sync anyway
        }
      }),
    );

    const results = await Promise.all(
      [...buckets.values()].map(async (bucket) => {
        const integration = integrationById.get(bucket.integrationId);
        if (!integration?.enabled) {
          return {
            platform: bucket.platform,
            status: "FAILED",
            message: `${shortPlatform(bucket.platform)} is not connected.`,
            jobId: null,
          } satisfies RefreshResult;
        }

        if (ebayRateLimitedPlatforms.has(bucket.platform)) {
          return {
            platform: bucket.platform,
            status: "FAILED",
            message: ebayRateLimitMessages.get(bucket.platform) ?? "Daily API limit reached.",
            jobId: null,
          } satisfies RefreshResult;
        }

        return refreshBucketWithTimeout(integration, bucket);
      }),
    );

    const completedCount = results.filter((r) => r.status === "COMPLETED").length;
    const failedCount = results.filter((r) => r.status === "FAILED").length;

    let refreshedRow;
    try {
      refreshedRow = await getGridRowById(rowId);
    } catch (rowError) {
      const msg = rowError instanceof Error ? rowError.message : String(rowError);
      console.error("[grid-row-refresh] getGridRowById failed", msg, rowError);
      refreshedRow = null;
    }

    // Build a user-friendly per-platform breakdown
    const perPlatformLines = results.map((r) => {
      const label = shortPlatform(r.platform);
      if (r.status === "COMPLETED") return `${label}: ✓`;
      if (r.status === "ALREADY_RUNNING") return `${label}: sync already running`;
      return `${label}: ${summarizeMessage(r.message)}`;
    });

    const breakdown = perPlatformLines.join(" · ");
    const message =
      failedCount === 0
        ? `All stores refreshed. ${breakdown}`
        : failedCount === results.length
          ? `All ${failedCount} store${failedCount === 1 ? "" : "s"} failed. ${breakdown}`
          : `${completedCount} refreshed, ${failedCount} failed. ${breakdown}`;

    return NextResponse.json({
      data: {
        rowId,
        sku: masterRow.sku,
        row: refreshedRow,
        results,
        message,
        timings: {
          totalMs: Date.now() - startedAt,
        },
      },
    });
  } catch (error) {
    const errorType = error instanceof Error ? error.constructor.name : typeof error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[grid-row-refresh] failed [${errorType}]`, errorMessage, error);
    return NextResponse.json(
      { error: `[${errorType}] ${errorMessage}` },
      { status: 500 },
    );
  }
}
