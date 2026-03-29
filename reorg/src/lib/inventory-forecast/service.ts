import type { ForecastBucket } from "@prisma/client";
import {
  buildForecastResultLines,
  FORECAST_CONFIDENCE_LEGEND,
  inventoryArrivalDate,
  isReorderRelevantLine,
  normalizeRunDate,
} from "@/lib/inventory-forecast/forecast-engine";
import {
  createSupplierOrderRecord,
  defaultEtaFromTransitDays,
  deleteSupplierOrderRecord,
  getOpenInboundByMasterRowId,
  getSupplierOrderWithLines,
  listRecentSupplierOrders,
  updateSupplierOrderRecord,
} from "@/lib/inventory-forecast/in-transit-orders";
import {
  DEFAULT_FORECAST_INVENTORY_SOURCE,
  getForecastInventoryRows,
} from "@/lib/inventory-forecast/inventory-source";
import {
  getTruncatedHistoryBySku,
  loadAggregatedSalesHistory,
  syncSalesHistoryForLookback,
} from "@/lib/inventory-forecast/sales-history-service";
import { getEnabledForecastIntegrations } from "@/lib/inventory-forecast/marketplace-sales";
import { captureDailyInventorySnapshots, getSnapshotSignals } from "@/lib/inventory-forecast/snapshots";
import type { Platform } from "@prisma/client";
import type {
  CreateSupplierOrderInput,
  ForecastControls,
  ForecastLineResult,
  ForecastResult,
  ForecastSaleLine,
  PlatformCoverage,
  SaveForecastRunInput,
} from "@/lib/inventory-forecast/types";
import { db } from "@/lib/db";

const PLATFORM_LABELS: Record<Platform, string> = {
  TPP_EBAY: "eBay TPP",
  TT_EBAY: "eBay TT",
  SHOPIFY: "Shopify",
  BIGCOMMERCE: "BigCommerce",
};

export async function runInventoryForecast(input: {
  lookbackDays: number;
  forecastBucket: ForecastBucket;
  transitDays: number;
  desiredCoverageDays: number;
  useOpenInTransit: boolean;
  reorderRelevantOnly: boolean;
  mode?: "simple" | "smart";
  runDate?: string | Date;
}) {
  const runDate = normalizeRunDate(input.runDate);
  const controls: ForecastControls = {
    lookbackDays: input.lookbackDays,
    forecastBucket: input.forecastBucket,
    transitDays: input.transitDays,
    desiredCoverageDays: input.desiredCoverageDays,
    useOpenInTransit: input.useOpenInTransit,
    reorderRelevantOnly: input.reorderRelevantOnly,
    mode: input.mode ?? "smart",
  };

  const [syncState, inventoryRows, enabledIntegrations] = await Promise.all([
    syncSalesHistoryForLookback(input.lookbackDays),
    getForecastInventoryRows(),
    getEnabledForecastIntegrations(),
  ]);
  await captureDailyInventorySnapshots(runDate, inventoryRows);
  const arrivalDate = inventoryArrivalDate(runDate, input.transitDays);
  const masterRowIds = inventoryRows.map((row) => row.masterRowId);
  const [salesHistory, snapshotSignals, openInboundByMasterRowId, truncatedHistoryBySku] =
    await Promise.all([
      loadAggregatedSalesHistory(input.lookbackDays, runDate),
      getSnapshotSignals(masterRowIds, input.lookbackDays, runDate),
      getOpenInboundByMasterRowId(masterRowIds, arrivalDate),
      getTruncatedHistoryBySku(input.lookbackDays, syncState.truncatedPlatforms),
    ]);

  // Build coverage for ALL enabled integrations — not just those with data.
  // Platforms with no data show daysCovered: 0 so the UI can display "No data".
  const platformCoverage: PlatformCoverage[] = [];
  let oldestSaleDate: Date | null = null;
  for (const integration of enabledIntegrations) {
    const stats = salesHistory.platformStats.get(integration.platform);
    const daysCovered = stats?.earliest && stats.latest
      ? Math.round((stats.latest.getTime() - stats.earliest.getTime()) / (1000 * 60 * 60 * 24)) + 1
      : 0;
    platformCoverage.push({
      platform: integration.platform,
      label: PLATFORM_LABELS[integration.platform as keyof typeof PLATFORM_LABELS] ?? integration.label,
      lineCount: stats?.lineCount ?? 0,
      earliestDate: stats?.earliest?.toISOString().slice(0, 10) ?? null,
      latestDate: stats?.latest?.toISOString().slice(0, 10) ?? null,
      daysCovered,
    });
    if (stats?.earliest && (!oldestSaleDate || stats.earliest < oldestSaleDate)) {
      oldestSaleDate = stats.earliest;
    }
  }

  const actualDataDays = oldestSaleDate
    ? Math.round((runDate.getTime() - oldestSaleDate.getTime()) / (1000 * 60 * 60 * 24)) + 1
    : input.lookbackDays;
  const effectiveLookbackDays = Math.min(input.lookbackDays, actualDataDays);

  const lines = buildForecastResultLines({
    controls,
    effectiveLookbackDays,
    runDate,
    inventoryRows,
    salesBySku: salesHistory.salesBySku,
    openInboundByMasterRowId,
    snapshotSignalsByMasterRowId: snapshotSignals,
    truncatedPlatformsBySku: truncatedHistoryBySku,
  });

  const filteredLines = controls.reorderRelevantOnly
    ? lines.filter(isReorderRelevantLine)
    : lines;

  return {
    controls,
    effectiveLookbackDays,
    inventorySource: DEFAULT_FORECAST_INVENTORY_SOURCE,
    runDateTime: runDate.toISOString(),
    confidenceLegend: FORECAST_CONFIDENCE_LEGEND,
    lines: filteredLines,
    salesSync: {
      ...salesHistory.summary,
      issues: syncState.issues,
    },
    platformCoverage,
  } satisfies ForecastResult;
}

