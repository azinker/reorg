import { endOfDay, format, startOfDay, startOfWeek, subDays } from "date-fns";
import type { Platform, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  replaceRevenueFinancialEventsForRange,
  replaceSalesHistoryLinesForRange,
} from "@/lib/inventory-forecast/sales-history-service";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { fetchMarketplaceRevenue } from "@/lib/revenue/marketplace-revenue";
import { runWithMarketplaceTelemetry } from "@/lib/server/marketplace-telemetry";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";
import type {
  RevenueFeeBreakdownRow,
  RevenueGrowthCard,
  RevenueIntegrationOption,
  RevenueKpiMetric,
  RevenueKpiSummary,
  RevenueMetricExactness,
  RevenueMetricMode,
  RevenuePageData,
  RevenueQueryFilters,
  RevenueSourceSummary,
  RevenueStoreBreakdownRow,
  RevenueSyncJobSummary,
  RevenueSyncRequest,
  RevenueSyncResult,
  RevenueSyncStageSummary,
  RevenueSyncSummary,
  RevenueSimpleWindow,
  RevenueTopBuyerRow,
  RevenueTopItemRow,
  RevenueTrendPoint,
} from "@/lib/revenue";
import { PLATFORM_FULL } from "@/lib/grid-types";

export class RevenueServiceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "RevenueServiceError";
    this.status = status;
  }
}

export type AuthenticatedRevenueUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: string;
};

type RevenueIntegrationRecord = {
  id: string;
  platform: Platform;
  label: string;
  config: Prisma.JsonValue;
};

type RevenueSyncJobRecord = {
  id: string;
  integrationId: string;
  platform: Platform;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: Date | null;
  completedAt: Date | null;
  ordersProcessed: number;
  linesProcessed: number;
  warningCount: number;
  errorSummary: string | null;
  metadata: Prisma.JsonValue;
  integration: { label: string };
};

type QueuedRevenueSyncResult = RevenueSyncResult & {
  queuedJobIds: string[];
};

type RevenueLineRow = {
  id: string;
  platform: Platform;
  orderDate: Date;
  sku: string;
  title: string | null;
  quantity: number;
  unitPriceAmount: number | null;
  grossRevenueAmount: number | null;
  marketplaceFeeAmount: number | null;
  advertisingFeeAmount: number | null;
  otherFeeAmount: number | null;
  netRevenueAmount: number | null;
  marketplaceSaleOrder: {
    id: string;
    externalOrderId: string;
    grossRevenueAmount: number | null;
    shippingCollectedAmount: number | null;
    taxCollectedAmount: number | null;
    buyerIdentifier: string | null;
    buyerDisplayLabel: string | null;
    buyerEmail: string | null;
  };
};

type RevenueFinancialEventRow = {
  id: string;
  platform: Platform;
  classification:
    | "SALE"
    | "TAX"
    | "MARKETPLACE_FEE"
    | "ADVERTISING_FEE"
    | "SHIPPING_LABEL"
    | "ACCOUNT_LEVEL_FEE"
    | "CREDIT"
    | "OTHER";
  occurredAt: Date;
  amount: number;
  externalOrderId: string | null;
};

type MutableOrderAggregation = {
  id: string;
  platform: Platform;
  label: string;
  buyerKey: string;
  buyerIdentifier: string;
  buyerName: string | null;
  buyerLabel: string;
  buyerEmail: string | null;
  grossRevenue: number;
  hasStoredGrossRevenue: boolean;
  netRevenueKnown: number;
  hasMissingNetData: boolean;
  shippingCollected: number;
  taxCollected: number;
};

type MutableBuyerAggregation = {
  buyerKey: string;
  buyerIdentifier: string;
  buyerName: string | null;
  buyerLabel: string;
  buyerEmail: string | null;
  platforms: Set<Platform>;
  orderCount: number;
  grossRevenue: number;
  netRevenueKnown: number;
  hasMissingNetData: boolean;
};

type MutableItemAggregation = {
  sku: string;
  title: string | null;
  platforms: Set<Platform>;
  unitsSold: number;
  grossRevenue: number;
  netRevenueKnown: number;
  hasMissingNetData: boolean;
};

type MutableTrendAggregation = {
  bucketStart: Date;
  bucketLabel: string;
  grossRevenue: number;
  taxCollected: number;
  marketplaceFees: number;
  advertisingFees: number;
  shippingLabels: number;
  accountLevelFees: number;
  otherCosts: number;
  orderIds: Set<string>;
};

type TopTablesAggregation = {
  topBuyers: RevenueTopBuyerRow[];
  topItems: RevenueTopItemRow[];
};

type PeriodAggregation = {
  mode: RevenueMetricMode;
  hasAnyRevenueData: boolean;
  grossRevenue: number;
  netRevenue: number | null;
  marketplaceFees: number | null;
  advertisingFees: number | null;
  taxCollected: number;
  shippingCollected: number;
  shippingLabels: number | null;
  accountLevelFees: number | null;
  orderCount: number;
  averageOrderValue: number | null;
  exactnessByMetric: Record<string, RevenueMetricExactness>;
  coverageByMetric: Record<string, RevenueMetricExactness>;
  unavailableReasons: Record<string, string | null>;
  sourceSummary: RevenueSourceSummary | null;
  trend: RevenueTrendPoint[];
  storeBreakdown: RevenueStoreBreakdownRow[];
  feeBreakdown: RevenueFeeBreakdownRow[];
  revenueShare: Array<{ platform: Platform; label: string; grossRevenue: number }>;
};

const EXACT_EBAY_PLATFORMS = new Set<Platform>(["TPP_EBAY", "TT_EBAY"]);
const DEFAULT_EBAY_REPORTING_TIMEZONE = "America/Los_Angeles";

function requireRevenueAccess(user: AuthenticatedRevenueUser | null | undefined) {
  if (!user?.id) throw new RevenueServiceError("Unauthorized", 401);
}

function safeNumber(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value : null;
}

function metricWithDelta(
  currentValue: number | null,
  previousValue: number | null,
  exactness: RevenueMetricExactness,
  unavailableReason?: string | null,
): RevenueKpiMetric {
  const deltaPercent =
    currentValue != null &&
    previousValue != null &&
    previousValue !== 0
      ? ((currentValue - previousValue) / previousValue) * 100
      : null;

  return {
    value: currentValue,
    previousValue,
    deltaPercent,
    exact: exactness === "exact",
    unavailableReason: unavailableReason ?? null,
  };
}

function toTitleChoice(current: string | null, incoming: string | null) {
  if (current?.trim()) return current;
  if (incoming?.trim()) return incoming;
  return current ?? incoming ?? null;
}

function daysFromSimpleWindow(window: RevenueSimpleWindow) {
  if (window === "3d") return 3;
  if (window === "7d") return 7;
  if (window === "15d") return 15;
  return 30;
}

function rangeForSimpleWindow(toIso: string, window: RevenueSimpleWindow) {
  const end = endOfDay(new Date(toIso));
  const start = startOfDay(subDays(end, daysFromSimpleWindow(window) - 1));
  return { from: start.toISOString(), to: end.toISOString() };
}

function getLocalDateTimeParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getLocalDateTimeParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

function zonedDateTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

