import { endOfDay, startOfDay, subDays } from "date-fns";
import type { Platform } from "@prisma/client";
import { getAppEnv } from "@/lib/app-env";
import { db } from "@/lib/db";
import {
  fetchMarketplaceSales,
  getEnabledForecastIntegrations,
} from "@/lib/inventory-forecast/marketplace-sales";
import type {
  ForecastSaleLine,
  SalesSyncIssue,
  SalesSyncSummary,
} from "@/lib/inventory-forecast/types";

const FORECAST_HISTORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LOCAL_LIVE_FORECAST_HISTORY_LOOKBACK_LIMIT_DAYS = 30;
const LOCAL_FORECAST_SYNC_TIMEOUT_MS = 15_000;
const LOCAL_EBAY_FORECAST_SYNC_TIMEOUT_MS = 120_000;
// Fetch-only timeouts — keep total function time under Vercel Pro's 300s limit.
// Sync phase runs in parallel, so effective max is max(eBay, BC, Other) = 120s.
// That leaves ~180s for DB upsert + forecast computation + response serialization.
const DEPLOYED_EBAY_SYNC_TIMEOUT_MS = 120_000;
const DEPLOYED_BIGCOMMERCE_SYNC_TIMEOUT_MS = 90_000;
const DEPLOYED_OTHER_SYNC_TIMEOUT_MS = 60_000;
const LOCAL_CACHED_FORECAST_PLATFORMS = new Set<Platform>(["SHOPIFY", "BIGCOMMERCE"]);

function uniquePlatforms(lines: ForecastSaleLine[]) {
  return [...new Set(lines.map((line) => line.platform))];
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}

function truncateIsoDate(value: Date | null | undefined) {
  return value?.toISOString().slice(0, 10) ?? "unknown";
}

async function getRecentForecastSalesSyncAudit(): Promise<{
  createdAt: Date;
  lookbackDays: number | null;
  issues: SalesSyncIssue[];
  truncatedPlatforms: Set<Platform>;
} | null> {
  const latestAudit = await db.auditLog.findFirst({
    where: { action: "forecast_sales_history_synced" },
    orderBy: { createdAt: "desc" },
    select: {
      createdAt: true,
      details: true,
    },
  });

  if (!latestAudit) return null;

  const details =
    latestAudit.details && typeof latestAudit.details === "object"
      ? (latestAudit.details as Record<string, unknown>)
      : {};
  const rawIssues = Array.isArray(details.issues) ? details.issues : [];
  const issues: SalesSyncIssue[] = rawIssues.flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const record = issue as Record<string, unknown>;
    const platform =
      typeof record.platform === "string" ? (record.platform as Platform) : null;
    const level =
      record.level === "warning" || record.level === "error" ? record.level : null;
    const message = typeof record.message === "string" ? record.message : null;
    if (!platform || !level || !message) return [];
    return [{ platform, level, message }];
  });

  const truncatedPlatforms = new Set<Platform>(
    Array.isArray(details.truncatedPlatforms)
      ? details.truncatedPlatforms.filter(
          (platform): platform is Platform => typeof platform === "string",
        )
      : [],
  );

  return {
    createdAt: latestAudit.createdAt,
    lookbackDays:
      typeof details.lookbackDays === "number" ? details.lookbackDays : null,
    issues,
    truncatedPlatforms,
  };
}

async function getCachedSalesCoverageByPlatform() {
  const rows = await db.marketplaceSaleLine.groupBy({
    by: ["platform"],
    _min: { orderDate: true },
    _max: { orderDate: true },
    _count: { _all: true },
  });

  return new Map(
    rows.map((row) => [
      row.platform,
      {
        lineCount: row._count._all,
        earliest: row._min.orderDate,
        latest: row._max.orderDate,
      },
    ]),
  );
}