export interface UploadedSkuSale {
  sku: string;
  qty: number;
  platformQty: Record<string, number>;
}

export async function runInventoryForecastFromUpload(input: {
  lookbackDays: number;
  forecastBucket: ForecastBucket;
  transitDays: number;
  desiredCoverageDays: number;
  useOpenInTransit: boolean;
  reorderRelevantOnly: boolean;
  runDate?: string | Date;
  uploadedSales: UploadedSkuSale[];
}) {
  const runDate = normalizeRunDate(input.runDate);
  const controls: ForecastControls = {
    lookbackDays: input.lookbackDays,
    forecastBucket: input.forecastBucket,
    transitDays: input.transitDays,
    desiredCoverageDays: input.desiredCoverageDays,
    useOpenInTransit: input.useOpenInTransit,
    reorderRelevantOnly: input.reorderRelevantOnly,
    mode: "simple",
  };

  const inventoryRows = await getForecastInventoryRows();
  await captureDailyInventorySnapshots(runDate, inventoryRows);
  const arrivalDate = inventoryArrivalDate(runDate, input.transitDays);
  const masterRowIds = inventoryRows.map((row) => row.masterRowId);
  const [snapshotSignals, openInboundByMasterRowId] = await Promise.all([
    getSnapshotSignals(masterRowIds, input.lookbackDays, runDate),
    getOpenInboundByMasterRowId(masterRowIds, arrivalDate),
  ]);

  // Build synthetic ForecastSaleLine entries from uploaded data.
  // Spread sales evenly across the lookback period so the engine's
  // series bucketing produces reasonable results.
  const SYNTHETIC_POINTS = 7;
  const salesBySku = new Map<string, ForecastSaleLine[]>();
  const uploadedBySku = new Map(input.uploadedSales.map((s) => [s.sku, s]));

  for (const uploaded of input.uploadedSales) {
    const lines: ForecastSaleLine[] = [];
    const platforms = Object.entries(uploaded.platformQty).filter(([, q]) => q > 0);
    if (platforms.length === 0) continue;

    for (const [platformKey, platformTotal] of platforms) {
      const platform = (["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"].includes(platformKey)
        ? platformKey
        : "TPP_EBAY") as Platform;

      const perPoint = Math.floor(platformTotal / SYNTHETIC_POINTS);
      const remainder = platformTotal - perPoint * SYNTHETIC_POINTS;

      for (let i = 0; i < SYNTHETIC_POINTS; i++) {
        const dayOffset = Math.round((input.lookbackDays / (SYNTHETIC_POINTS + 1)) * (i + 1));
        const orderDate = new Date(runDate.getTime() - dayOffset * 24 * 60 * 60 * 1000);
        const qty = perPoint + (i === SYNTHETIC_POINTS - 1 ? remainder : 0);
        if (qty <= 0) continue;
        lines.push({
          platform,
          externalOrderId: `upload-${uploaded.sku}-${platformKey}-${i}`,
          externalLineId: `upload-${uploaded.sku}-${platformKey}-${i}`,
          orderDate,
          sku: uploaded.sku,
          title: null,
          quantity: qty,
          isCancelled: false,
          isReturn: false,
        });
      }
    }
    if (lines.length > 0) salesBySku.set(uploaded.sku, lines);
  }

  const platformCoverage: PlatformCoverage[] = [
    { platform: "TPP_EBAY", label: "eBay TPP", lineCount: 0, earliestDate: null, latestDate: null, daysCovered: 0 },
    { platform: "TT_EBAY", label: "eBay TT", lineCount: 0, earliestDate: null, latestDate: null, daysCovered: 0 },
    { platform: "SHOPIFY", label: "Shopify", lineCount: 0, earliestDate: null, latestDate: null, daysCovered: 0 },
    { platform: "BIGCOMMERCE", label: "BigCommerce", lineCount: 0, earliestDate: null, latestDate: null, daysCovered: 0 },
  ];
  for (const pc of platformCoverage) {
    const totalForPlatform = input.uploadedSales.reduce(
      (sum, s) => sum + (s.platformQty[pc.platform] ?? 0), 0,
    );
    if (totalForPlatform > 0) {
      pc.lineCount = totalForPlatform;
      pc.daysCovered = input.lookbackDays;
    }
  }

  const lines = buildForecastResultLines({
    controls,
    effectiveLookbackDays: input.lookbackDays,
    runDate,
    inventoryRows,
    salesBySku,
    openInboundByMasterRowId,
    snapshotSignalsByMasterRowId: snapshotSignals,
    truncatedPlatformsBySku: new Map(),
    isUploadedData: true,
  });

  const filteredLines = controls.reorderRelevantOnly
    ? lines.filter(isReorderRelevantLine)
    : lines;

  const skusMatched = input.uploadedSales.filter((s) => salesBySku.has(s.sku)).length;
  const skusUnmatched = input.uploadedSales.length - skusMatched;

  return {
    controls,
    effectiveLookbackDays: input.lookbackDays,
    inventorySource: DEFAULT_FORECAST_INVENTORY_SOURCE,
    runDateTime: runDate.toISOString(),
    confidenceLegend: FORECAST_CONFIDENCE_LEGEND,
    lines: filteredLines,
    salesSync: {
      earliestCoveredAt: null,
      latestCoveredAt: null,
      platformsSynced: [] as Platform[],
      issues: skusUnmatched > 0
        ? [{ platform: "TPP_EBAY" as Platform, level: "warning" as const, message: `${skusMatched} SKUs matched to dashboard rows. ${skusUnmatched} SKUs from the upload were not found in the dashboard and were ignored.` }]
        : [],
    },
    platformCoverage,
  } satisfies ForecastResult;
}