function toUtcDateParts(date: Date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function normalizeRangeToTimeZoneDayBounds(fromIso: string, toIso: string, timeZone: string) {
  const fromParts = toUtcDateParts(new Date(fromIso));
  const toParts = toUtcDateParts(new Date(toIso));
  return {
    from: zonedDateTimeToUtc(
      timeZone,
      fromParts.year,
      fromParts.month,
      fromParts.day,
      0,
      0,
      0,
    ),
    to: zonedDateTimeToUtc(timeZone, toParts.year, toParts.month, toParts.day, 23, 59, 59),
  };
}

function toTimeZoneCalendarDate(date: Date, timeZone: string) {
  const parts = getLocalDateTimeParts(date, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
}

function bucketStartForDate(
  date: Date,
  granularity: RevenueQueryFilters["granularity"],
  timeZone?: string,
) {
  if (!timeZone) {
    return granularity === "week" ? startOfWeek(date, { weekStartsOn: 1 }) : startOfDay(date);
  }

  const localCalendarDate = toTimeZoneCalendarDate(date, timeZone);
  return granularity === "week"
    ? startOfWeek(localCalendarDate, { weekStartsOn: 1 })
    : localCalendarDate;
}

function bucketLabelForDate(date: Date) {
  return format(date, "MMM d");
}

function parseSourceSummary(value: unknown): RevenueSourceSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const readNumber = (key: keyof RevenueSourceSummary) =>
    typeof record[key] === "number" && Number.isFinite(record[key]) ? (record[key] as number) : null;

  return {
    grossRevenue: readNumber("grossRevenue"),
    taxCollected: readNumber("taxCollected"),
    sellingCosts: readNumber("sellingCosts"),
    marketplaceFees: readNumber("marketplaceFees"),
    advertisingFees: readNumber("advertisingFees"),
    shippingLabels: readNumber("shippingLabels"),
    accountLevelFees: readNumber("accountLevelFees"),
    netRevenue: readNumber("netRevenue"),
    currencyCode: typeof record.currencyCode === "string" ? record.currencyCode : null,
  };
}

function parseSyncStages(value: unknown): RevenueSyncStageSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const status =
      record.status === "PENDING" ||
      record.status === "RUNNING" ||
      record.status === "COMPLETED" ||
      record.status === "FAILED"
        ? record.status
        : null;
    if (!status || typeof record.key !== "string" || typeof record.label !== "string") return [];
    return [{
      key: record.key,
      label: record.label,
      status,
      detail: typeof record.detail === "string" ? record.detail : null,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    }];
  });
}

function formatRevenueJob(job: {
  id: string;
  integrationId: string;
  platform: Platform;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  startedAt: Date | null;
  completedAt: Date | null;
  ordersProcessed: number;
  linesProcessed: number;
  warningCount: number;
  errorSummary: string | null;
  metadata: Prisma.JsonValue;
  integration: { label: string };
}): RevenueSyncJobSummary {
  const metadata =
    job.metadata && typeof job.metadata === "object" && !Array.isArray(job.metadata)
      ? (job.metadata as Record<string, unknown>)
      : {};

  return {
    id: job.id,
    integrationId: job.integrationId,
    platform: job.platform,
    label: job.integration.label,
    status: job.status,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    ordersProcessed: job.ordersProcessed,
    linesProcessed: job.linesProcessed,
    warningCount: job.warningCount,
    errorSummary: job.errorSummary,
    syncStages: parseSyncStages(metadata.syncStages),
    sourceSummary: parseSourceSummary(metadata.sourceSummary),
  };
}

async function queueRevenueSyncJobs(
  userId: string,
  request: RevenueSyncRequest,
  integrations: RevenueIntegrationRecord[],
): Promise<{
  jobs: RevenueSyncJobRecord[];
  queuedJobIds: string[];
  warnings: string[];
}> {
  const runningJobs = await db.revenueSyncJob.findMany({
    where: {
      integrationId: { in: integrations.map((integration) => integration.id) },
      status: { in: ["PENDING", "RUNNING"] },
    },
    include: { integration: { select: { label: true } } },
    orderBy: { createdAt: "desc" },
  });

  const runningByIntegration = new Map<string, RevenueSyncJobRecord>();
  for (const job of runningJobs) {
    if (runningByIntegration.has(job.integrationId)) continue;
    runningByIntegration.set(job.integrationId, job);
  }

  const integrationsToQueue = integrations.filter(
    (integration) => !runningByIntegration.has(integration.id),
  );

  const queuedJobs = await Promise.all(
    integrationsToQueue.map((integration) =>
      db.revenueSyncJob.create({
        data: {
          integrationId: integration.id,
          platform: integration.platform,
          triggeredByUserId: userId,
          status: "PENDING",
          metadata: {
            requestedRange: { from: request.from, to: request.to },
            syncStages: [],
          } as unknown as Prisma.InputJsonValue,
        },
        include: { integration: { select: { label: true } } },
      }),
    ),
  );

  return {
    jobs: [...runningByIntegration.values(), ...queuedJobs],
    queuedJobIds: queuedJobs.map((job) => job.id),
    warnings: [...runningByIntegration.values()].map(
      (job) => `${job.integration.label}: revenue refresh is already queued or running.`,
    ),
  };
}

async function getEnabledRevenueIntegrations(): Promise<RevenueIntegrationRecord[]> {
  return db.integration.findMany({
    where: {
      enabled: true,
      platform: { in: ["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"] },
    },
    select: { id: true, platform: true, label: true, config: true },
    orderBy: { createdAt: "asc" },
  });
}

function toIntegrationOptions(integrations: RevenueIntegrationRecord[]): RevenueIntegrationOption[] {
  return integrations.map((integration) => ({
    id: integration.id,
    platform: integration.platform,
    label: integration.label,
  }));
}

async function getRevenueSyncIntegrations(
  request: RevenueSyncRequest,
): Promise<RevenueIntegrationRecord[]> {
  const integrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: {
        in: request.platforms.length ? request.platforms : ["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"],
      },
    },
    select: { id: true, platform: true, label: true, config: true },
    orderBy: { createdAt: "asc" },
  });

  if (integrations.length === 0) {
    throw new RevenueServiceError("No enabled integrations are available for revenue sync.", 400);
  }

  return integrations;
}

function normalizeSelectedPlatforms(
  integrations: RevenueIntegrationRecord[],
  requestedPlatforms: Platform[],
) {
  const enabledPlatforms = integrations.map((integration) => integration.platform);
  if (requestedPlatforms.length === 0) return enabledPlatforms;
  return requestedPlatforms.filter((platform) => enabledPlatforms.includes(platform));
}

function isSingleStoreEbayExactMode(platforms: Platform[]) {
  return platforms.length === 1 && EXACT_EBAY_PLATFORMS.has(platforms[0]);
}

async function loadRevenueLines(from: Date, to: Date, platforms: Platform[]): Promise<RevenueLineRow[]> {
  return db.marketplaceSaleLine.findMany({
    where: {
      platform: { in: platforms },
      orderDate: { gte: from, lte: to },
      isCancelled: false,
      isReturn: false,
    },
    select: {
      id: true,
      platform: true,
      orderDate: true,
      sku: true,
      title: true,
      quantity: true,
      unitPriceAmount: true,
      grossRevenueAmount: true,
      marketplaceFeeAmount: true,
      advertisingFeeAmount: true,
      otherFeeAmount: true,
      netRevenueAmount: true,
      marketplaceSaleOrder: {
        select: {
          id: true,
          externalOrderId: true,
          grossRevenueAmount: true,
          shippingCollectedAmount: true,
          taxCollectedAmount: true,
          buyerIdentifier: true,
          buyerDisplayLabel: true,
          buyerEmail: true,
        },
      },
    },
  });
}

async function loadRevenueFinancialEvents(
  integrationId: string,
  from: Date,
  to: Date,
): Promise<RevenueFinancialEventRow[]> {
  return db.revenueFinancialEvent.findMany({
    where: { integrationId, occurredAt: { gte: from, lte: to } },
    select: {
      id: true,
      platform: true,
      classification: true,
      occurredAt: true,
      amount: true,
      externalOrderId: true,
    },
  });
}

