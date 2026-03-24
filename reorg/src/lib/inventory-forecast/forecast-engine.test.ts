import test from "node:test";
import assert from "node:assert/strict";
import type { Platform } from "@prisma/client";
import {
  buildForecastResultLines,
  isReorderRelevantLine,
  salesLineFallsWithinLookback,
} from "@/lib/inventory-forecast/forecast-engine";
import { inventoryForecastExportFileName } from "@/lib/inventory-forecast/export";
import type {
  ForecastControls,
  ForecastInventoryRow,
  ForecastSaleLine,
  SnapshotSignal,
} from "@/lib/inventory-forecast/types";

const RUN_DATE = new Date("2026-03-23T12:00:00.000Z");
const DEFAULT_CONTROLS: ForecastControls = {
  lookbackDays: 14,
  forecastBucket: "DAILY",
  transitDays: 7,
  desiredCoverageDays: 14,
  useOpenInTransit: false,
  reorderRelevantOnly: true,
  mode: "balanced",
};

const INVENTORY_ROW: ForecastInventoryRow = {
  masterRowId: "mr_1",
  sku: "SKU-123",
  title: "Axle Assembly",
  upc: "123456789012",
  imageUrl: null,
  supplierCost: 12.5,
  currentInventory: 2,
};

const SNAPSHOT_SIGNAL: SnapshotSignal = {
  snapshotDaysAvailable: 14,
  suspectedStockout: false,
  nearZeroDays: 0,
};

function buildSales(quantity = 1): ForecastSaleLine[] {
  return Array.from({ length: 14 }, (_, index) => ({
    platform: "TPP_EBAY" as Platform,
    externalOrderId: `order-${index + 1}`,
    externalLineId: `line-${index + 1}`,
    orderDate: new Date(Date.UTC(2026, 2, index + 10, 12, 0, 0)),
    sku: INVENTORY_ROW.sku,
    title: INVENTORY_ROW.title,
    quantity,
    isCancelled: false,
    isReturn: false,
  }));
}

test("buildForecastResultLines subtracts inbound supply and respects overrides", () => {
  const baseArgs = {
    runDate: RUN_DATE,
    inventoryRows: [INVENTORY_ROW],
    salesBySku: new Map([[INVENTORY_ROW.sku, buildSales()]]),
    snapshotSignalsByMasterRowId: new Map([[INVENTORY_ROW.masterRowId, SNAPSHOT_SIGNAL]]),
    truncatedPlatformsBySku: new Map<string, boolean>(),
  };

  const [withoutInbound] = buildForecastResultLines({
    ...baseArgs,
    controls: DEFAULT_CONTROLS,
    openInboundByMasterRowId: new Map(),
  });

  const [withInboundAndOverride] = buildForecastResultLines({
    ...baseArgs,
    controls: { ...DEFAULT_CONTROLS, useOpenInTransit: true },
    openInboundByMasterRowId: new Map([
      [
        INVENTORY_ROW.masterRowId,
        {
          totalQty: 10,
          earliestEta: "2026-03-27T00:00:00.000Z",
          orderIds: ["po-1"],
        },
      ],
    ]),
    overrideByMasterRowId: new Map([[INVENTORY_ROW.masterRowId, 4]]),
  });

  assert.equal(withoutInbound.openInTransitQty, 0);
  assert.equal(withInboundAndOverride.openInTransitQty, 10);
  assert.ok(withInboundAndOverride.recommendedQty < withoutInbound.recommendedQty);
  assert.equal(withInboundAndOverride.overrideQty, 4);
  assert.equal(withInboundAndOverride.finalQty, 4);
  assert.equal(withInboundAndOverride.hasInbound, true);
  assert.ok(withInboundAndOverride.warningFlags.includes("IN_TRANSIT_EXISTS"));
  assert.equal(withoutInbound.recommendedQty % 5, 0);
});

test("isReorderRelevantLine only keeps rows with action or actionable warnings", () => {
  const [line] = buildForecastResultLines({
    controls: DEFAULT_CONTROLS,
    runDate: RUN_DATE,
    inventoryRows: [INVENTORY_ROW],
    salesBySku: new Map(),
    openInboundByMasterRowId: new Map(),
    snapshotSignalsByMasterRowId: new Map([[INVENTORY_ROW.masterRowId, SNAPSHOT_SIGNAL]]),
    truncatedPlatformsBySku: new Map(),
  });

  assert.equal(line.finalQty, 0);
  assert.ok(line.warningFlags.includes("NO_SALES_HISTORY"));
  assert.equal(isReorderRelevantLine(line), false);
  assert.equal(
    isReorderRelevantLine({
      ...line,
      warningFlags: ["IN_TRANSIT_EXISTS"],
      openInTransitQty: 5,
    }),
    true,
  );
  assert.equal(
    isReorderRelevantLine({
      ...line,
      warningFlags: [],
      finalQty: 0,
      openInTransitQty: 0,
    }),
    false,
  );
});

test("salesLineFallsWithinLookback includes the current window and excludes older sales", () => {
  const inWindowSale: ForecastSaleLine = {
    platform: "TT_EBAY" as Platform,
    externalOrderId: "order-in",
    externalLineId: "line-in",
    orderDate: new Date("2026-03-20T12:00:00.000Z"),
    sku: "SKU-555",
    title: "Bracket",
    quantity: 1,
  };
  const oldSale: ForecastSaleLine = {
    ...inWindowSale,
    externalOrderId: "order-old",
    externalLineId: "line-old",
    orderDate: new Date("2026-02-20T12:00:00.000Z"),
  };

  assert.equal(salesLineFallsWithinLookback(inWindowSale, RUN_DATE, 14), true);
  assert.equal(salesLineFallsWithinLookback(oldSale, RUN_DATE, 14), false);
});

test("inventoryForecastExportFileName produces a stable workbook name", () => {
  const runDate = new Date("2026-03-23T12:34:56.000Z");
  const expected = `Inventory_Forecast_${runDate.getFullYear()}-${String(
    runDate.getMonth() + 1,
  ).padStart(2, "0")}-${String(runDate.getDate()).padStart(2, "0")}_${String(
    runDate.getHours(),
  ).padStart(2, "0")}${String(runDate.getMinutes()).padStart(2, "0")}.xlsx`;
  assert.equal(
    inventoryForecastExportFileName(runDate.toISOString()),
    expected,
  );
});