export async function saveInventoryForecastRun(input: SaveForecastRunInput) {
  const run = await db.forecastRun.create({
    data: {
      createdById: input.createdById ?? null,
      lookbackDays: input.result.controls.lookbackDays,
      forecastBucket: input.result.controls.forecastBucket,
      transitDays: input.result.controls.transitDays,
      desiredCoverageDays: input.result.controls.desiredCoverageDays,
      useOpenInTransit: input.result.controls.useOpenInTransit,
      showReorderRelevantOnly: input.result.controls.reorderRelevantOnly,
      mode: input.result.controls.mode,
      inventorySource: input.result.inventorySource,
      syncedSalesThrough: input.result.salesSync.latestCoveredAt
        ? new Date(input.result.salesSync.latestCoveredAt)
        : null,
      summary: {
        runDateTime: input.result.runDateTime,
        confidenceLegend: input.result.confidenceLegend,
        salesSync: input.result.salesSync,
        effectiveLookbackDays: input.result.effectiveLookbackDays,
        platformCoverage: input.result.platformCoverage,
      } as never,
      lines: {
        create: input.result.lines.map((line) => ({
          masterRowId: line.masterRowId,
          title: line.title,
          sku: line.sku,
          upc: line.upc,
          imageUrl: line.imageUrl,
          supplierCost: line.supplierCost ?? null,
          currentInventory: line.currentInventory,
          salesTotalUnits: line.salesTotalUnits,
          salesHistoryDays: line.salesHistoryDays,
          averageDailyDemand: line.averageDailyDemand,
          transitDemand: line.transitDemand,
          postArrivalDemand: line.postArrivalDemand,
          safetyBuffer: line.safetyBuffer,
          grossRequiredQty: line.grossRequiredQty,
          openInTransitQty: line.openInTransitQty,
          openInTransitEta: line.openInTransitEta ? new Date(line.openInTransitEta) : null,
          projectedStockOnArrival: line.projectedStockOnArrival,
          recommendedQty: line.recommendedQty,
          overrideQty: line.overrideQty,
          finalQty: line.finalQty,
          demandPattern: line.demandPattern,
          modelUsed: line.modelUsed,
          confidence: line.confidence,
          confidenceNote: line.confidenceNote,
          warningFlags: line.warningFlags as never,
          backtestError: line.backtestError,
          suspectedStockout: line.suspectedStockout,
          limitedHistory: line.limitedHistory,
          hasInbound: line.hasInbound,
        })),
      },
    },
    include: {
      lines: true,
    },
  });

  await db.auditLog.create({
    data: {
      action: "forecast_run_saved",
      entityType: "forecast_run",
      entityId: run.id,
      details: {
        lineCount: run.lines.length,
        lookbackDays: run.lookbackDays,
      },
    },
  });

  return run;
}

