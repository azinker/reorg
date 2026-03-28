import {
  addDays,
  eachDayOfInterval,
  endOfDay,
  endOfWeek,
  format,
  startOfDay,
  startOfWeek,
} from "date-fns";
import type {
  DemandPattern,
  ForecastBucket,
  ForecastConfidence,
} from "@prisma/client";
import type {
  ForecastControls,
  ForecastInventoryRow,
  ForecastLineResult,
  ForecastSaleLine,
  ForecastWarningFlag,
  OpenInboundSummary,
  SnapshotSignal,
} from "@/lib/inventory-forecast/types";

interface CandidateModel {
  key: string;
  label: string;
  minHistory: number;
  supportsPattern: (pattern: DemandPattern, seasonalEligible: boolean) => boolean;
  forecast: (series: number[], horizon: number, bucket: ForecastBucket) => number[];
}

interface PreparedSeries {
  series: number[];
  bucketDays: number;
  seriesStart: Date;
  seriesEnd: Date;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values: number[]) {
  if (values.length === 0) return 0;
  return sum(values) / values.length;
}

function standardDeviation(values: number[]) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((value) => (value - avg) ** 2);
  const variance = sum(squaredDiffs) / (values.length - 1);
  return Math.sqrt(variance);
}

function linearSlope(values: number[]) {
  if (values.length <= 1) return 0;
  const xs = values.map((_, index) => index + 1);
  const xAvg = mean(xs);
  const yAvg = mean(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    numerator += (xs[index] - xAvg) * (values[index] - yAvg);
    denominator += (xs[index] - xAvg) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

function autoCorrelation(values: number[], lag: number) {
  if (lag <= 0 || values.length <= lag) return 0;
  const source = values.slice(lag);
  const target = values.slice(0, values.length - lag);
  const sourceMean = mean(source);
  const targetMean = mean(target);
  let numerator = 0;
  let sourceVariance = 0;
  let targetVariance = 0;

  for (let index = 0; index < source.length; index += 1) {
    const sourceDelta = source[index] - sourceMean;
    const targetDelta = target[index] - targetMean;
    numerator += sourceDelta * targetDelta;
    sourceVariance += sourceDelta ** 2;
    targetVariance += targetDelta ** 2;
  }

  if (sourceVariance === 0 || targetVariance === 0) return 0;
  return numerator / Math.sqrt(sourceVariance * targetVariance);
}

function inferDemandPattern(
  series: number[],
  bucket: ForecastBucket,
  itemAgeDays: number,
): DemandPattern {
  const total = sum(series);
  const nonZero = series.filter((value) => value > 0);
  const nonZeroShare = series.length === 0 ? 0 : nonZero.length / series.length;
  const avg = mean(series);
  const slope = linearSlope(series);
  const cv = avg === 0 ? 0 : standardDeviation(series) / avg;
  const seasonalLag = bucket === "DAILY" ? 7 : 4;
  const seasonalScore = autoCorrelation(series, seasonalLag);

  const isGenuinelyNewItem = itemAgeDays < 45;

  if (series.length < 6 || total < 8) {
    if (isGenuinelyNewItem) return "NEW_ITEM";
    if (total === 0) return "SLOW_MOVER" as DemandPattern;
    return "INTERMITTENT";
  }
  if (nonZeroShare <= 0.4 || (nonZeroShare <= 0.55 && cv >= 1.2)) return "INTERMITTENT";
  if (series.length >= seasonalLag * 3 && seasonalScore >= 0.45) return "SEASONAL";
  if (Math.abs(slope) >= Math.max(0.25, avg * 0.12)) return "TRENDING";
  return "STABLE";
}

function recentAverageForecast(series: number[], horizon: number) {
  const window = series.slice(-Math.min(4, series.length));
  const baseline = mean(window);
  return Array.from({ length: horizon }, () => baseline);
}

function weightedMovingAverageForecast(series: number[], horizon: number) {
  const window = series.slice(-Math.min(6, series.length));
  const weights = window.map((_, index) => index + 1);
  const weightedSum = window.reduce((total, value, index) => total + value * weights[index], 0);
  const baseline = weightedSum / sum(weights);
  return Array.from({ length: horizon }, () => baseline);
}

function etsForecast(series: number[], horizon: number) {
  if (series.length === 0) return Array.from({ length: horizon }, () => 0);
  let level = series[0];
  let trend = series.length > 1 ? series[1] - series[0] : 0;
  const alpha = 0.55;
  const beta = 0.22;

  for (let index = 1; index < series.length; index += 1) {
    const value = series[index];
    const previousLevel = level;
    level = alpha * value + (1 - alpha) * (level + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
  }

  return Array.from({ length: horizon }, (_, index) =>
    Math.max(0, level + trend * (index + 1)),
  );
}

function seasonalNaiveForecast(series: number[], horizon: number, bucket: ForecastBucket) {
  const seasonLength = bucket === "DAILY" ? 7 : 4;
  if (series.length < seasonLength) return recentAverageForecast(series, horizon);
  return Array.from({ length: horizon }, (_, index) => {
    const pointer = series.length - seasonLength + (index % seasonLength);
    return Math.max(0, series[pointer] ?? 0);
  });
}

function crostonSbaForecast(series: number[], horizon: number) {
  const nonZeroEntries = series
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value > 0);
  if (nonZeroEntries.length === 0) {
    return Array.from({ length: horizon }, () => 0);
  }

  let demandEstimate = nonZeroEntries[0].value;
  let intervalEstimate = Math.max(1, nonZeroEntries[0].index + 1);
  let previousIndex = nonZeroEntries[0].index;
  const alpha = 0.2;

  for (let index = 1; index < nonZeroEntries.length; index += 1) {
    const entry = nonZeroEntries[index];
    const gap = entry.index - previousIndex;
    demandEstimate = alpha * entry.value + (1 - alpha) * demandEstimate;
    intervalEstimate = alpha * gap + (1 - alpha) * intervalEstimate;
    previousIndex = entry.index;
  }

  const croston = demandEstimate / Math.max(1, intervalEstimate);
  const sba = croston * (1 - alpha / 2);
  return Array.from({ length: horizon }, () => Math.max(0, sba));
}

function lowHistoryForecast(series: number[], horizon: number) {
  const baseline =
    series.length === 0
      ? 0
      : series.length === 1
      ? series[0]
      : mean(series.slice(-Math.min(2, series.length)));
  return Array.from({ length: horizon }, () => Math.max(0, baseline));
}

const CANDIDATE_MODELS: CandidateModel[] = [
  {
    key: "recent_average",
    label: "Recent average",
    minHistory: 2,
    supportsPattern: () => true,
    forecast: (series, horizon) => recentAverageForecast(series, horizon),
  },
  {
    key: "weighted_moving_average",
    label: "Weighted moving average",
    minHistory: 3,
    supportsPattern: () => true,
    forecast: (series, horizon) => weightedMovingAverageForecast(series, horizon),
  },
  {
    key: "ets_holt_linear",
    label: "ETS / exponential smoothing",
    minHistory: 4,
    supportsPattern: (pattern) => pattern === "STABLE" || pattern === "TRENDING",
    forecast: (series, horizon) => etsForecast(series, horizon),
  },
  {
    key: "seasonal_naive",
    label: "Seasonal method",
    minHistory: 12,
    supportsPattern: (_pattern, seasonalEligible) => seasonalEligible,
    forecast: (series, horizon, bucket) => seasonalNaiveForecast(series, horizon, bucket),
  },
  {
    key: "croston_sba",
    label: "Croston / SBA",
    minHistory: 4,
    supportsPattern: (pattern) => pattern === "INTERMITTENT" || pattern === "SLOW_MOVER",
    forecast: (series, horizon) => crostonSbaForecast(series, horizon),
  },
  {
    key: "low_history_fallback",
    label: "Low-history fallback",
    minHistory: 1,
    supportsPattern: () => true,
    forecast: (series, horizon) => lowHistoryForecast(series, horizon),
  },
];

function prepareSeries(
  sales: ForecastSaleLine[],
  lookbackDays: number,
  bucket: ForecastBucket,
  runDate: Date,
): PreparedSeries {
  const bucketDays = bucket === "DAILY" ? 1 : 7;
  const seriesEnd = endOfDay(runDate);
  const seriesStart = startOfDay(addDays(seriesEnd, -(lookbackDays - 1)));

  if (bucket === "DAILY") {
    const dates = eachDayOfInterval({ start: seriesStart, end: seriesEnd });
    const values = new Map<string, number>();
    for (const sale of sales) {
      const key = format(startOfDay(sale.orderDate), "yyyy-MM-dd");
      values.set(key, (values.get(key) ?? 0) + sale.quantity);
    }
    return {
      series: dates.map((date) => values.get(format(date, "yyyy-MM-dd")) ?? 0),
      bucketDays,
      seriesStart,
      seriesEnd,
    };
  }

  const weekStart = startOfWeek(seriesStart, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(seriesEnd, { weekStartsOn: 1 });
  const weeks: Date[] = [];
  for (let cursor = weekStart; cursor <= weekEnd; cursor = addDays(cursor, 7)) {
    weeks.push(cursor);
  }
  const values = new Map<string, number>();
  for (const sale of sales) {
    const key = format(startOfWeek(sale.orderDate, { weekStartsOn: 1 }), "yyyy-MM-dd");
    values.set(key, (values.get(key) ?? 0) + sale.quantity);
  }
  return {
    series: weeks.map((date) => values.get(format(date, "yyyy-MM-dd")) ?? 0),
    bucketDays,
    seriesStart,
    seriesEnd,
  };
}

function backtestError(
  series: number[],
  bucket: ForecastBucket,
  candidate: CandidateModel,
): number | null {
  if (series.length < Math.max(candidate.minHistory + 2, 6)) {
    return null;
  }

  const holdoutSize = clamp(Math.round(series.length * 0.2), 2, 8);
  const startIndex = series.length - holdoutSize;
  const errors: number[] = [];
  const actuals: number[] = [];

  for (let index = startIndex; index < series.length; index += 1) {
    const training = series.slice(0, index);
    if (training.length < candidate.minHistory) continue;
    const forecast = candidate.forecast(training, 1, bucket)[0] ?? 0;
    errors.push(Math.abs(forecast - series[index]));
    actuals.push(series[index]);
  }

  if (errors.length === 0) return null;
  const denominator = Math.max(1, sum(actuals));
  return sum(errors) / denominator;
}

function selectBestModel(series: number[], bucket: ForecastBucket, pattern: DemandPattern) {
  const seasonalEligible =
    (bucket === "DAILY" && series.length >= 21) || (bucket === "WEEKLY" && series.length >= 12);
  const supported = CANDIDATE_MODELS.filter(
    (candidate) =>
      series.length >= candidate.minHistory &&
      candidate.supportsPattern(pattern, seasonalEligible),
  );
  const candidates = supported.length > 0 ? supported : [CANDIDATE_MODELS[CANDIDATE_MODELS.length - 1]];

  let best = candidates[0];
  let bestError = Number.POSITIVE_INFINITY;
  let usedFallback = false;

  for (const candidate of candidates) {
    const error = backtestError(series, bucket, candidate);
    const score = error ?? Number.POSITIVE_INFINITY;
    if (score < bestError) {
      best = candidate;
      bestError = score;
    }
  }

  if (!Number.isFinite(bestError)) {
    best = CANDIDATE_MODELS[CANDIDATE_MODELS.length - 1];
    bestError = backtestError(series, bucket, best) ?? 1;
    usedFallback = true;
  }

  return {
    model: best,
    backtestError: Number.isFinite(bestError) ? round(bestError, 4) : null,
    usedFallback,
  };
}

function confidenceForLine(args: {
  lookbackDays: number;
  series: number[];
  backtestError: number | null;
  suspectedStockout: boolean;
  limitedHistory: boolean;
  truncatedHistory: boolean;
  pattern: DemandPattern;
  usedFallback: boolean;
}) {
  const totalHistory = args.series.length;
  const avg = mean(args.series);
  const volatility = avg === 0 ? 0 : standardDeviation(args.series) / avg;

  if (
    args.limitedHistory ||
    args.suspectedStockout ||
    args.truncatedHistory ||
    args.usedFallback ||
    args.pattern === "INTERMITTENT" ||
    args.pattern === "SLOW_MOVER" ||
    (args.backtestError != null && args.backtestError >= 0.35)
  ) {
    return {
      confidence: "LOW" as ForecastConfidence,
      note:
        args.suspectedStockout
          ? "Low confidence because recent stock snapshots suggest stockout distortion."
          : args.truncatedHistory
          ? "Low confidence because marketplace history does not fully cover the selected lookback yet."
          : args.limitedHistory
          ? "Low confidence because this SKU has limited history."
          : "Low confidence because fallback logic, intermittency, or higher forecast error reduced certainty.",
    };
  }

  if (
    totalHistory >= 12 &&
    (args.backtestError == null || args.backtestError <= 0.16) &&
    volatility <= 0.65
  ) {
    return {
      confidence: "HIGH" as ForecastConfidence,
      note: "High confidence because this SKU has solid history depth and stable backtest quality.",
    };
  }

  return {
    confidence: "MEDIUM" as ForecastConfidence,
    note: "Medium confidence because the forecast is usable, but volatility or history depth still leaves some uncertainty.",
  };
}

function safetyBufferForLine(args: {
  transitDemand: number;
  postArrivalDemand: number;
  backtestError: number | null;
  confidence: ForecastConfidence;
  pattern: DemandPattern;
  suspectedStockout: boolean;
}) {
  const grossBase = args.transitDemand + args.postArrivalDemand;
  let bufferRate =
    args.confidence === "HIGH" ? 0.05 : args.confidence === "MEDIUM" ? 0.08 : 0.12;

  if (args.backtestError != null) {
    bufferRate += clamp(args.backtestError, 0, 0.05);
  }
  if (args.pattern === "INTERMITTENT") bufferRate += 0.03;
  if (args.suspectedStockout) bufferRate += 0.03;

  return Math.max(0, Math.ceil(grossBase * clamp(bufferRate, 0.03, 0.2)));
}

function forecastSummary(totalUnits: number, lookbackDays: number) {
  const dailyRate = lookbackDays <= 0 ? 0 : totalUnits / lookbackDays;
  return `${totalUnits} total | ${lookbackDays}d | ${round(dailyRate, 1)}/day`;
}

function horizonInBuckets(days: number, bucketDays: number) {
  return Math.max(1, Math.ceil(days / bucketDays));
}

function sumForecast(model: CandidateModel, series: number[], bucket: ForecastBucket, days: number, bucketDays: number) {
  const buckets = horizonInBuckets(days, bucketDays);
  const forecast = model.forecast(series, buckets, bucket);
  return Math.max(0, round(sum(forecast)));
}

function roundOrderQuantity(value: number) {
  if (value <= 0) return 0;
  return Math.ceil(value);
}

export function buildForecastResultLines(args: {
  controls: ForecastControls;
  effectiveLookbackDays: number;
  runDate: Date;
  inventoryRows: ForecastInventoryRow[];
  salesBySku: Map<string, ForecastSaleLine[]>;
  openInboundByMasterRowId: Map<string, OpenInboundSummary>;
  snapshotSignalsByMasterRowId: Map<string, SnapshotSignal>;
  truncatedPlatformsBySku: Map<string, boolean>;
  overrideByMasterRowId?: Map<string, number | null>;
}) {
  const effectiveDays = args.effectiveLookbackDays;
  const lines: ForecastLineResult[] = args.inventoryRows.map((inventoryRow) => {
    const rawSales = (args.salesBySku.get(inventoryRow.sku) ?? [])
      .filter((sale) => !sale.isCancelled && !sale.isReturn)
      .sort((left, right) => left.orderDate.getTime() - right.orderDate.getTime());
    const prepared = prepareSeries(
      rawSales,
      effectiveDays,
      args.controls.forecastBucket,
      args.runDate,
    );
    const totalUnits = sum(prepared.series);

    const platformUnitsMap = new Map<string, number>();
    for (const sale of rawSales) {
      platformUnitsMap.set(sale.platform, (platformUnitsMap.get(sale.platform) ?? 0) + sale.quantity);
    }
    const limitedHistory = rawSales.length === 0 || totalUnits < 8 || prepared.series.filter((value) => value > 0).length < 4;
    const demandPattern = inferDemandPattern(prepared.series, args.controls.forecastBucket, inventoryRow.itemAgeDays);
    const { model, backtestError, usedFallback } = selectBestModel(
      prepared.series,
      args.controls.forecastBucket,
      demandPattern,
    );
    const inbound = args.openInboundByMasterRowId.get(inventoryRow.masterRowId) ?? {
      totalQty: 0,
      earliestEta: null,
      orderIds: [],
    };
    const snapshotSignal = args.snapshotSignalsByMasterRowId.get(inventoryRow.masterRowId) ?? {
      snapshotDaysAvailable: 0,
      suspectedStockout: false,
      nearZeroDays: 0,
    };
    const truncatedHistory = args.truncatedPlatformsBySku.get(inventoryRow.sku) ?? false;
    const confidenceInfo = confidenceForLine({
      lookbackDays: args.controls.lookbackDays,
      series: prepared.series,
      backtestError,
      suspectedStockout: snapshotSignal.suspectedStockout,
      limitedHistory,
      truncatedHistory,
      pattern: demandPattern,
      usedFallback,
    });
    const isSimple = args.controls.mode === "simple";
    const dailyRate = totalUnits / Math.max(1, effectiveDays);
    const flatTransit = round(dailyRate * args.controls.transitDays);
    const flatPostArrival = round(dailyRate * args.controls.desiredCoverageDays);

    const MODEL_DIVERGENCE_CAP = 1.5;
    const transitDemand = isSimple
      ? flatTransit
      : Math.min(
          sumForecast(model, prepared.series, args.controls.forecastBucket, args.controls.transitDays, prepared.bucketDays),
          Math.max(flatTransit * MODEL_DIVERGENCE_CAP, flatTransit + 2),
        );
    const postArrivalDemand = isSimple
      ? flatPostArrival
      : Math.min(
          sumForecast(model, prepared.series, args.controls.forecastBucket, args.controls.desiredCoverageDays, prepared.bucketDays),
          Math.max(flatPostArrival * MODEL_DIVERGENCE_CAP, flatPostArrival + 2),
        );
    const safetyBuffer = isSimple
      ? 0
      : safetyBufferForLine({
          transitDemand,
          postArrivalDemand,
          backtestError,
          confidence: confidenceInfo.confidence,
          pattern: demandPattern,
          suspectedStockout: snapshotSignal.suspectedStockout,
        });
    const grossRequiredQty = Math.max(0, Math.ceil(transitDemand + postArrivalDemand + safetyBuffer));
    const openInTransitQty = args.controls.useOpenInTransit ? inbound.totalQty : 0;
    const projectedStockOnArrival = Math.max(
      0,
      round(inventoryRow.currentInventory - transitDemand + openInTransitQty),
    );
    const recommendedQty = roundOrderQuantity(
      Math.max(0, Math.ceil(grossRequiredQty - inventoryRow.currentInventory - openInTransitQty)),
    );
    const overrideQty = args.overrideByMasterRowId?.get(inventoryRow.masterRowId) ?? null;
    const finalQty = overrideQty == null ? recommendedQty : Math.max(0, Math.round(overrideQty));

    const warningFlags: ForecastWarningFlag[] = [];
    if (confidenceInfo.confidence === "LOW") warningFlags.push("LOW_CONFIDENCE");
    if (snapshotSignal.suspectedStockout && totalUnits > 0) warningFlags.push("SUSPECTED_STOCKOUT");
    if (limitedHistory) warningFlags.push("LIMITED_HISTORY");
    if (openInTransitQty > 0) warningFlags.push("IN_TRANSIT_EXISTS");
    if (truncatedHistory) warningFlags.push("EBAY_HISTORY_TRUNCATED");
    if (totalUnits === 0) warningFlags.push("NO_SALES_HISTORY");

    return {
      masterRowId: inventoryRow.masterRowId,
      sku: inventoryRow.sku,
      title: inventoryRow.title,
      upc: inventoryRow.upc,
      imageUrl: inventoryRow.imageUrl,
      supplierCost: inventoryRow.supplierCost,
      currentInventory: inventoryRow.currentInventory,
      salesTotalUnits: totalUnits,
      salesHistoryDays: effectiveDays,
      averageDailyDemand: round(totalUnits / Math.max(1, effectiveDays), 3),
      salesHistorySummary: forecastSummary(totalUnits, effectiveDays),
      salesByPlatform: [...platformUnitsMap.entries()].map(([platform, units]) => ({
        platform: platform as ForecastSaleLine["platform"],
        label: platform,
        units,
      })),
      transitDemand,
      postArrivalDemand,
      safetyBuffer,
      grossRequiredQty,
      openInTransitQty,
      openInTransitEta: inbound.earliestEta,
      projectedStockOnArrival,
      recommendedQty,
      overrideQty,
      finalQty,
      demandPattern,
      modelUsed: isSimple ? "Flat Average" : model.label,
      confidence: isSimple ? ("HIGH" as ForecastConfidence) : confidenceInfo.confidence,
      confidenceNote: isSimple ? "Simple mode uses a flat daily average." : confidenceInfo.note,
      warningFlags,
      backtestError,
      suspectedStockout: snapshotSignal.suspectedStockout,
      limitedHistory,
      hasInbound: openInTransitQty > 0,
      bucketSeries: prepared.series,
    };
  });

  return lines.sort((left, right) =>
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
  );
}

export function isReorderRelevantLine(line: ForecastLineResult) {
  return line.finalQty > 0 || line.openInTransitQty > 0;
}

export const FORECAST_CONFIDENCE_LEGEND: Record<ForecastConfidence, string> = {
  HIGH: "High confidence means this SKU has enough usable history and the selected model backtested cleanly.",
  MEDIUM:
    "Medium confidence means the forecast is useful, but volatility or thinner history leaves moderate uncertainty.",
  LOW: "Low confidence means limited history, stockout risk, fallback logic, or weaker backtesting reduced reliability.",
};

export function inferSnapshotSignal(snapshots: Array<{ snapshotDate: Date; quantity: number }>, runDate: Date, lookbackDays: number): SnapshotSignal {
  const windowStart = startOfDay(addDays(runDate, -(lookbackDays - 1)));
  const relevant = snapshots.filter((snapshot) => snapshot.snapshotDate >= windowStart);
  const nearZeroDays = relevant.filter((snapshot) => snapshot.quantity <= 1).length;
  return {
    snapshotDaysAvailable: relevant.length,
    suspectedStockout: nearZeroDays >= 2,
    nearZeroDays,
  };
}

export function normalizeRunDate(runDate?: Date | string) {
  const parsed = runDate instanceof Date ? runDate : runDate ? new Date(runDate) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function inventoryArrivalDate(runDate: Date, transitDays: number) {
  return startOfDay(addDays(runDate, transitDays));
}

export function lookbackWindowStart(runDate: Date, lookbackDays: number) {
  return startOfDay(addDays(runDate, -(lookbackDays - 1)));
}

export function salesLineFallsWithinLookback(sale: ForecastSaleLine, runDate: Date, lookbackDays: number) {
  const start = lookbackWindowStart(runDate, lookbackDays);
  return sale.orderDate >= start && sale.orderDate <= endOfDay(runDate);
}
