import type {
  DemandPattern,
  ForecastBucket,
  ForecastConfidence,
  InventorySourceType,
  Platform,
  SupplierOrderStatus,
} from "@prisma/client";

export type ForecastWarningFlag =
  | "LOW_CONFIDENCE"
  | "SUSPECTED_STOCKOUT"
  | "LIMITED_HISTORY"
  | "IN_TRANSIT_EXISTS"
  | "EBAY_HISTORY_TRUNCATED"
  | "NO_SALES_HISTORY";

export type ForecastMode = "simple" | "smart" | "balanced";

export interface ForecastControls {
  lookbackDays: number;
  forecastBucket: ForecastBucket;
  transitDays: number;
  desiredCoverageDays: number;
  useOpenInTransit: boolean;
  reorderRelevantOnly: boolean;
  mode: ForecastMode;
}

export interface ForecastInventoryRow {
  masterRowId: string;
  sku: string;
  title: string;
  upc: string | null;
  imageUrl: string | null;
  supplierCost: number | null;
  currentInventory: number;
  itemAgeDays: number;
}

export interface ForecastSaleLine {
  platform: Platform;
  externalOrderId: string;
  externalLineId: string;
  orderDate: Date;
  sku: string;
  title: string | null;
  quantity: number;
  platformItemId?: string | null;
  platformVariantId?: string | null;
  orderStatus?: string | null;
  cancelledAt?: Date | null;
  currencyCode?: string | null;
  unitPriceAmount?: number | null;
  grossRevenueAmount?: number | null;
  marketplaceFeeAmount?: number | null;
  advertisingFeeAmount?: number | null;
  otherFeeAmount?: number | null;
  taxAmount?: number | null;
  shippingAmount?: number | null;
  netRevenueAmount?: number | null;
  orderGrossRevenueAmount?: number | null;
  orderShippingCollectedAmount?: number | null;
  orderTaxCollectedAmount?: number | null;
  orderDiscountAmount?: number | null;
  orderNetRevenueAmount?: number | null;
  buyerIdentifier?: string | null;
  buyerDisplayLabel?: string | null;
  buyerEmail?: string | null;
  isCancelled?: boolean;
  isReturn?: boolean;
  rawData?: Record<string, unknown>;
  financialRawData?: Record<string, unknown>;
  orderFinancialRawData?: Record<string, unknown>;
}

export interface SalesSyncIssue {
  platform: Platform;
  level: "warning" | "error";
  message: string;
}

export interface RevenueFinancialEventInput {
  integrationId: string;
  platform: Platform;
  eventType: "TRANSACTION" | "BILLING_ACTIVITY" | "SUMMARY";
  classification:
    | "SALE"
    | "TAX"
    | "MARKETPLACE_FEE"
    | "ADVERTISING_FEE"
    | "SHIPPING_LABEL"
    | "ACCOUNT_LEVEL_FEE"
    | "CREDIT"
    | "OTHER";
  externalEventId: string;
  externalOrderId?: string | null;
  externalLineId?: string | null;
  platformItemId?: string | null;
  sku?: string | null;
  occurredAt: Date;
  amount: number;
  currencyCode?: string | null;
  feeType?: string | null;
  feeTypeDescription?: string | null;
  bookingEntry?: string | null;
  isExact?: boolean;
  rawData?: Record<string, unknown>;
}

export interface SalesSyncSummary {
  earliestCoveredAt: string | null;
  latestCoveredAt: string | null;
  platformsSynced: Platform[];
  issues: SalesSyncIssue[];
}

export interface OpenInboundSummary {
  totalQty: number;
  earliestEta: string | null;
  orderIds: string[];
}

export interface SnapshotSignal {
  snapshotDaysAvailable: number;
  suspectedStockout: boolean;
  nearZeroDays: number;
}

export interface PlatformSalesBreakdown {
  platform: string;
  label: string;
  units: number;
}

export interface PlatformCoverage {
  platform: string;
  label: string;
  lineCount: number;
  earliestDate: string | null;
  latestDate: string | null;
  daysCovered: number;
}

export interface ForecastLineResult {
  masterRowId: string;
  sku: string;
  title: string;
  upc: string | null;
  imageUrl: string | null;
  supplierCost: number | null;
  currentInventory: number;
  salesTotalUnits: number;
  salesHistoryDays: number;
  averageDailyDemand: number;
  salesHistorySummary: string;
  salesByPlatform: PlatformSalesBreakdown[];
  transitDemand: number;
  postArrivalDemand: number;
  safetyBuffer: number;
  grossRequiredQty: number;
  openInTransitQty: number;
  openInTransitEta: string | null;
  projectedStockOnArrival: number;
  recommendedQty: number;
  overrideQty: number | null;
  finalQty: number;
  demandPattern: DemandPattern;
  modelUsed: string;
  confidence: ForecastConfidence;
  confidenceNote: string;
  warningFlags: ForecastWarningFlag[];
  backtestError: number | null;
  suspectedStockout: boolean;
  limitedHistory: boolean;
  hasInbound: boolean;
  bucketSeries: number[];
}

export interface ForecastResult {
  controls: ForecastControls;
  effectiveLookbackDays?: number;
  inventorySource: InventorySourceType;
  runDateTime: string;
  confidenceLegend: Record<ForecastConfidence, string>;
  lines: ForecastLineResult[];
  salesSync: SalesSyncSummary;
  platformCoverage?: PlatformCoverage[];
}

export interface SaveForecastRunInput {
  createdById?: string | null;
  result: ForecastResult;
}

export interface SupplierOrderDraftLine {
  masterRowId: string;
  sku: string;
  title: string;
  supplierCost: number | null;
  systemRecommendedQty: number;
  overrideQty: number | null;
  finalQty: number;
}

export interface CreateSupplierOrderInput {
  createdById?: string | null;
  forecastRunId?: string | null;
  orderName?: string | null;
  supplier?: string | null;
  eta: Date;
  notes?: string | null;
  status?: SupplierOrderStatus;
  lines: SupplierOrderDraftLine[];
}

export interface SupplierOrderSummary {
  id: string;
  orderName: string | null;
  supplier: string | null;
  status: SupplierOrderStatus;
  eta: string | null;
  forecastRunId: string | null;
  notes: string | null;
  lineCount: number;
  totalUnits: number;
  totalCost: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierOrderLineSummary {
  sku: string;
  title: string | null;
  supplierCost: number | null;
  finalQty: number;
}
