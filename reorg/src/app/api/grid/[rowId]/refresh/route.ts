import { NextResponse } from "next/server";
import { Platform, Prisma, type Integration } from "@prisma/client";
import { db } from "@/lib/db";
import { getGridRowById } from "@/lib/grid-query";
import { startIntegrationSync } from "@/lib/services/sync-control";
import { runBigCommerceWebhookReconcile } from "@/lib/services/bigcommerce-sync";
import { runShopifyWebhookReconcile } from "@/lib/services/shopify-sync";

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
          },
        );

        return {
          platform: bucket.platform,
          status: result.status === "completed" ? "COMPLETED" : "FAILED",
          message:
            result.status === "completed"
              ? `${integration.label} row refresh completed.`
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
          },
        );

        return {
          platform: bucket.platform,
          status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED",
          message:
            result.status === "COMPLETED"
              ? `${integration.label} row refresh completed.`
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

    // Sequential to avoid overwhelming the Vercel function with parallel
    // eBay API calls that can cause timeouts and raw 500s.
    const results: RefreshResult[] = [];
    for (const bucket of buckets.values()) {
      const integration = integrationById.get(bucket.integrationId);
      if (!integration?.enabled) {
        results.push({
          platform: bucket.platform,
          status: "FAILED",
          message: `${bucket.platform} is not connected.`,
          jobId: null,
        });
        continue;
      }

      results.push(await refreshBucket(integration, bucket));
    }

    const completedCount = results.filter((result) => result.status === "COMPLETED").length;
    const runningCount = results.filter((result) => result.status === "ALREADY_RUNNING").length;
    const failedCount = results.filter((result) => result.status === "FAILED").length;

    let refreshedRow;
    try {
      const rowStartedAt = Date.now();
      refreshedRow = await getGridRowById(rowId);
      // attach timing to the result below
      (refreshedRow as Record<string, unknown>).__rowBuildMs = Date.now() - rowStartedAt;
    } catch (rowError) {
      const msg = rowError instanceof Error ? rowError.message : String(rowError);
      console.error("[grid-row-refresh] getGridRowById failed", msg, rowError);
      refreshedRow = null;
    }

    const failedDetails = results
      .filter((r) => r.status === "FAILED")
      .map((r) => `${r.platform}: ${r.message}`)
      .join("; ");

    const message =
      failedCount === 0
        ? `Refreshed ${completedCount} store${completedCount === 1 ? "" : "s"}${runningCount > 0 ? `, ${runningCount} already syncing` : ""}.`
        : failedCount === results.length
          ? `All ${failedCount} store sync${failedCount === 1 ? "" : "s"} failed. ${failedDetails}`
          : `Refreshed ${completedCount} store${completedCount === 1 ? "" : "s"} with ${failedCount} issue${failedCount === 1 ? "" : "s"}. ${failedDetails}`;

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
