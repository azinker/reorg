import { NextResponse } from "next/server";
import { Platform, Prisma, type Integration } from "@prisma/client";
import { db } from "@/lib/db";
import { getGridRowById } from "@/lib/grid-query";
import { refreshEbayItemsDirect } from "@/lib/services/ebay-tpp-sync";
import { refreshEbayTtItemsDirect } from "@/lib/services/ebay-tt-sync";
import { runBigCommerceWebhookReconcile } from "@/lib/services/bigcommerce-sync";
import { runShopifyWebhookReconcile } from "@/lib/services/shopify-sync";

export const maxDuration = 45;

type RefreshablePlatform = "TPP_EBAY" | "TT_EBAY" | "BIGCOMMERCE" | "SHOPIFY";

type RefreshBucket = {
  integrationId: string;
  platform: RefreshablePlatform;
  itemIds: Set<string>;
};

type RefreshResult = {
  platform: RefreshablePlatform;
  status: "COMPLETED" | "FAILED";
  message: string;
};

const PLATFORM_REFRESH_TIMEOUT_MS = 20_000;

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
        integration: { select: { id: true, platform: true } },
        childListings: {
          select: {
            platformItemId: true,
            integration: { select: { id: true, platform: true } },
          },
        },
      },
    },
  },
});

type SelectedMasterRow = Prisma.MasterRowGetPayload<typeof masterRowSelect>;

function parseRowId(rowId: string): {
  masterRowIds: string[];
  includeChildListings: boolean;
} {
  if (rowId.startsWith("child-")) {
    return {
      masterRowIds: [rowId.slice("child-".length)],
      includeChildListings: false,
    };
  }

  if (rowId.startsWith("variation-parent:")) {
    const familyKey = rowId.slice("variation-parent:".length);
    const childIds = familyKey
      .split("|")
      .filter((seg) => seg.startsWith("child-"))
      .map((seg) => seg.slice("child-".length));

    if (childIds.length > 0) {
      return { masterRowIds: childIds, includeChildListings: true };
    }

    const titleSep = familyKey.indexOf("::");
    const rawKey = titleSep !== -1 ? familyKey : familyKey;
    return { masterRowIds: [rawKey], includeChildListings: true };
  }

  return { masterRowIds: [rowId], includeChildListings: true };
}

function isRefreshablePlatform(platform: Platform): platform is RefreshablePlatform {
  return (
    platform === Platform.TPP_EBAY ||
    platform === Platform.TT_EBAY ||
    platform === Platform.BIGCOMMERCE ||
    platform === Platform.SHOPIFY
  );
}

function collectBuckets(
  rows: SelectedMasterRow[],
  includeChildren: boolean,
): Map<RefreshablePlatform, RefreshBucket> {
  const buckets = new Map<RefreshablePlatform, RefreshBucket>();

  function add(integrationId: string, platform: Platform, platformItemId: string) {
    if (!isRefreshablePlatform(platform) || !platformItemId.trim()) return;
    const existing = buckets.get(platform);
    if (existing) {
      existing.itemIds.add(platformItemId);
      return;
    }
    buckets.set(platform, { integrationId, platform, itemIds: new Set([platformItemId]) });
  }

  for (const row of rows) {
    for (const listing of row.listings) {
      add(listing.integration.id, listing.integration.platform, listing.platformItemId);
      if (!includeChildren) continue;
      for (const child of listing.childListings) {
        add(child.integration.id, child.integration.platform, child.platformItemId);
      }
    }
  }

  return buckets;
}

