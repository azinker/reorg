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

export interface ForecastControls {
  lookbackDays: number;
  forecastBucket: ForecastBucket;
  transitDays: number;
  desiredCoverageDays: number;
  useOpenInTransit: boolean;
  reorderRelevantOnly: boolean;
  mode: "balanced";
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
  isCancelled?: boolean;
  isReturn?: boolean;
  rawData?: Record<string, unknown>;
}

export interface SalesSyncIssue {
  platform: Platform;
  level: "warning" | "error";
  message: string;
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
  inventorySource: InventorySourceType;
  runDateTime: string;
  confidenceLegend: Record<ForecastConfidence, string>;
  lines: ForecastLineResult[];
  salesSync: SalesSyncSummary;
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
  supplier?: string | null;
  eta: Date;
  notes?: string | null;
  status?: SupplierOrderStatus;
  lines: SupplierOrderDraftLine[];
}

export interface SupplierOrderSummary {
  id: string;
  supplier: string | null;
  status: SupplierOrderStatus;
  eta: string | null;
  forecastRunId: string | null;
  notes: string | null;
  lineCount: number;
  totalUnits: number;
  createdAt: string;
  updatedAt: string;
}