function aggregateOrdersFromLines(lines: RevenueLineRow[]) {
  const orders = new Map<string, MutableOrderAggregation>();

  for (const line of lines) {
    const lineGross =
      safeNumber(line.grossRevenueAmount) ??
      (safeNumber(line.unitPriceAmount) != null ? (line.unitPriceAmount as number) * line.quantity : 0);
    const lineNet = safeNumber(line.netRevenueAmount);
    const buyerIdentifier =
      line.marketplaceSaleOrder.buyerIdentifier ??
      line.marketplaceSaleOrder.buyerEmail ??
      line.marketplaceSaleOrder.externalOrderId;
    const buyerKey = `${line.platform}:${buyerIdentifier}`;

    const order =
      orders.get(line.marketplaceSaleOrder.id) ??
      {
        id: line.marketplaceSaleOrder.id,
        platform: line.platform,
        label: PLATFORM_FULL[line.platform],
        buyerKey,
        buyerIdentifier,
        buyerName: line.marketplaceSaleOrder.buyerDisplayLabel,
        buyerLabel:
          line.marketplaceSaleOrder.buyerDisplayLabel ??
          line.marketplaceSaleOrder.buyerIdentifier ??
          line.marketplaceSaleOrder.buyerEmail ??
          line.marketplaceSaleOrder.externalOrderId,
        buyerEmail: line.marketplaceSaleOrder.buyerEmail,
        grossRevenue: safeNumber(line.marketplaceSaleOrder.grossRevenueAmount) ?? 0,
        hasStoredGrossRevenue: safeNumber(line.marketplaceSaleOrder.grossRevenueAmount) != null,
        netRevenueKnown: 0,
        hasMissingNetData: false,
        shippingCollected: safeNumber(line.marketplaceSaleOrder.shippingCollectedAmount) ?? 0,
        taxCollected: safeNumber(line.marketplaceSaleOrder.taxCollectedAmount) ?? 0,
      };

    if (!order.hasStoredGrossRevenue) order.grossRevenue += lineGross;
    if (lineNet != null) order.netRevenueKnown += lineNet;
    else if (lineGross > 0) order.hasMissingNetData = true;
    orders.set(line.marketplaceSaleOrder.id, order);
  }

  return orders;
}

async function aggregateTopTables(filters: RevenueQueryFilters): Promise<TopTablesAggregation> {
  const lines = await loadRevenueLines(new Date(filters.from), new Date(filters.to), filters.platforms);
  const orders = aggregateOrdersFromLines(lines);
  const buyers = new Map<string, MutableBuyerAggregation>();
  const items = new Map<string, MutableItemAggregation>();

  for (const line of lines) {
    const lineGross =
      safeNumber(line.grossRevenueAmount) ??
      (safeNumber(line.unitPriceAmount) != null ? (line.unitPriceAmount as number) * line.quantity : 0);
    const lineNet = safeNumber(line.netRevenueAmount);

    const item =
      items.get(line.sku) ??
      {
        sku: line.sku,
        title: line.title,
        platforms: new Set<Platform>(),
        unitsSold: 0,
        grossRevenue: 0,
        netRevenueKnown: 0,
        hasMissingNetData: false,
      };
    item.title = toTitleChoice(item.title, line.title);
    item.platforms.add(line.platform);
    item.unitsSold += line.quantity;
    item.grossRevenue += lineGross;
    if (lineNet != null) item.netRevenueKnown += lineNet;
    else if (lineGross > 0) item.hasMissingNetData = true;
    items.set(line.sku, item);
  }

  for (const order of orders.values()) {
    const buyer =
      buyers.get(order.buyerKey) ??
      {
        buyerKey: order.buyerKey,
        buyerIdentifier: order.buyerIdentifier,
        buyerName: order.buyerName,
        buyerLabel: order.buyerLabel,
        buyerEmail: order.buyerEmail,
        platforms: new Set<Platform>(),
        orderCount: 0,
        grossRevenue: 0,
        netRevenueKnown: 0,
        hasMissingNetData: false,
      };
    buyer.platforms.add(order.platform);
    buyer.orderCount += 1;
    buyer.grossRevenue += order.grossRevenue;
    buyer.netRevenueKnown += order.netRevenueKnown;
    if (order.hasMissingNetData) buyer.hasMissingNetData = true;
    buyers.set(order.buyerKey, buyer);
  }

  return {
    topBuyers: [...buyers.values()]
      .sort((a, b) => b.grossRevenue - a.grossRevenue)
      .slice(0, 12)
      .map((buyer) => ({
        buyerKey: buyer.buyerKey,
        buyerIdentifier: buyer.buyerIdentifier,
        buyerName: buyer.buyerName,
        buyerLabel: buyer.buyerLabel,
        buyerEmail: buyer.buyerEmail,
        platforms: [...buyer.platforms],
        orderCount: buyer.orderCount,
        grossRevenue: buyer.grossRevenue,
        netRevenue: buyer.hasMissingNetData ? null : buyer.netRevenueKnown,
      })),
    topItems: [...items.values()]
      .sort((a, b) => b.unitsSold - a.unitsSold || b.grossRevenue - a.grossRevenue)
      .slice(0, 12)
      .map((item) => ({
        sku: item.sku,
        title: item.title,
        platforms: [...item.platforms],
        unitsSold: item.unitsSold,
        grossRevenue: item.grossRevenue,
        netRevenue: item.hasMissingNetData ? null : item.netRevenueKnown,
      })),
  };
}