async function refreshBucket(
  integration: Integration,
  bucket: RefreshBucket,
): Promise<RefreshResult> {
  const itemIds = [...bucket.itemIds];

  switch (bucket.platform) {
    case Platform.TPP_EBAY: {
      const result = await refreshEbayItemsDirect(
        { id: integration.id, platform: integration.platform, config: integration.config as Record<string, unknown> },
        itemIds,
      );
      if (result.errors.length > 0 && result.updated === 0) {
        return { platform: bucket.platform, status: "FAILED", message: result.errors[0] };
      }
      return {
        platform: bucket.platform,
        status: "COMPLETED",
        message: result.errors.length > 0
          ? `${result.updated} updated, ${result.errors.length} failed`
          : `${shortPlatform(bucket.platform)}: refreshed`,
      };
    }
    case Platform.TT_EBAY: {
      const result = await refreshEbayTtItemsDirect(
        { id: integration.id, platform: integration.platform, config: integration.config as Record<string, unknown> },
        itemIds,
      );
      if (result.errors.length > 0 && result.updated === 0) {
        return { platform: bucket.platform, status: "FAILED", message: result.errors[0] };
      }
      return {
        platform: bucket.platform,
        status: "COMPLETED",
        message: result.errors.length > 0
          ? `${result.updated} updated, ${result.errors.length} failed`
          : `${shortPlatform(bucket.platform)}: refreshed`,
      };
    }
    case Platform.BIGCOMMERCE: {
      const result = await runBigCommerceWebhookReconcile(
        { productIds: itemIds },
        {
          requestedMode: "incremental",
          effectiveMode: "incremental",
          triggerSource: "manual",
          triggeredBy: "manual:row_refresh",
          skipHeavyOperations: true,
        },
      );
      const err = result.errors?.[0];
      return {
        platform: bucket.platform,
        status: result.status === "completed" ? "COMPLETED" : "FAILED",
        message: result.status === "completed"
          ? `${shortPlatform(bucket.platform)}: refreshed`
          : err ? `${shortPlatform(bucket.platform)}: ${err}` : `${shortPlatform(bucket.platform)}: failed`,
      };
    }
    case Platform.SHOPIFY: {
      const result = await runShopifyWebhookReconcile(
        { productIds: itemIds },
        {
          requestedMode: "incremental",
          effectiveMode: "incremental",
          triggerSource: "manual",
          triggeredBy: "manual:row_refresh",
          skipHeavyOperations: true,
        },
      );
      const err = result.errors?.[0]?.message;
      return {
        platform: bucket.platform,
        status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED",
        message: result.status === "COMPLETED"
          ? `${shortPlatform(bucket.platform)}: refreshed`
          : err ? `${shortPlatform(bucket.platform)}: ${err}` : `${shortPlatform(bucket.platform)}: failed`,
      };
    }
    default:
      return { platform: bucket.platform, status: "FAILED", message: `${bucket.platform} not supported` };
  }
}

function withTimeout(bucket: RefreshBucket, promise: Promise<RefreshResult>): Promise<RefreshResult> {
  return Promise.race([
    promise,
    new Promise<RefreshResult>((resolve) =>
      setTimeout(
        () => resolve({
          platform: bucket.platform,
          status: "FAILED",
          message: `${shortPlatform(bucket.platform)}: timed out (${PLATFORM_REFRESH_TIMEOUT_MS / 1000}s)`,
        }),
        PLATFORM_REFRESH_TIMEOUT_MS,
      ),
    ),
  ]);
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ rowId: string }> },
) {
  const startedAt = Date.now();
  try {
    const { rowId } = await params;
    const { masterRowIds, includeChildListings } = parseRowId(rowId);

    const masterRows = await db.masterRow.findMany({
      where: { id: { in: masterRowIds } },
      ...masterRowSelect,
    });

    if (masterRows.length === 0) {
      return NextResponse.json({ error: `Row not found` }, { status: 404 });
    }

    const buckets = collectBuckets(masterRows, includeChildListings);
    if (buckets.size === 0) {
      const currentRow = await getGridRowById(rowId).catch(() => null);
      return NextResponse.json({
        data: {
          rowId,
          sku: masterRows[0].sku,
          row: currentRow,
          results: [],
          message: "No marketplace listings linked — nothing to refresh.",
        },
      });
    }

    const integrationIds = [...new Set([...buckets.values()].map((b) => b.integrationId))];
    const integrations = await db.integration.findMany({ where: { id: { in: integrationIds } } });
    const integrationById = new Map(integrations.map((i) => [i.id, i]));

    const results = await Promise.all(
      [...buckets.values()].map((bucket) => {
        const integration = integrationById.get(bucket.integrationId);
        if (!integration?.enabled) {
          return Promise.resolve<RefreshResult>({
            platform: bucket.platform,
            status: "FAILED",
            message: `${shortPlatform(bucket.platform)} is not connected.`,
          });
        }
        return withTimeout(bucket, refreshBucket(integration, bucket).catch((err): RefreshResult => ({
          platform: bucket.platform,
          status: "FAILED",
          message: err instanceof Error ? err.message.slice(0, 100) : "Refresh failed",
        })));
      }),
    );

    const completedCount = results.filter((r) => r.status === "COMPLETED").length;
    const failedCount = results.filter((r) => r.status === "FAILED").length;

    let refreshedRow = null;
    try {
      refreshedRow = await getGridRowById(rowId);
    } catch {
      if (masterRowIds.length === 1) {
        refreshedRow = await getGridRowById(masterRowIds[0]).catch(() => null);
      }
    }

    const perPlatformLines = results.map((r) => {
      const label = shortPlatform(r.platform);
      return r.status === "COMPLETED" ? `${label}: ✓` : `${label}: ${r.message.slice(0, 80)}`;
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
        sku: masterRows[0].sku,
        row: refreshedRow,
        results,
        message,
        timings: { totalMs: Date.now() - startedAt },
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[grid-row-refresh] ${msg}`, error);
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 });
  }
}
