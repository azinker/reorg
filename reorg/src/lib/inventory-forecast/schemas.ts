import { z } from "zod";

export const forecastControlsSchema = z.object({
  lookbackDays: z.number().int().min(1).max(365),
  forecastBucket: z.enum(["DAILY", "WEEKLY"]),
  transitDays: z.number().int().min(0).max(365),
  desiredCoverageDays: z.number().int().min(0).max(730),
  useOpenInTransit: z.boolean(),
  reorderRelevantOnly: z.boolean(),
  mode: z.literal("balanced"),
});

export const forecastLineSchema = z.object({
  masterRowId: z.string().min(1),
  sku: z.string().min(1),
  title: z.string(),
  upc: z.string().nullable(),
  imageUrl: z.string().nullable(),
  supplierCost: z.number().nullable(),
  currentInventory: z.number().int(),
  salesTotalUnits: z.number().int(),
  salesHistoryDays: z.number().int(),
  averageDailyDemand: z.number(),
  salesHistorySummary: z.string(),
  transitDemand: z.number(),
  postArrivalDemand: z.number(),
  safetyBuffer: z.number(),
  grossRequiredQty: z.number(),
  openInTransitQty: z.number().int(),
  openInTransitEta: z.string().nullable(),
  projectedStockOnArrival: z.number(),
  recommendedQty: z.number().int(),
  overrideQty: z.number().int().nullable(),
  finalQty: z.number().int(),
  demandPattern: z.enum(["STABLE", "TRENDING", "SEASONAL", "INTERMITTENT", "NEW_ITEM"]),
  modelUsed: z.string(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  confidenceNote: z.string(),
  warningFlags: z.array(
    z.enum([
      "LOW_CONFIDENCE",
      "SUSPECTED_STOCKOUT",
      "LIMITED_HISTORY",
      "IN_TRANSIT_EXISTS",
      "EBAY_HISTORY_TRUNCATED",
      "NO_SALES_HISTORY",
    ]),
  ),
  backtestError: z.number().nullable(),
  suspectedStockout: z.boolean(),
  limitedHistory: z.boolean(),
  hasInbound: z.boolean(),
  bucketSeries: z.array(z.number()),
});

export const forecastResultSchema = z.object({
  controls: forecastControlsSchema,
  inventorySource: z.enum(["MASTER_TPP_LIVE"]),
  runDateTime: z.string(),
  confidenceLegend: z.record(z.enum(["HIGH", "MEDIUM", "LOW"]), z.string()),
  lines: z.array(forecastLineSchema),
  salesSync: z.object({
    earliestCoveredAt: z.string().nullable(),
    latestCoveredAt: z.string().nullable(),
    platformsSynced: z.array(z.enum(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"])),
    issues: z.array(
      z.object({
        platform: z.enum(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]),
        level: z.enum(["warning", "error"]),
        message: z.string(),
      }),
    ),
  }),
});