async function aggregateLineBasedOperationalPeriod(filters: RevenueQueryFilters): Promise<PeriodAggregation> {
  const lines = await loadRevenueLines(new Date(filters.from), new Date(filters.to), filters.platforms);
  const orders = aggregateOrdersFromLines(lines);
  const stores = new Map<
    Platform,
    {
      platform: Platform;
      label: string;
      grossRevenue: number;
      netRevenueKnown: number;
      marketplaceFeesKnown: number;
      advertisingFeesKnown: number;
      otherFeesKnown: number;
      taxCollected: number;
      shippingCollected: number;
      orderIds: Set<string>;
      hasMissingFeeData: boolean;
    }
  >();
  const trendMap = new Map<string, MutableTrendAggregation>();

  let grossRevenue = 0;
  let netRevenueKnown = 0;
  let marketplaceFeesKnown = 0;
  let advertisingFeesKnown = 0;
  let otherFeesKnown = 0;
  let hasMissingFeeData = false;

  for (const line of lines) {
    const lineGross =
      safeNumber(line.grossRevenueAmount) ??
      (safeNumber(line.unitPriceAmount) != null ? (line.unitPriceAmount as number) * line.quantity : 0);
    const lineNet = safeNumber(line.netRevenueAmount);
    const lineMarketplaceFee = safeNumber(line.marketplaceFeeAmount);
    const lineAdvertisingFee = safeNumber(line.advertisingFeeAmount);
    const lineOtherFee = safeNumber(line.otherFeeAmount) ?? 0;
    const lineHasMissingFeeData =
      lineGross > 0 && (lineMarketplaceFee == null || lineAdvertisingFee == null || lineNet == null);

    grossRevenue += lineGross;
    if (lineNet != null) netRevenueKnown += lineNet;
    if (lineMarketplaceFee != null) marketplaceFeesKnown += lineMarketplaceFee;
    if (lineAdvertisingFee != null) advertisingFeesKnown += lineAdvertisingFee;
    otherFeesKnown += lineOtherFee;
    if (lineHasMissingFeeData) hasMissingFeeData = true;

    const store =
      stores.get(line.platform) ??
      {
        platform: line.platform,
        label: PLATFORM_FULL[line.platform],
        grossRevenue: 0,
        netRevenueKnown: 0,
        marketplaceFeesKnown: 0,
        advertisingFeesKnown: 0,
        otherFeesKnown: 0,
        taxCollected: 0,
        shippingCollected: 0,
        orderIds: new Set<string>(),
        hasMissingFeeData: false,
      };
    store.grossRevenue += lineGross;
    if (lineNet != null) store.netRevenueKnown += lineNet;
    if (lineMarketplaceFee != null) store.marketplaceFeesKnown += lineMarketplaceFee;
    if (lineAdvertisingFee != null) store.advertisingFeesKnown += lineAdvertisingFee;
    store.otherFeesKnown += lineOtherFee;
    if (lineHasMissingFeeData) store.hasMissingFeeData = true;
    store.orderIds.add(line.marketplaceSaleOrder.id);
    stores.set(line.platform, store);

    const bucketStart = bucketStartForDate(line.orderDate, filters.granularity);
    const bucketKey = bucketStart.toISOString();
    const trend =
      trendMap.get(bucketKey) ??
      {
        bucketStart,
        bucketLabel: bucketLabelForDate(bucketStart),
        grossRevenue: 0,
        taxCollected: 0,
        marketplaceFees: 0,
        advertisingFees: 0,
        shippingLabels: 0,
        accountLevelFees: 0,
        otherCosts: 0,
        orderIds: new Set<string>(),
      };
    trend.grossRevenue += lineGross;
    if (lineMarketplaceFee != null) trend.marketplaceFees += lineMarketplaceFee;
    if (lineAdvertisingFee != null) trend.advertisingFees += lineAdvertisingFee;
    trend.otherCosts += lineOtherFee;
    trend.orderIds.add(line.marketplaceSaleOrder.id);
    trendMap.set(bucketKey, trend);
  }

  for (const order of orders.values()) {
    const store = stores.get(order.platform);
    if (store) {
      store.taxCollected += order.taxCollected;
      store.shippingCollected += order.shippingCollected;
    }
  }

  const orderCount = orders.size;
  const taxCollected = [...orders.values()].reduce((sum, order) => sum + order.taxCollected, 0);
  const shippingCollected = [...orders.values()].reduce((sum, order) => sum + order.shippingCollected, 0);
  const averageOrderValue = orderCount > 0 ? grossRevenue / orderCount : null;
  const netRevenuePartial = grossRevenue - marketplaceFeesKnown - advertisingFeesKnown;

  const trend = [...trendMap.values()]
    .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
    .map((entry) => ({
      bucketStart: entry.bucketStart.toISOString(),
      bucketLabel: entry.bucketLabel,
      grossRevenue: entry.grossRevenue,
      netRevenue: entry.grossRevenue - entry.marketplaceFees - entry.advertisingFees,
      marketplaceFees: entry.marketplaceFees,
      advertisingFees: entry.advertisingFees,
      orderCount: entry.orderIds.size,
    }));

  const storeBreakdown = [...stores.values()]
    .sort((a, b) => b.grossRevenue - a.grossRevenue)
    .map((store) => {
      const orderCountForStore = store.orderIds.size;
      const averageOrderValueForStore = orderCountForStore > 0 ? store.grossRevenue / orderCountForStore : null;
      const feeRatePercent =
        store.grossRevenue > 0 ? (store.marketplaceFeesKnown / store.grossRevenue) * 100 : null;
      const advertisingRatePercent =
        store.grossRevenue > 0 ? (store.advertisingFeesKnown / store.grossRevenue) * 100 : null;
      const netRevenuePartialForStore =
        store.grossRevenue - store.marketplaceFeesKnown - store.advertisingFeesKnown;

      return {
        platform: store.platform,
        label: store.label,
        orderCount: orderCountForStore,
        grossRevenue: store.grossRevenue,
        netRevenue: store.hasMissingFeeData ? netRevenuePartialForStore : store.netRevenueKnown,
        marketplaceFees: store.marketplaceFeesKnown,
        advertisingFees: store.advertisingFeesKnown,
        taxCollected: store.taxCollected,
        shippingCollected: store.shippingCollected,
        averageOrderValue: averageOrderValueForStore,
        feeRatePercent,
        advertisingRatePercent,
        exactFeeCoverage: !store.hasMissingFeeData,
      };
    });

  return {
    mode: "normalized",
    hasAnyRevenueData: lines.length > 0,
    grossRevenue,
    netRevenue: hasMissingFeeData ? netRevenuePartial : netRevenueKnown,
    marketplaceFees: marketplaceFeesKnown,
    advertisingFees: advertisingFeesKnown,
    taxCollected,
    shippingCollected,
    shippingLabels: null,
    accountLevelFees: null,
    orderCount,
    averageOrderValue,
    exactnessByMetric: {
      grossRevenue: "exact",
      netRevenue: hasMissingFeeData ? "partial" : "exact",
      marketplaceFees: hasMissingFeeData ? "partial" : "exact",
      advertisingFees: hasMissingFeeData ? "partial" : "exact",
      taxCollected: "exact",
      shippingCollected: "exact",
      shippingLabels: "unavailable",
      accountLevelFees: "unavailable",
      orderCount: "exact",
      averageOrderValue: "exact",
    },
    coverageByMetric: {
      grossRevenue: "exact",
      netRevenue: hasMissingFeeData ? "partial" : "exact",
      marketplaceFees: hasMissingFeeData ? "partial" : "exact",
      advertisingFees: hasMissingFeeData ? "partial" : "exact",
      taxCollected: "exact",
      shippingCollected: "exact",
      shippingLabels: "unavailable",
      accountLevelFees: "unavailable",
      orderCount: "exact",
      averageOrderValue: "exact",
    },
    unavailableReasons: {
      grossRevenue: null,
      netRevenue: hasMissingFeeData ? "Net revenue stays partial when selected stores do not expose exact fee detail." : null,
      marketplaceFees: hasMissingFeeData ? "Marketplace fees stay partial when selected stores do not expose exact fee detail." : null,
      advertisingFees: hasMissingFeeData ? "Advertising fees stay partial when selected stores do not expose exact fee detail." : null,
      taxCollected: null,
      shippingCollected: null,
      shippingLabels: "Shipping labels are only shown in exact eBay mode.",
      accountLevelFees: "Account-level fees are only shown in exact eBay mode.",
      orderCount: null,
      averageOrderValue: null,
    },
    sourceSummary: null,
    trend,
    storeBreakdown,
    feeBreakdown: [
      { key: "marketplaceFees", label: "Marketplace fees", amount: marketplaceFeesKnown },
      { key: "advertisingFees", label: "Advertising fees", amount: advertisingFeesKnown },
      { key: "otherFees", label: "Other fees", amount: otherFeesKnown },
    ] satisfies RevenueFeeBreakdownRow[],
    revenueShare: storeBreakdown.map((store) => ({
      platform: store.platform,
      label: store.label,
      grossRevenue: store.grossRevenue,
    })),
  };
}

function mergeExactness(values: RevenueMetricExactness[]): RevenueMetricExactness {
  if (values.length === 0) return "unavailable";
  if (values.every((value) => value === "exact")) return "exact";
  if (values.every((value) => value === "unavailable")) return "unavailable";
  return "partial";
}