export async function syncSalesHistoryForLookback(lookbackDays: number): Promise<{
  issues: SalesSyncIssue[];
  truncatedPlatforms: Set<Platform>;
}> {
  const integrations = await getEnabledForecastIntegrations();
  const appEnv = getAppEnv();
  const useCachedLocalHistoryForHeavyPlatforms =
    appEnv === "local" && lookbackDays > LOCAL_LIVE_FORECAST_HISTORY_LOOKBACK_LIMIT_DAYS;
  const coverageByPlatform = await getCachedSalesCoverageByPlatform();
  const recentAudit = await getRecentForecastSalesSyncAudit();
  // Warnings (e.g. a platform timeout) don't invalidate the cache — only errors do.
  // This prevents a perpetual re-sync loop when one platform consistently times out.
  const cacheHasNoIssues =
    recentAudit?.issues.length === 0 ||
    recentAudit?.issues.every((issue) => issue.level !== "error");
  // Cache is valid when: a recent audit exists, covers the requested lookback,
  // is within TTL, and had no error-level issues.  We no longer require every
  // platform to have data — if one platform always times out, the cache for the
  // others is still valid.  Missing platforms show as "No data" in the UI.
  if (
    recentAudit &&
    recentAudit.lookbackDays != null &&
    recentAudit.lookbackDays >= lookbackDays &&
    Date.now() - recentAudit.createdAt.getTime() <= FORECAST_HISTORY_CACHE_TTL_MS &&
    cacheHasNoIssues
  ) {
    return {
      issues: [],
      truncatedPlatforms: recentAudit.truncatedPlatforms,
    };
  }

  const issues: SalesSyncIssue[] = [];
  const truncatedPlatforms = new Set<Platform>();
  let totalLinesSynced = 0;

  const syncTasks = integrations.map((integration) => {
    if (
      useCachedLocalHistoryForHeavyPlatforms &&
      LOCAL_CACHED_FORECAST_PLATFORMS.has(integration.platform)
    ) {
      const coverage = coverageByPlatform?.get(integration.platform);
      return {
        integration,
        skip: true as const,
        issue: {
          platform: integration.platform,
          level: "warning" as const,
          message:
            !coverage || !coverage.earliest || !coverage.latest || coverage.lineCount === 0
              ? `Using cached local sales history to avoid long marketplace refreshes for ${lookbackDays}d forecasts. No cached ${integration.label} order lines are available yet.`
              : `Using cached local sales history to avoid long marketplace refreshes for ${lookbackDays}d forecasts. Current cached ${integration.label} coverage is ${truncateIsoDate(coverage.earliest)} to ${truncateIsoDate(coverage.latest)}.`,
        },
      };
    }
    return { integration, skip: false as const, issue: null };
  });

  for (const task of syncTasks) {
    if (task.skip) {
      issues.push(task.issue!);
      truncatedPlatforms.add(task.integration.platform);
    }
  }

  const liveTasks = syncTasks.filter((t) => !t.skip);

  // Phase 1: fetch from all marketplaces in parallel (with per-platform abort timeouts)
  const fetchResults = await Promise.allSettled(
    liveTasks.map(async ({ integration }) => {
      const isEbay = integration.platform === "TPP_EBAY" || integration.platform === "TT_EBAY";
      const isBigCommerce = integration.platform === "BIGCOMMERCE";
      const perIntegrationTimeoutMs =
        appEnv === "local"
          ? isEbay
            ? LOCAL_EBAY_FORECAST_SYNC_TIMEOUT_MS
            : LOCAL_FORECAST_SYNC_TIMEOUT_MS
          : isEbay
            ? DEPLOYED_EBAY_SYNC_TIMEOUT_MS
            : isBigCommerce
              ? DEPLOYED_BIGCOMMERCE_SYNC_TIMEOUT_MS
              : DEPLOYED_OTHER_SYNC_TIMEOUT_MS;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perIntegrationTimeoutMs);

      try {
        const result = await fetchMarketplaceSales(integration, lookbackDays, {
          signal: controller.signal,
        });
        return { integration, result };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  // Phase 2: collect results, then upsert to DB outside the abort window
  const linesToUpsert: ForecastSaleLine[] = [];
  for (let i = 0; i < fetchResults.length; i++) {
    const settled = fetchResults[i];
    const { integration } = liveTasks[i];

    if (settled.status === "fulfilled") {
      const { result } = settled.value;
      issues.push(...result.issues);
      if (result.truncated) {
        truncatedPlatforms.add(integration.platform);
      }
      totalLinesSynced += result.lines.length;
      linesToUpsert.push(...result.lines);
    } else {
      const error = settled.reason;
      issues.push({
        platform: integration.platform,
        level: isAbortError(error) ? "warning" : "error",
        message:
          isAbortError(error)
            ? `${integration.label} sales refresh took too long, so the forecaster kept using cached sales history instead.`
            : error instanceof Error
              ? error.message
              : `Failed to sync ${integration.label} sales history.`,
      });
    }
  }

  // DB upsert runs after all fetches complete — no abort timeout applies here
  if (linesToUpsert.length > 0) {
    await upsertSalesHistoryLines(linesToUpsert);
  }

  await db.auditLog.create({
    data: {
      action: "forecast_sales_history_synced",
      entityType: "forecast_sales_history",
      entityId: String(lookbackDays),
      details: {
        lookbackDays,
        totalLinesSynced,
        issues,
        truncatedPlatforms: [...truncatedPlatforms],
      } as never,
    },
  });

  return { issues, truncatedPlatforms };
}

async function upsertSalesHistoryLines(lines: ForecastSaleLine[]) {
  if (lines.length === 0) return;

  const skuSet = [...new Set(lines.map((line) => line.sku.trim()).filter(Boolean))];
  const masterRows = await db.masterRow.findMany({
    where: {
      sku: { in: skuSet },
    },
    select: {
      id: true,
      sku: true,
    },
  });
  const masterRowIdBySku = new Map(masterRows.map((row) => [row.sku, row.id]));
  const orderByKey = new Map<
    string,
    {
      platform: ForecastSaleLine["platform"];
      externalOrderId: string;
      orderDate: Date;
      orderStatus: string;
      cancelledAt: Date | null;
      rawData: Record<string, unknown>;
    }
  >();

  for (const line of lines) {
    const key = `${line.platform}:${line.externalOrderId}`;
    if (orderByKey.has(key)) continue;
    orderByKey.set(key, {
      platform: line.platform,
      externalOrderId: line.externalOrderId,
      orderDate: line.orderDate,
      orderStatus: line.isCancelled ? "cancelled" : "completed",
      cancelledAt: line.isCancelled ? line.orderDate : null,
      rawData: line.rawData ?? {},
    });
  }

  const orderIdsByPlatform = new Map<ForecastSaleLine["platform"], string[]>();
  for (const order of orderByKey.values()) {
    const bucket = orderIdsByPlatform.get(order.platform) ?? [];
    bucket.push(order.externalOrderId);
    orderIdsByPlatform.set(order.platform, bucket);
  }

  async function findOrdersByPlatform(
    entries: Map<ForecastSaleLine["platform"], string[]>,
  ) {
    const results: Array<{ id: string; platform: ForecastSaleLine["platform"]; externalOrderId: string }> = [];

    for (const [platform, externalOrderIds] of entries.entries()) {
      for (const chunk of chunkArray(externalOrderIds, 5000)) {
        const rows = await db.marketplaceSaleOrder.findMany({
          where: {
            platform,
            externalOrderId: { in: chunk },
          },
          select: {
            id: true,
            platform: true,
            externalOrderId: true,
          },
        });
        results.push(...rows);
      }
    }

    return results;
  }

  const existingOrders = await findOrdersByPlatform(orderIdsByPlatform);

  const existingOrderKeys = new Set(
    existingOrders.map((order) => `${order.platform}:${order.externalOrderId}`),
  );
  const ordersToCreate = [...orderByKey.entries()]
    .filter(([key]) => !existingOrderKeys.has(key))
    .map(([_key, order]) => ({
      platform: order.platform,
      externalOrderId: order.externalOrderId,
      orderDate: order.orderDate,
      orderStatus: order.orderStatus,
      cancelledAt: order.cancelledAt,
      rawData: order.rawData as never,
    }));

  for (const chunk of chunkArray(ordersToCreate, 1000)) {
    await db.marketplaceSaleOrder.createMany({
      data: chunk,
      skipDuplicates: true,
    });
  }

  const resolvedOrders = await findOrdersByPlatform(orderIdsByPlatform);
  const orderIdByKey = new Map(
    resolvedOrders.map((order) => [`${order.platform}:${order.externalOrderId}`, order.id]),
  );

  const lineRows = lines.flatMap((line) => {
    const marketplaceSaleOrderId = orderIdByKey.get(`${line.platform}:${line.externalOrderId}`);
    if (!marketplaceSaleOrderId) return [];
    return [
      {
        marketplaceSaleOrderId,
        masterRowId: masterRowIdBySku.get(line.sku) ?? null,
        platform: line.platform,
        externalLineId: line.externalLineId,
        orderDate: line.orderDate,
        sku: line.sku,
        title: line.title,
        platformItemId: line.platformItemId ?? null,
        platformVariantId: line.platformVariantId ?? null,
        quantity: line.quantity,
        isCancelled: Boolean(line.isCancelled),
        isReturn: Boolean(line.isReturn),
        rawData: (line.rawData ?? {}) as never,
      },
    ];
  });

  for (const chunk of chunkArray(lineRows, 1000)) {
    await db.marketplaceSaleLine.createMany({
      data: chunk,
      skipDuplicates: true,
    });
  }
}

export async function loadAggregatedSalesHistory(
  lookbackDays: number,
  runDate?: Date,
) {
  const anchor = runDate ?? new Date();
  const startDate = startOfDay(subDays(anchor, lookbackDays - 1));
  const endDate = endOfDay(anchor);

  const saleLines = await db.marketplaceSaleLine.findMany({
    where: {
      orderDate: {
        gte: startDate,
        lte: endDate,
      },
      isCancelled: false,
      isReturn: false,
    },
    select: {
      platform: true,
      externalLineId: true,
      marketplaceSaleOrder: {
        select: {
          externalOrderId: true,
        },
      },
      orderDate: true,
      sku: true,
      title: true,
      quantity: true,
      platformItemId: true,
      platformVariantId: true,
      masterRowId: true,
    },
    orderBy: {
      orderDate: "asc",
    },
  });

  const salesBySku = new Map<string, ForecastSaleLine[]>();
  const platformStats = new Map<string, { lineCount: number; earliest: Date | null; latest: Date | null }>();

  for (const line of saleLines) {
    const sale: ForecastSaleLine = {
      platform: line.platform,
      externalOrderId: line.marketplaceSaleOrder.externalOrderId,
      externalLineId: line.externalLineId,
      orderDate: line.orderDate,
      sku: line.sku,
      title: line.title,
      quantity: line.quantity,
      platformItemId: line.platformItemId,
      platformVariantId: line.platformVariantId,
      isCancelled: false,
      isReturn: false,
    };
    const bucket = salesBySku.get(line.sku) ?? [];
    bucket.push(sale);
    salesBySku.set(line.sku, bucket);

    const stats = platformStats.get(line.platform) ?? { lineCount: 0, earliest: null, latest: null };
    stats.lineCount += 1;
    if (!stats.earliest || line.orderDate < stats.earliest) stats.earliest = line.orderDate;
    if (!stats.latest || line.orderDate > stats.latest) stats.latest = line.orderDate;
    platformStats.set(line.platform, stats);
  }

  const summary: SalesSyncSummary = {
    earliestCoveredAt: saleLines[0]?.orderDate.toISOString() ?? null,
    latestCoveredAt: saleLines.at(-1)?.orderDate.toISOString() ?? null,
    platformsSynced: uniquePlatforms(
      saleLines.map((line) => ({
        platform: line.platform,
        externalOrderId: line.marketplaceSaleOrder.externalOrderId,
        externalLineId: line.externalLineId,
        orderDate: line.orderDate,
        sku: line.sku,
        title: line.title,
        quantity: line.quantity,
      })),
    ),
    issues: [],
  };

  return { salesBySku, summary, platformStats };
}

export async function getTruncatedHistoryBySku(
  lookbackDays: number,
  truncatedPlatforms: Set<Platform>,
) {
  if (lookbackDays <= 90 || truncatedPlatforms.size === 0) {
    return new Map<string, boolean>();
  }

  const platformList = [...truncatedPlatforms];
  const rows = await db.masterRow.findMany({
    where: {
      listings: {
        some: {
          integration: {
            platform: { in: platformList },
          },
        },
      },
    },
    select: {
      sku: true,
    },
  });

  return new Map(rows.map((row) => [row.sku, true]));
}
