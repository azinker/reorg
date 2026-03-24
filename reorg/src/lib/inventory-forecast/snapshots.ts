import { startOfDay } from "date-fns";
import { db } from "@/lib/db";
import { getForecastInventoryRows, DEFAULT_FORECAST_INVENTORY_SOURCE } from "@/lib/inventory-forecast/inventory-source";
import { inferSnapshotSignal, normalizeRunDate } from "@/lib/inventory-forecast/forecast-engine";
import type { ForecastInventoryRow, SnapshotSignal } from "@/lib/inventory-forecast/types";

export async function captureDailyInventorySnapshots(
  runDate?: Date | string,
  inventoryRows?: ForecastInventoryRow[],
) {
  const snapshotDate = startOfDay(normalizeRunDate(runDate));
  const existingCount = await db.inventorySnapshot.count({
    where: {
      snapshotDate,
      source: DEFAULT_FORECAST_INVENTORY_SOURCE,
    },
  });

  if (existingCount > 0) {
    return {
      snapshotDate: snapshotDate.toISOString(),
      count: existingCount,
      reusedExisting: true,
    };
  }

  const resolvedInventoryRows = inventoryRows ?? (await getForecastInventoryRows());
  const snapshotRows = resolvedInventoryRows.map((row) => ({
    masterRowId: row.masterRowId,
    snapshotDate,
    quantity: row.currentInventory,
    source: DEFAULT_FORECAST_INVENTORY_SOURCE,
    isNearZero: row.currentInventory <= 1,
  }));

  await db.inventorySnapshot.createMany({
    data: snapshotRows,
  });

  await db.auditLog.create({
    data: {
      action: "inventory_snapshot_captured",
      entityType: "inventory_snapshot",
      entityId: snapshotDate.toISOString(),
      details: {
        source: DEFAULT_FORECAST_INVENTORY_SOURCE,
        count: resolvedInventoryRows.length,
      } as never,
    },
  });

  return {
    snapshotDate: snapshotDate.toISOString(),
    count: resolvedInventoryRows.length,
    reusedExisting: false,
  };
}

export async function getSnapshotSignals(
  masterRowIds: string[],
  lookbackDays: number,
  runDate?: Date | string,
) {
  if (masterRowIds.length === 0) return new Map<string, SnapshotSignal>();
  const resolvedRunDate = normalizeRunDate(runDate);
  const snapshots = await db.inventorySnapshot.findMany({
    where: {
      masterRowId: { in: masterRowIds },
      source: DEFAULT_FORECAST_INVENTORY_SOURCE,
    },
    select: {
      masterRowId: true,
      snapshotDate: true,
      quantity: true,
    },
    orderBy: {
      snapshotDate: "asc",
    },
  });

  const grouped = new Map<string, Array<{ snapshotDate: Date; quantity: number }>>();
  for (const snapshot of snapshots) {
    const bucket = grouped.get(snapshot.masterRowId) ?? [];
    bucket.push({ snapshotDate: snapshot.snapshotDate, quantity: snapshot.quantity });
    grouped.set(snapshot.masterRowId, bucket);
  }

  return new Map(
    masterRowIds.map((masterRowId) => [
      masterRowId,
      inferSnapshotSignal(grouped.get(masterRowId) ?? [], resolvedRunDate, lookbackDays),
    ]),
  );
}