async function aggregateNormalizedPeriod(filters: RevenueQueryFilters): Promise<PeriodAggregation> {
  const integrations = await getEnabledRevenueIntegrations();
  const selectedIntegrations = integrations.filter((integration) =>
    filters.platforms.includes(integration.platform),
  );

  const periods = await Promise.all(
    selectedIntegrations.map((integration) =>
      EXACT_EBAY_PLATFORMS.has(integration.platform)
        ? aggregateEbayExactPeriod({ ...filters, platforms: [integration.platform] }, integration)
        : aggregateLineBasedOperationalPeriod({ ...filters, platforms: [integration.platform] }),
    ),
  );

  if (periods.length === 0) {
    return aggregateLineBasedOperationalPeriod(filters);
  }

  if (periods.length === 1) {
    const [period] = periods;
    return {
      ...period,
      mode: "normalized",
      shippingLabels: null,
      accountLevelFees: null,
      exactnessByMetric: {
        ...period.exactnessByMetric,
        shippingLabels: "unavailable",
        accountLevelFees: "unavailable",
      },
      coverageByMetric: {
        ...period.coverageByMetric,
        shippingLabels: "unavailable",
        accountLevelFees: "unavailable",
      },
      unavailableReasons: {
        ...period.unavailableReasons,
        shippingLabels: "Shipping labels are only shown in exact eBay mode.",
        accountLevelFees: "Account-level fees are only shown in exact eBay mode.",
      },
      sourceSummary: null,
      feeBreakdown: period.feeBreakdown.filter(
        (row) => row.key === "marketplaceFees" || row.key === "advertisingFees" || row.key === "otherFees",
      ),
    };
  }

  const trendMap = new Map<
    string,
    {
      bucketStart: string;
      bucketLabel: string;
      grossRevenue: number;
      netRevenue: number;
      marketplaceFees: number;
      advertisingFees: number;
      orderCount: number;
    }
  >();
  const feeMap = new Map<string, RevenueFeeBreakdownRow>();

  for (const period of periods) {
    for (const point of period.trend) {
      const entry =
        trendMap.get(point.bucketStart) ??
        {
          bucketStart: point.bucketStart,
          bucketLabel: point.bucketLabel,
          grossRevenue: 0,
          netRevenue: 0,
          marketplaceFees: 0,
          advertisingFees: 0,
          orderCount: 0,
        };
      entry.grossRevenue += point.grossRevenue;
      entry.netRevenue += point.netRevenue ?? 0;
      entry.marketplaceFees += point.marketplaceFees ?? 0;
      entry.advertisingFees += point.advertisingFees ?? 0;
      entry.orderCount += point.orderCount;
      trendMap.set(point.bucketStart, entry);
    }

    for (const fee of period.feeBreakdown) {
      const key = fee.key === "shippingLabels" || fee.key === "accountLevelFees" ? "otherFees" : fee.key;
      const label =
        key === "marketplaceFees"
          ? "Marketplace fees"
          : key === "advertisingFees"
            ? "Advertising fees"
            : "Other fees";
      const existing = feeMap.get(key);
      if (existing) {
        existing.amount += fee.amount;
      } else {
        feeMap.set(key, { key, label, amount: fee.amount });
      }
    }
  }

  const grossRevenue = periods.reduce((sum, period) => sum + period.grossRevenue, 0);
  const netRevenue = periods.reduce((sum, period) => sum + (period.netRevenue ?? 0), 0);
  const marketplaceFees = periods.reduce((sum, period) => sum + (period.marketplaceFees ?? 0), 0);
  const advertisingFees = periods.reduce((sum, period) => sum + (period.advertisingFees ?? 0), 0);
  const taxCollected = periods.reduce((sum, period) => sum + period.taxCollected, 0);
  const shippingCollected = periods.reduce((sum, period) => sum + period.shippingCollected, 0);
  const orderCount = periods.reduce((sum, period) => sum + period.orderCount, 0);
  const averageOrderValue = orderCount > 0 ? grossRevenue / orderCount : null;
  const netExactness = mergeExactness(periods.map((period) => period.exactnessByMetric.netRevenue));
  const marketplaceExactness = mergeExactness(periods.map((period) => period.exactnessByMetric.marketplaceFees));
  const advertisingExactness = mergeExactness(periods.map((period) => period.exactnessByMetric.advertisingFees));

  const storeBreakdown = periods
    .flatMap((period) => period.storeBreakdown)
    .sort((a, b) => b.grossRevenue - a.grossRevenue);

  return {
    mode: "normalized",
    hasAnyRevenueData: periods.some((period) => period.hasAnyRevenueData),
    grossRevenue,
    netRevenue,
    marketplaceFees,
    advertisingFees,
    taxCollected,
    shippingCollected,
    shippingLabels: null,
    accountLevelFees: null,
    orderCount,
    averageOrderValue,
    exactnessByMetric: {
      grossRevenue: "exact",
      netRevenue: netExactness,
      marketplaceFees: marketplaceExactness,
      advertisingFees: advertisingExactness,
      taxCollected: "exact",
      shippingCollected: "exact",
      shippingLabels: "unavailable",
      accountLevelFees: "unavailable",
      orderCount: "exact",
      averageOrderValue: "exact",
    },
    coverageByMetric: {
      grossRevenue: "exact",
      netRevenue: netExactness,
      marketplaceFees: marketplaceExactness,
      advertisingFees: advertisingExactness,
      taxCollected: "exact",
      shippingCollected: "exact",
      shippingLabels: "unavailable",
      accountLevelFees: "unavailable",
      orderCount: "exact",
      averageOrderValue: "exact",
    },
    unavailableReasons: {
      grossRevenue: null,
      netRevenue:
        netExactness === "exact"
          ? null
          : "Net revenue stays partial when selected stores do not expose exact fee detail.",
      marketplaceFees:
        marketplaceExactness === "exact"
          ? null
          : "Marketplace fees stay partial when selected stores do not expose exact fee detail.",
      advertisingFees:
        advertisingExactness === "exact"
          ? null
          : "Advertising fees stay partial when selected stores do not expose exact fee detail.",
      taxCollected: null,
      shippingCollected: null,
      shippingLabels: "Shipping labels are only shown in exact eBay mode.",
      accountLevelFees: "Account-level fees are only shown in exact eBay mode.",
      orderCount: null,
      averageOrderValue: null,
    },
    sourceSummary: null,
    trend: [...trendMap.values()].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart)),
    storeBreakdown,
    feeBreakdown: [...feeMap.values()].filter((row) => row.amount !== 0),
    revenueShare: storeBreakdown.map((store) => ({
      platform: store.platform,
      label: store.label,
      grossRevenue: store.grossRevenue,
    })),
  };
}