export async function createSupplierOrderFromForecast(input: {
  createdById?: string | null;
  forecastRunId?: string | null;
  orderName?: string | null;
  supplier?: string | null;
  eta?: string | Date | null;
  notes?: string | null;
  transitDays: number;
  lines: ForecastLineResult[];
}) {
  const draft: CreateSupplierOrderInput = {
    createdById: input.createdById ?? null,
    forecastRunId: input.forecastRunId ?? null,
    orderName: input.orderName ?? null,
    supplier: input.supplier ?? null,
    eta:
      input.eta != null
        ? normalizeRunDate(input.eta)
        : defaultEtaFromTransitDays(input.transitDays),
    notes: input.notes ?? null,
    status: "DRAFT",
    lines: input.lines
      .filter((line) => line.finalQty > 0)
      .sort((left, right) =>
        left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
      )
      .map((line) => ({
        masterRowId: line.masterRowId,
        sku: line.sku,
        title: line.title,
        supplierCost: line.supplierCost ?? null,
        systemRecommendedQty: line.recommendedQty,
        overrideQty: line.overrideQty,
        finalQty: line.finalQty,
      })),
  };

  return createSupplierOrderRecord(draft);
}

export async function getInventoryForecasterBootstrap() {
  const [recentRuns, recentOrders] = await Promise.all([
    db.forecastRun.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        createdAt: true,
        lookbackDays: true,
        forecastBucket: true,
        transitDays: true,
        desiredCoverageDays: true,
        lines: {
          select: { id: true },
        },
      },
    }),
    listRecentSupplierOrders(),
  ]);

  return {
    recentRuns: recentRuns.map((run) => ({
      id: run.id,
      createdAt: run.createdAt.toISOString(),
      lookbackDays: run.lookbackDays,
      forecastBucket: run.forecastBucket,
      transitDays: run.transitDays,
      desiredCoverageDays: run.desiredCoverageDays,
      lineCount: run.lines.length,
    })),
    recentOrders,
    inventorySource: DEFAULT_FORECAST_INVENTORY_SOURCE,
    confidenceLegend: FORECAST_CONFIDENCE_LEGEND,
  };
}

export async function patchSupplierOrder(input: {
  orderId: string;
  status?: "DRAFT" | "ORDERED" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  eta?: string | null;
  orderName?: string | null;
  supplier?: string | null;
  notes?: string | null;
}) {
  return updateSupplierOrderRecord({
    orderId: input.orderId,
    status: input.status,
    eta: input.eta ? normalizeRunDate(input.eta) : undefined,
    orderName: input.orderName,
    supplier: input.supplier,
    notes: input.notes,
  });
}

