import type { Platform } from "@/lib/grid-types";

export const REVENUE_RANGE_PRESETS = ["30d", "90d", "365d", "custom"] as const;
export type RevenueRangePreset = (typeof REVENUE_RANGE_PRESETS)[number];

export const REVENUE_GRANULARITY_VALUES = ["day", "week"] as const;
export type RevenueGranularity = (typeof REVENUE_GRANULARITY_VALUES)[number];

export const REVENUE_SIMPLE_WINDOW_VALUES = ["3d", "7d", "15d", "30d"] as const;
export type RevenueSimpleWindow = (typeof REVENUE_SIMPLE_WINDOW_VALUES)[number];

export const REVENUE_SYNC_STATUS_VALUES = [
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
] as const;
export type RevenueSyncStatus = (typeof REVENUE_SYNC_STATUS_VALUES)[number];

export const REVENUE_METRIC_MODE_VALUES = ["normalized", "ebay_exact"] as const;
export type RevenueMetricMode = (typeof REVENUE_METRIC_MODE_VALUES)[number];

export const REVENUE_EXACTNESS_VALUES = ["exact", "partial", "estimated", "unavailable"] as const;
export type RevenueMetricExactness = (typeof REVENUE_EXACTNESS_VALUES)[number];

export interface RevenueQueryFilters {
  from: string;
  to: string;
  preset: RevenueRangePreset;
  granularity: RevenueGranularity;
  platforms: Platform[];
  buyerWindow: RevenueSimpleWindow;
  itemWindow: RevenueSimpleWindow;
}

export interface RevenueSyncRequest {
  from: string;
  to: string;
  platforms: Platform[];
}

export interface RevenueIntegrationOption {
  id: string;
  platform: Platform;
  label: string;
}

export interface RevenueKpiMetric {
  value: number | null;
  previousValue: number | null;
  deltaPercent: number | null;
  exact: boolean;
  unavailableReason?: string | null;
}

export interface RevenueKpiSummary {
  grossRevenue: RevenueKpiMetric;
  netRevenue: RevenueKpiMetric;
  marketplaceFees: RevenueKpiMetric;
  advertisingFees: RevenueKpiMetric;
  taxCollected: RevenueKpiMetric;
  shippingCollected: RevenueKpiMetric;
  shippingLabels: RevenueKpiMetric;
  accountLevelFees: RevenueKpiMetric;
  orderCount: RevenueKpiMetric;
  averageOrderValue: RevenueKpiMetric;
}

export interface RevenueTrendPoint {
  bucketStart: string;
  bucketLabel: string;
  grossRevenue: number;
  netRevenue: number | null;
  marketplaceFees: number | null;
  advertisingFees: number | null;
  orderCount: number;
}

export interface RevenueStoreBreakdownRow {
  platform: Platform;
  label: string;
  orderCount: number;
  grossRevenue: number;
  netRevenue: number | null;
  marketplaceFees: number | null;
  advertisingFees: number | null;
  taxCollected: number;
  shippingCollected: number;
  averageOrderValue: number | null;
  feeRatePercent: number | null;
  advertisingRatePercent: number | null;
  exactFeeCoverage: boolean;
}

export interface RevenueFeeBreakdownRow {
  key:
    | "marketplaceFees"
    | "advertisingFees"
    | "shippingLabels"
    | "accountLevelFees"
    | "otherFees";
  label: string;
  amount: number;
}

export interface RevenueTopBuyerRow {
  buyerKey: string;
  buyerIdentifier: string;
  buyerName: string | null;
  buyerLabel: string;
  buyerEmail: string | null;
  platforms: Platform[];
  orderCount: number;
  grossRevenue: number;
  netRevenue: number | null;
}

export interface RevenueTopItemRow {
  sku: string;
  title: string | null;
  platforms: Platform[];
  unitsSold: number;
  grossRevenue: number;
  netRevenue: number | null;
}

export interface RevenueGrowthCard {
  key: "grossRevenue" | "netRevenue" | "orderCount" | "averageOrderValue";
  label: string;
  currentValue: number | null;
  previousValue: number | null;
  deltaPercent: number | null;
  exact: boolean;
}

export interface RevenueSourceSummary {
  grossRevenue: number | null;
  taxCollected: number | null;
  sellingCosts: number | null;
  marketplaceFees: number | null;
  advertisingFees: number | null;
  shippingLabels: number | null;
  accountLevelFees: number | null;
  netRevenue: number | null;
  currencyCode: string | null;
}

export interface RevenueSyncStageSummary {
  key: string;
  label: string;
  status: RevenueSyncStatus;
  detail: string | null;
  updatedAt: string | null;
}

export interface RevenueSyncJobSummary {
  id: string;
  integrationId: string;
  platform: Platform;
  label: string;
  status: RevenueSyncStatus;
  startedAt: string | null;
  completedAt: string | null;
  ordersProcessed: number;
  linesProcessed: number;
  warningCount: number;
  errorSummary: string | null;
  syncStages: RevenueSyncStageSummary[];
  sourceSummary: RevenueSourceSummary | null;
}

export interface RevenueSyncSummary {
  latestCompletedAt: string | null;
  latestStatus: RevenueSyncStatus | null;
  latestStartedAt: string | null;
  jobs: RevenueSyncJobSummary[];
}

export interface RevenueStatusData {
  integrations: RevenueIntegrationOption[];
  selectedPlatforms: Platform[];
  syncSummary: RevenueSyncSummary;
  hasActiveSyncJobs: boolean;
  hasCompletedRefresh: boolean;
  notes: string[];
}

export interface RevenueDebugSample {
  createdAt: string;
  channel: string;
  label: string;
  durationMs: number | null;
  bytesEstimate: number | null;
  metadata: unknown;
}

export interface RevenueDebugData {
  generatedAt: string;
  selectedPlatforms: Platform[];
  hasActiveSyncJobs: boolean;
  hasCompletedRefresh: boolean;
  syncSummary: RevenueSyncSummary;
  notes: string[];
  recentSamples: RevenueDebugSample[];
}

export interface RevenueTopTablesData {
  topBuyers: RevenueTopBuyerRow[];
  topItems: RevenueTopItemRow[];
}

export interface RevenuePageData {
  filters: RevenueQueryFilters;
  integrations: RevenueIntegrationOption[];
  mode: RevenueMetricMode;
  exactnessByMetric: Record<string, RevenueMetricExactness>;
  coverageByMetric: Record<string, RevenueMetricExactness>;
  sourceSummary: RevenueSourceSummary | null;
  kpis: RevenueKpiSummary;
  trend: RevenueTrendPoint[];
  storeBreakdown: RevenueStoreBreakdownRow[];
  feeBreakdown: RevenueFeeBreakdownRow[];
  revenueShare: Array<{ platform: Platform; label: string; grossRevenue: number }>;
  topBuyers: RevenueTopBuyerRow[];
  topItems: RevenueTopItemRow[];
  growthCards: RevenueGrowthCard[];
  syncSummary: RevenueSyncSummary;
  notes: string[];
  hasAnyRevenueData: boolean;
}

export interface RevenueSyncResult {
  jobs: RevenueSyncJobSummary[];
  completedAt: string;
  warnings: string[];
}