async function aggregateEbayExactPeriod(
  filters: RevenueQueryFilters,
  integration: RevenueIntegrationRecord,
): Promise<PeriodAggregation> {
  const reportingTimeZone =
    getIntegrationConfig(integration).syncProfile.timezone || DEFAULT_EBAY_REPORTING_TIMEZONE;
  const effectiveRange = normalizeRangeToTimeZoneDayBounds(filters.from, filters.to, reportingTimeZone);
  const [lines, events] = await Promise.all([
    loadRevenueLines(effectiveRange.from, effectiveRange.to, [integration.platform]),
    loadRevenueFinancialEvents(integration.id, effectiveRange.from, effectiveRange.to),
  ]);
  const orders = aggregateOrdersFromLines(lines);
  const orderDateById = new Map(lines.map((line) => [line.marketplaceSaleOrder.id, line.orderDate]));
  const orderIdByExternalOrderId = new Map(
    lines.map((line) => [line.marketplaceSaleOrder.externalOrderId, line.marketplaceSaleOrder.id]),
  );
  const trendMap = new Map<string, MutableTrendAggregation>();

  let grossRevenue = 0;
  let taxCollectedFromEvents = 0;
  let marketplaceFees = 0;
  let advertisingFees = 0;
  let shippingLabels = 0;
  let accountLevelFees = 0;
  let otherCosts = 0;

  for (const event of events) {
    if (event.classification === "SALE") grossRevenue += event.amount;
    if (event.classification === "TAX") taxCollectedFromEvents += event.amount;
    if (event.classification === "MARKETPLACE_FEE") marketplaceFees += event.amount;
    if (event.classification === "ADVERTISING_FEE") advertisingFees += event.amount;
    if (event.classification === "SHIPPING_LABEL") shippingLabels += event.amount;
    if (event.classification === "ACCOUNT_LEVEL_FEE") accountLevelFees += event.amount;
    if (event.classification === "OTHER" || event.classification === "CREDIT") {
      otherCosts += event.amount;
    }

    const bucketStart = bucketStartForDate(event.occurredAt, filters.granularity, reportingTimeZone);
    const bucketKey = bucketStart.toISOString();
    const trend =
      trendMap.get(bucketKey) ??
      {
        bucketStart,
        bucketLabel: bucketLabelForDate(bucketStart),
        grossRevenue: 0,
        taxCollected: 0,
        marketplaceFees: 0,
        advertisingFees: 0,
        shippingLabels: 0,
        accountLevelFees: 0,
        otherCosts: 0,
        orderIds: new Set<string>(),
      };
    if (event.classification === "SALE") trend.grossRevenue += event.amount;
    if (event.classification === "TAX") trend.taxCollected += event.amount;
    if (event.classification === "MARKETPLACE_FEE") trend.marketplaceFees += event.amount;
    if (event.classification === "ADVERTISING_FEE") trend.advertisingFees += event.amount;
    if (event.classification === "SHIPPING_LABEL") trend.shippingLabels += event.amount;
    if (event.classification === "ACCOUNT_LEVEL_FEE") trend.accountLevelFees += event.amount;
    if (event.classification === "OTHER" || event.classification === "CREDIT") {
      trend.otherCosts += event.amount;
    }
    const orderId = event.externalOrderId ? orderIdByExternalOrderId.get(event.externalOrderId) : null;
    if (orderId) trend.orderIds.add(orderId);
    trendMap.set(bucketKey, trend);
  }

  for (const [orderId] of orders.entries()) {
    const orderDate = orderDateById.get(orderId);
    if (!orderDate) continue;
    const bucketStart = bucketStartForDate(orderDate, filters.granularity, reportingTimeZone);
    const bucketKey = bucketStart.toISOString();
    const trend =
      trendMap.get(bucketKey) ??
      {
        bucketStart,
        bucketLabel: bucketLabelForDate(bucketStart),
        grossRevenue: 0,
        taxCollected: 0,
        marketplaceFees: 0,
        advertisingFees: 0,
        shippingLabels: 0,
        accountLevelFees: 0,
        otherCosts: 0,
        orderIds: new Set<string>(),
      };
    trend.orderIds.add(orderId);
    trendMap.set(bucketKey, trend);
  }

  const orderCount = orders.size;
  const shippingCollected = [...orders.values()].reduce((sum, order) => sum + order.shippingCollected, 0);
  const taxCollected =
    taxCollectedFromEvents > 0
      ? taxCollectedFromEvents
      : [...orders.values()].reduce((sum, order) => sum + order.taxCollected, 0);
  const sellingCosts =
    marketplaceFees + advertisingFees + shippingLabels + accountLevelFees + otherCosts;
  const averageOrderValue = orderCount > 0 ? grossRevenue / orderCount : null;
  const netRevenue = grossRevenue > 0 ? grossRevenue - taxCollected - sellingCosts : null;

  const trend = [...trendMap.values()]
    .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime())
    .map((entry) => ({
      bucketStart: entry.bucketStart.toISOString(),
      bucketLabel: entry.bucketLabel,
      grossRevenue: entry.grossRevenue,
      netRevenue:
        entry.grossRevenue -
        entry.taxCollected -
        entry.marketplaceFees -
        entry.advertisingFees -
        entry.shippingLabels -
        entry.accountLevelFees -
        entry.otherCosts,
      marketplaceFees: entry.marketplaceFees,
      advertisingFees: entry.advertisingFees,
      orderCount: entry.orderIds.size,
    }));

  const sourceSummary: RevenueSourceSummary = {
    grossRevenue,
    taxCollected,
    sellingCosts,
    marketplaceFees,
    advertisingFees,
    shippingLabels,
    accountLevelFees,
    netRevenue,
    currencyCode: "USD",
  };

  return {
    mode: "ebay_exact",
    hasAnyRevenueData: lines.length > 0 || events.length > 0,
    grossRevenue,
    netRevenue,
    marketplaceFees,
    advertisingFees,
    taxCollected,
    shippingCollected,
    shippingLabels,
    accountLevelFees,
    orderCount,
    averageOrderValue,
    exactnessByMetric: {
      grossRevenue: "exact",
      netRevenue: "exact",
      marketplaceFees: "exact",
      advertisingFees: "exact",
      taxCollected: "exact",
      shippingCollected: "exact",
      shippingLabels: "exact",
      accountLevelFees: "exact",
      orderCount: "exact",
      averageOrderValue: "exact",
    },
    coverageByMetric: {
      grossRevenue: "exact",
      netRevenue: "exact",
      marketplaceFees: "exact",
      advertisingFees: "exact",
      taxCollected: "exact",
      shippingCollected: "exact",
      shippingLabels: "exact",
      accountLevelFees: "exact",
      orderCount: "exact",
      averageOrderValue: "exact",
    },
    unavailableReasons: {
      grossRevenue: null,
      netRevenue: null,
      marketplaceFees: null,
      advertisingFees: null,
      taxCollected: null,
      shippingCollected: null,
      shippingLabels: null,
      accountLevelFees: null,
      orderCount: null,
      averageOrderValue: null,
    },
    sourceSummary,
    trend,
    storeBreakdown: [
      {
        platform: integration.platform,
        label: integration.label,
        orderCount,
        grossRevenue,
        netRevenue,
        marketplaceFees,
        advertisingFees,
        taxCollected,
        shippingCollected,
        averageOrderValue,
        feeRatePercent: grossRevenue > 0 ? (marketplaceFees / grossRevenue) * 100 : null,
        advertisingRatePercent: grossRevenue > 0 ? (advertisingFees / grossRevenue) * 100 : null,
        exactFeeCoverage: true,
      },
    ],
    feeBreakdown: ([
      { key: "marketplaceFees", label: "Marketplace fees", amount: marketplaceFees },
      { key: "advertisingFees", label: "Advertising fees", amount: advertisingFees },
      { key: "shippingLabels", label: "Shipping labels", amount: shippingLabels },
      { key: "accountLevelFees", label: "Account-level fees", amount: accountLevelFees },
      { key: "otherFees", label: "Other costs and credits", amount: otherCosts },
    ] satisfies RevenueFeeBreakdownRow[]).filter((row) => row.amount !== 0),
    revenueShare: [
      {
        platform: integration.platform,
        label: integration.label,
        grossRevenue,
      },
    ],
  };
}

function buildRevenueKpis(current: PeriodAggregation, previous: PeriodAggregation): RevenueKpiSummary {
  return {
    grossRevenue: metricWithDelta(current.grossRevenue, previous.grossRevenue, current.exactnessByMetric.grossRevenue, current.unavailableReasons.grossRevenue),
    netRevenue: metricWithDelta(current.netRevenue, previous.netRevenue, current.exactnessByMetric.netRevenue, current.unavailableReasons.netRevenue),
    marketplaceFees: metricWithDelta(current.marketplaceFees, previous.marketplaceFees, current.exactnessByMetric.marketplaceFees, current.unavailableReasons.marketplaceFees),
    advertisingFees: metricWithDelta(current.advertisingFees, previous.advertisingFees, current.exactnessByMetric.advertisingFees, current.unavailableReasons.advertisingFees),
    taxCollected: metricWithDelta(current.taxCollected, previous.taxCollected, current.exactnessByMetric.taxCollected, current.unavailableReasons.taxCollected),
    shippingCollected: metricWithDelta(current.shippingCollected, previous.shippingCollected, current.exactnessByMetric.shippingCollected, current.unavailableReasons.shippingCollected),
    shippingLabels: metricWithDelta(current.shippingLabels, previous.shippingLabels, current.exactnessByMetric.shippingLabels, current.unavailableReasons.shippingLabels),
    accountLevelFees: metricWithDelta(current.accountLevelFees, previous.accountLevelFees, current.exactnessByMetric.accountLevelFees, current.unavailableReasons.accountLevelFees),
    orderCount: metricWithDelta(current.orderCount, previous.orderCount, current.exactnessByMetric.orderCount, current.unavailableReasons.orderCount),
    averageOrderValue: metricWithDelta(current.averageOrderValue, previous.averageOrderValue, current.exactnessByMetric.averageOrderValue, current.unavailableReasons.averageOrderValue),
  };
}

function buildGrowthCards(kpis: RevenueKpiSummary): RevenueGrowthCard[] {
  return [
    { key: "grossRevenue", label: "Gross Revenue vs prior period", currentValue: kpis.grossRevenue.value, previousValue: kpis.grossRevenue.previousValue, deltaPercent: kpis.grossRevenue.deltaPercent, exact: kpis.grossRevenue.exact },
    { key: "netRevenue", label: "Net Revenue vs prior period", currentValue: kpis.netRevenue.value, previousValue: kpis.netRevenue.previousValue, deltaPercent: kpis.netRevenue.deltaPercent, exact: kpis.netRevenue.exact },
    { key: "orderCount", label: "Orders vs prior period", currentValue: kpis.orderCount.value, previousValue: kpis.orderCount.previousValue, deltaPercent: kpis.orderCount.deltaPercent, exact: kpis.orderCount.exact },
    { key: "averageOrderValue", label: "Average Order Value vs prior period", currentValue: kpis.averageOrderValue.value, previousValue: kpis.averageOrderValue.previousValue, deltaPercent: kpis.averageOrderValue.deltaPercent, exact: kpis.averageOrderValue.exact },
  ];
}