export async function getSupplierOrderForDownload(orderId: string) {
  return getSupplierOrderWithLines(orderId);
}

export async function getOrderExportData(orderId: string): Promise<ForecastResult | null> {
  const order = await db.supplierOrder.findUnique({
    where: { id: orderId },
    select: {
      forecastRunId: true,
      orderName: true,
      supplier: true,
      lines: { select: { masterRowId: true, finalQty: true } },
    },
  });
  if (!order?.forecastRunId) return null;

  const run = await db.forecastRun.findUnique({
    where: { id: order.forecastRunId },
    include: { lines: true },
  });
  if (!run) return null;

  const orderSkuSet = new Set(order.lines.map((l) => l.masterRowId));
  const orderQtyMap = new Map(order.lines.map((l) => [l.masterRowId, l.finalQty]));

  const summary = (run.summary ?? {}) as Record<string, unknown>;
  const salesSync = (summary.salesSync ?? {
    fetchedAt: null,
    earliestCoveredAt: null,
    latestCoveredAt: null,
    issues: [],
  }) as ForecastResult["salesSync"];

  const filteredLines: ForecastLineResult[] = run.lines
    .filter((l) => orderSkuSet.has(l.masterRowId))
    .map((l) => ({
      masterRowId: l.masterRowId,
      sku: l.sku,
      title: l.title ?? "",
      upc: l.upc,
      imageUrl: l.imageUrl,
      supplierCost: l.supplierCost,
      currentInventory: l.currentInventory,
      salesTotalUnits: l.salesTotalUnits,
      salesHistoryDays: l.salesHistoryDays,
      averageDailyDemand: l.averageDailyDemand,
      salesHistorySummary: `${l.salesTotalUnits} sold in ${l.salesHistoryDays}d`,
      salesByPlatform: [],
      transitDemand: l.transitDemand,
      postArrivalDemand: l.postArrivalDemand,
      safetyBuffer: l.safetyBuffer,
      grossRequiredQty: l.grossRequiredQty,
      openInTransitQty: l.openInTransitQty,
      openInTransitEta: l.openInTransitEta?.toISOString() ?? null,
      projectedStockOnArrival: l.projectedStockOnArrival,
      recommendedQty: l.recommendedQty,
      overrideQty: l.overrideQty,
      finalQty: orderQtyMap.get(l.masterRowId) ?? l.finalQty,
      demandPattern: l.demandPattern as ForecastLineResult["demandPattern"],
      modelUsed: l.modelUsed,
      confidence: l.confidence as ForecastLineResult["confidence"],
      confidenceNote: l.confidenceNote ?? "",
      warningFlags: (l.warningFlags ?? []) as ForecastLineResult["warningFlags"],
      backtestError: l.backtestError,
      suspectedStockout: l.suspectedStockout,
      limitedHistory: l.limitedHistory,
      hasInbound: l.hasInbound,
      bucketSeries: [],
    }));

  return {
    controls: {
      lookbackDays: run.lookbackDays,
      forecastBucket: run.forecastBucket,
      transitDays: run.transitDays,
      desiredCoverageDays: run.desiredCoverageDays,
      useOpenInTransit: run.useOpenInTransit,
      reorderRelevantOnly: false,
      mode: run.mode as ForecastResult["controls"]["mode"],
    },
    effectiveLookbackDays: (summary.effectiveLookbackDays as number) ?? run.lookbackDays,
    inventorySource: run.inventorySource as ForecastResult["inventorySource"],
    runDateTime: run.createdAt.toISOString(),
    confidenceLegend: (summary.confidenceLegend ?? {
      HIGH: "Strong history and model fit.",
      MEDIUM: "Usable but could improve with more data.",
      LOW: "Thin history or fallback logic.",
    }) as ForecastResult["confidenceLegend"],
    lines: filteredLines,
    salesSync,
    platformCoverage: (summary.platformCoverage as ForecastResult["platformCoverage"]) ?? [],
  };
}

export async function deleteSupplierOrder(orderId: string) {
  return deleteSupplierOrderRecord(orderId);
}
