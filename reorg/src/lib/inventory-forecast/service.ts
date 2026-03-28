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
  getOpenInboundByMasterRowId,
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
import { captureDailyInventorySnapshots, getSnapshotSignals } from "@/lib/inventory-forecast/snapshots";
import type { Platform } from "@prisma/client";
import type {
  CreateSupplierOrderInput,
  ForecastControls,
  ForecastLineResult,
  ForecastResult,
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

  const [syncState, inventoryRows] = await Promise.all([
    syncSalesHistoryForLookback(input.lookbackDays),
    getForecastInventoryRows(),
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

  const platformCoverage: PlatformCoverage[] = [];
  let oldestSaleDate: Date | null = null;
  for (const [platform, stats] of salesHistory.platformStats) {
    const daysCovered = stats.earliest && stats.latest
      ? Math.round((stats.latest.getTime() - stats.earliest.getTime()) / (1000 * 60 * 60 * 24)) + 1
      : 0;
    platformCoverage.push({
      platform: platform as Platform,
      label: PLATFORM_LABELS[platform as Platform] ?? platform,
      lineCount: stats.lineCount,
      earliestDate: stats.earliest?.toISOString().slice(0, 10) ?? null,
      latestDate: stats.latest?.toISOString().slice(0, 10) ?? null,
      daysCovered,
    });
    if (stats.earliest && (!oldestSaleDate || stats.earliest < oldestSaleDate)) {
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
  supplier?: string | null;
  eta?: string | Date | null;
  notes?: string | null;
  transitDays: number;
  lines: ForecastLineResult[];
}) {
  const draft: CreateSupplierOrderInput = {
    createdById: input.createdById ?? null,
    forecastRunId: input.forecastRunId ?? null,
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
  supplier?: string | null;
  notes?: string | null;
}) {
  return updateSupplierOrderRecord({
    orderId: input.orderId,
    status: input.status,
    eta: input.eta ? normalizeRunDate(input.eta) : undefined,
    supplier: input.supplier,
    notes: input.notes,
  });
}