function buildEmptyRevenuePageData(
  filters: RevenueQueryFilters,
  integrations: RevenueIntegrationOption[],
  syncSummary: RevenueSyncSummary,
  notes: string[],
): RevenuePageData {
  const emptyMetric: RevenueKpiMetric = {
    value: null,
    previousValue: null,
    deltaPercent: null,
    exact: false,
    unavailableReason: null,
  };

  const kpis: RevenueKpiSummary = {
    grossRevenue: emptyMetric,
    netRevenue: emptyMetric,
    marketplaceFees: emptyMetric,
    advertisingFees: emptyMetric,
    taxCollected: emptyMetric,
    shippingCollected: emptyMetric,
    shippingLabels: {
      ...emptyMetric,
      unavailableReason: "Shipping labels are only shown in exact eBay mode.",
    },
    accountLevelFees: {
      ...emptyMetric,
      unavailableReason: "Account-level fees are only shown in exact eBay mode.",
    },
    orderCount: emptyMetric,
    averageOrderValue: emptyMetric,
  };

  return {
    filters,
    integrations,
    mode: "normalized",
    exactnessByMetric: {
      grossRevenue: "unavailable",
      netRevenue: "unavailable",
      marketplaceFees: "unavailable",
      advertisingFees: "unavailable",
      taxCollected: "unavailable",
      shippingCollected: "unavailable",
      shippingLabels: "unavailable",
      accountLevelFees: "unavailable",
      orderCount: "unavailable",
      averageOrderValue: "unavailable",
    },
    coverageByMetric: {
      grossRevenue: "unavailable",
      netRevenue: "unavailable",
      marketplaceFees: "unavailable",
      advertisingFees: "unavailable",
      taxCollected: "unavailable",
      shippingCollected: "unavailable",
      shippingLabels: "unavailable",
      accountLevelFees: "unavailable",
      orderCount: "unavailable",
      averageOrderValue: "unavailable",
    },
    sourceSummary: null,
    kpis,
    trend: [],
    storeBreakdown: [],
    feeBreakdown: [],
    revenueShare: [],
    topBuyers: [],
    topItems: [],
    growthCards: buildGrowthCards(kpis),
    syncSummary,
    notes,
    hasAnyRevenueData: false,
  };
}

async function getRevenueSyncSummary(platforms: Platform[]): Promise<RevenueSyncSummary> {
  const jobs = await db.revenueSyncJob.findMany({
    where: { platform: { in: platforms } },
    include: { integration: { select: { label: true } } },
    orderBy: { createdAt: "desc" },
    take: Math.max(12, platforms.length * 4),
  });

  const latestByIntegration = new Map<string, RevenueSyncJobSummary>();
  for (const job of jobs) {
    if (latestByIntegration.has(job.integrationId)) continue;
    latestByIntegration.set(job.integrationId, formatRevenueJob(job));
  }

  const latestOverall = jobs[0] ? formatRevenueJob(jobs[0]) : null;
  const latestCompletedJob = jobs.find((job) => job.completedAt != null);
  return {
    latestCompletedAt: latestCompletedJob?.completedAt?.toISOString() ?? null,
    latestStatus: latestOverall?.status ?? null,
    latestStartedAt: latestOverall?.startedAt ?? null,
    jobs: [...latestByIntegration.values()],
  };
}

export async function getRevenuePageData(
  user: AuthenticatedRevenueUser,
  filters: RevenueQueryFilters,
): Promise<RevenuePageData> {
  requireRevenueAccess(user);

  const integrations = await getEnabledRevenueIntegrations();
  const platforms = normalizeSelectedPlatforms(integrations, filters.platforms);
  const normalizedFilters: RevenueQueryFilters = { ...filters, platforms };
  const integrationOptions = toIntegrationOptions(integrations);
  const syncSummary = await getRevenueSyncSummary(platforms);

  if (!syncSummary.latestCompletedAt) {
    const notes = [
      syncSummary.jobs.some((job) => job.status === "PENDING" || job.status === "RUNNING")
        ? "Initial revenue refresh is running. Revenue analytics will appear after the first completed refresh."
        : "No revenue data is stored for the selected range yet. Run a manual refresh to populate this dashboard.",
    ];

    return buildEmptyRevenuePageData(
      normalizedFilters,
      integrationOptions,
      syncSummary,
      notes,
    );
  }

  const mode: RevenueMetricMode = isSingleStoreEbayExactMode(platforms) ? "ebay_exact" : "normalized";
  const exactIntegration =
    mode === "ebay_exact" ? integrations.find((integration) => integration.platform === platforms[0]) ?? null : null;
  if (mode === "ebay_exact" && !exactIntegration) {
    throw new RevenueServiceError("Selected eBay integration is unavailable.", 400);
  }

  const currentFrom = new Date(filters.from);
  const currentTo = new Date(filters.to);
  const spanMs = Math.max(1, currentTo.getTime() - currentFrom.getTime());
  const previousTo = new Date(currentFrom.getTime() - 1);
  const previousFrom = new Date(previousTo.getTime() - spanMs);
  const buyerRange = rangeForSimpleWindow(normalizedFilters.to, normalizedFilters.buyerWindow);
  const itemRange = rangeForSimpleWindow(normalizedFilters.to, normalizedFilters.itemWindow);

  const [current, previous, buyerTables, itemTables] = await Promise.all([
    mode === "ebay_exact" && exactIntegration
      ? aggregateEbayExactPeriod(normalizedFilters, exactIntegration)
      : aggregateNormalizedPeriod(normalizedFilters),
    mode === "ebay_exact" && exactIntegration
      ? aggregateEbayExactPeriod({ ...normalizedFilters, from: previousFrom.toISOString(), to: previousTo.toISOString() }, exactIntegration)
      : aggregateNormalizedPeriod({ ...normalizedFilters, from: previousFrom.toISOString(), to: previousTo.toISOString() }),
    aggregateTopTables({ ...normalizedFilters, from: buyerRange.from, to: buyerRange.to }),
    aggregateTopTables({ ...normalizedFilters, from: itemRange.from, to: itemRange.to }),
  ]);

  const kpis = buildRevenueKpis(current, previous);
  const growthCards = buildGrowthCards(kpis);
  const notes: string[] = [];

  if (!current.hasAnyRevenueData) {
    notes.push("No revenue data is stored for the selected range yet. Run a manual refresh to populate this dashboard.");
  }
  if (mode === "ebay_exact") {
    notes.push("eBay Exact mode mirrors Seller Hub semantics for one selected eBay store. Gross revenue includes taxes, and Net Revenue subtracts taxes and all selling costs recorded by eBay.");
    notes.push("Shipping labels and account-level charges are shown separately here and are included in Net Revenue.");
  } else if (current.exactnessByMetric.netRevenue !== "exact") {
    notes.push("Normalized mode keeps cross-marketplace reporting safe. BigCommerce and Shopify revenue stays visible, but fee-driven metrics remain partial where the source APIs do not expose exact fee detail.");
  }

  return {
    filters: normalizedFilters,
    integrations: integrationOptions,
    mode,
    exactnessByMetric: current.exactnessByMetric,
    coverageByMetric: current.coverageByMetric,
    sourceSummary: current.sourceSummary,
    kpis,
    trend: current.trend,
    storeBreakdown: current.storeBreakdown,
    feeBreakdown: current.feeBreakdown,
    revenueShare: current.revenueShare,
    topBuyers: buyerTables.topBuyers,
    topItems: itemTables.topItems,
    growthCards,
    syncSummary,
    notes,
    hasAnyRevenueData: current.hasAnyRevenueData,
  };
}

function fallbackSyncStagesForPlatform(platform: Platform, lineCount: number): RevenueSyncStageSummary[] {
  return [{
    key: platform === "SHOPIFY" || platform === "BIGCOMMERCE" ? "orders" : "fetch",
    label: platform === "SHOPIFY" || platform === "BIGCOMMERCE" ? "Orders" : "Revenue Fetch",
    status: "COMPLETED",
    detail: `${lineCount.toLocaleString()} lines fetched.`,
    updatedAt: new Date().toISOString(),
  }];
}

export async function syncRevenueData(
  user: AuthenticatedRevenueUser,
  request: RevenueSyncRequest,
): Promise<RevenueSyncResult> {
  const queued = await queueRevenueSyncData(user, request);
  const executed = await executeQueuedRevenueSyncData(request, queued.queuedJobIds);

  return {
    jobs: executed.jobs.length > 0 ? executed.jobs : queued.jobs,
    completedAt: executed.completedAt,
    warnings: [...queued.warnings, ...executed.warnings],
  };
}

export async function queueRevenueSyncData(
  user: AuthenticatedRevenueUser,
  request: RevenueSyncRequest,
): Promise<QueuedRevenueSyncResult> {
  requireRevenueAccess(user);

  const integrations = await getRevenueSyncIntegrations(request);
  const queued = await queueRevenueSyncJobs(user.id, request, integrations);

  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "revenue_sync_manual",
      entityType: "revenue",
      entityId: new Date().toISOString(),
      details: {
        from: request.from,
        to: request.to,
        platforms: request.platforms,
        queuedJobIds: queued.queuedJobIds,
        reusedJobIds: queued.jobs
          .filter((job) => !queued.queuedJobIds.includes(job.id))
          .map((job) => job.id),
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    jobs: queued.jobs.map((job) => formatRevenueJob(job)).sort((a, b) => a.label.localeCompare(b.label)),
    completedAt: new Date().toISOString(),
    warnings: queued.warnings,
    queuedJobIds: queued.queuedJobIds,
  };
}

export async function executeQueuedRevenueSyncData(
  request: RevenueSyncRequest,
  jobIds: string[],
): Promise<RevenueSyncResult> {
  if (jobIds.length === 0) {
    return {
      jobs: [],
      completedAt: new Date().toISOString(),
      warnings: [],
    };
  }

  const claimStartedAt = new Date();
  const claimResult = await db.revenueSyncJob.updateMany({
    where: {
      id: { in: jobIds },
      status: "PENDING",
    },
    data: {
      status: "RUNNING",
      startedAt: claimStartedAt,
    },
  });

  if (claimResult.count === 0) {
    const existingJobs = await db.revenueSyncJob.findMany({
      where: { id: { in: jobIds } },
      include: { integration: { select: { label: true } } },
    });
    return {
      jobs: existingJobs.map((job) => formatRevenueJob(job)).sort((a, b) => a.label.localeCompare(b.label)),
      completedAt: new Date().toISOString(),
      warnings: [],
    };
  }

  const jobs = await db.revenueSyncJob.findMany({
    where: {
      id: { in: jobIds },
      status: "RUNNING",
    },
    include: { integration: { select: { label: true } } },
  });

  if (jobs.length === 0) {
    throw new RevenueServiceError("Queued revenue sync jobs were not found.", 404);
  }

  const integrations = await db.integration.findMany({
    where: {
      id: { in: [...new Set(jobs.map((job) => job.integrationId))] },
    },
    select: { id: true, platform: true, label: true, config: true },
  });

  return runQueuedRevenueSyncJobs(request, jobs, integrations);
}

async function runQueuedRevenueSyncJobs(
  request: RevenueSyncRequest,
  jobs: RevenueSyncJobRecord[],
  integrations: RevenueIntegrationRecord[],
): Promise<RevenueSyncResult> {
  const warnings: string[] = [];
  const results: RevenueSyncJobSummary[] = [];

  await Promise.all(
    jobs.map(async (job) => {
      const integration = integrations.find((entry) => entry.id === job.integrationId);
      if (!integration) return;

      try {
        const reportingTimeZone =
          EXACT_EBAY_PLATFORMS.has(integration.platform)
            ? getIntegrationConfig(integration).syncProfile.timezone || DEFAULT_EBAY_REPORTING_TIMEZONE
            : "UTC";
        const effectiveRange = EXACT_EBAY_PLATFORMS.has(integration.platform)
          ? normalizeRangeToTimeZoneDayBounds(request.from, request.to, reportingTimeZone)
          : { from: new Date(request.from), to: new Date(request.to) };
        const persistStages = async (syncStages: RevenueSyncStageSummary[]) => {
          await db.revenueSyncJob.update({
            where: { id: job.id },
            data: {
              metadata: {
                requestedRange: { from: request.from, to: request.to },
                effectiveRange: {
                  from: effectiveRange.from.toISOString(),
                  to: effectiveRange.to.toISOString(),
                  reportingTimeZone,
                },
                syncStages,
              } as unknown as Prisma.InputJsonValue,
            },
          });
        };
        const fetched = await runWithMarketplaceTelemetry(
          {
            syncJobId: job.id,
            integrationId: integration.id,
            platform: integration.platform,
          },
          () =>
            fetchMarketplaceRevenue(integration, effectiveRange.from, effectiveRange.to, {
              onSyncStagesChange: persistStages,
            }),
        );

        await replaceSalesHistoryLinesForRange({
          platform: integration.platform,
          from: effectiveRange.from,
          to: effectiveRange.to,
          lines: fetched.lines,
        });
        await replaceRevenueFinancialEventsForRange({
          integrationId: integration.id,
          from: effectiveRange.from,
          to: effectiveRange.to,
          events: fetched.financialEvents,
        });
        warnings.push(...fetched.warnings.map((warning) => `${integration.label}: ${warning}`));

        const updated = await db.revenueSyncJob.update({
          where: { id: job.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            ordersProcessed: new Set(fetched.lines.map((line) => line.externalOrderId)).size,
            linesProcessed: fetched.lines.length,
            warningCount: fetched.warnings.length,
            warnings: fetched.warnings as unknown as Prisma.InputJsonValue,
            metadata: {
              requestedRange: { from: request.from, to: request.to },
              effectiveRange: { from: effectiveRange.from.toISOString(), to: effectiveRange.to.toISOString(), reportingTimeZone },
              syncStages: fetched.syncStages.length > 0 ? fetched.syncStages : fallbackSyncStagesForPlatform(integration.platform, fetched.lines.length),
              sourceSummary: fetched.exactSummary,
              financialEventCount: fetched.financialEvents.length,
            } as unknown as Prisma.InputJsonValue,
          },
          include: { integration: { select: { label: true } } },
        });
        void recordNetworkTransferSample({
          channel: "SYNC_JOB",
          label: `${integration.label} revenue sync completed`,
          durationMs:
            updated.startedAt && updated.completedAt
              ? Math.max(0, updated.completedAt.getTime() - updated.startedAt.getTime())
              : null,
          integrationId: integration.id,
          metadata: {
            syncJobId: updated.id,
            route: "POST /api/revenue/sync",
            scope: "revenue",
            platform: integration.platform,
            status: updated.status,
            ordersProcessed: updated.ordersProcessed,
            linesProcessed: updated.linesProcessed,
            warningCount: updated.warningCount,
            financialEventCount: fetched.financialEvents.length,
          },
        });
        results.push(formatRevenueJob(updated));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to refresh revenue data.";
        const updated = await db.revenueSyncJob.update({
          where: { id: job.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            errorSummary: message,
            metadata: {
              requestedRange: { from: request.from, to: request.to },
              syncStages: [{ key: "failed", label: "Revenue Sync", status: "FAILED", detail: message, updatedAt: new Date().toISOString() }],
            } as unknown as Prisma.InputJsonValue,
          },
          include: { integration: { select: { label: true } } },
        });
        void recordNetworkTransferSample({
          channel: "SYNC_JOB",
          label: `${integration.label} revenue sync failed`,
          durationMs:
            updated.startedAt && updated.completedAt
              ? Math.max(0, updated.completedAt.getTime() - updated.startedAt.getTime())
              : null,
          integrationId: integration.id,
          metadata: {
            syncJobId: updated.id,
            route: "POST /api/revenue/sync",
            scope: "revenue",
            platform: integration.platform,
            status: updated.status,
            errorSummary: updated.errorSummary,
          },
        });
        results.push(formatRevenueJob(updated));
        warnings.push(`${integration.label}: ${message}`);
      }
    }),
  );

  return {
    jobs: results.sort((a, b) => a.label.localeCompare(b.label)),
    completedAt: new Date().toISOString(),
    warnings,
  };
}
