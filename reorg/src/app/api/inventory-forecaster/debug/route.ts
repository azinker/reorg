import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getEnabledForecastIntegrations } from "@/lib/inventory-forecast/marketplace-sales";

export async function GET() {
  try {
    const [
      integrations,
      latestSyncAudit,
      recentSyncAudits,
      salesLineCountByPlatform,
      masterRowCount,
      latestForecastRun,
      recentErrors,
    ] = await Promise.all([
      getEnabledForecastIntegrations().then((rows) =>
        rows.map((r) => ({
          id: r.id,
          platform: r.platform,
          label: r.label,
          hasConfig: r.config != null && Object.keys(r.config as object).length > 0,
        })),
      ),
      db.auditLog.findFirst({
        where: { action: "forecast_sales_history_synced" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, details: true },
      }),
      db.auditLog.findMany({
        where: { action: "forecast_sales_history_synced" },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { createdAt: true, details: true },
      }),
      db.marketplaceSaleLine.groupBy({
        by: ["platform"],
        _count: { _all: true },
        _min: { orderDate: true },
        _max: { orderDate: true },
      }),
      db.masterRow.count(),
      db.forecastRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          lookbackDays: true,
          forecastBucket: true,
          transitDays: true,
          desiredCoverageDays: true,
          mode: true,
          _count: { select: { lines: true } },
        },
      }),
      db.auditLog.findMany({
        where: {
          action: { in: ["forecast_sales_history_synced"] },
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { createdAt: true, action: true, details: true },
      }),
    ]);

    const salesCoverage = salesLineCountByPlatform.map((row) => ({
      platform: row.platform,
      lineCount: row._count._all,
      earliest: row._min.orderDate?.toISOString().slice(0, 10) ?? null,
      latest: row._max.orderDate?.toISOString().slice(0, 10) ?? null,
    }));

    const latestSyncDetails =
      latestSyncAudit?.details && typeof latestSyncAudit.details === "object"
        ? (latestSyncAudit.details as Record<string, unknown>)
        : null;

    const recentSyncHistory = recentSyncAudits.map((audit) => {
      const d =
        audit.details && typeof audit.details === "object"
          ? (audit.details as Record<string, unknown>)
          : {};
      return {
        timestamp: audit.createdAt.toISOString(),
        lookbackDays: d.lookbackDays ?? null,
        totalLinesSynced: d.totalLinesSynced ?? null,
        issues: Array.isArray(d.issues) ? d.issues : [],
        truncatedPlatforms: d.truncatedPlatforms ?? [],
      };
    });

    return NextResponse.json({
      timestamp: new Date().toISOString(),
      enabledIntegrations: integrations,
      masterRowCount,
      salesCoverage,
      latestSalesSync: latestSyncAudit
        ? {
            timestamp: latestSyncAudit.createdAt.toISOString(),
            ageMinutes: Math.round(
              (Date.now() - latestSyncAudit.createdAt.getTime()) / 60_000,
            ),
            lookbackDays: latestSyncDetails?.lookbackDays ?? null,
            totalLinesSynced: latestSyncDetails?.totalLinesSynced ?? null,
            issues: latestSyncDetails?.issues ?? [],
            truncatedPlatforms: latestSyncDetails?.truncatedPlatforms ?? [],
          }
        : null,
      recentSyncHistory,
      latestForecastRun: latestForecastRun
        ? {
            id: latestForecastRun.id,
            timestamp: latestForecastRun.createdAt.toISOString(),
            ageMinutes: Math.round(
              (Date.now() - latestForecastRun.createdAt.getTime()) / 60_000,
            ),
            lineCount: latestForecastRun._count.lines,
            controls: {
              lookbackDays: latestForecastRun.lookbackDays,
              forecastBucket: latestForecastRun.forecastBucket,
              transitDays: latestForecastRun.transitDays,
              desiredCoverageDays: latestForecastRun.desiredCoverageDays,
              mode: latestForecastRun.mode,
            },
          }
        : null,
      recentAuditEntries: recentErrors.map((e) => ({
        timestamp: e.createdAt.toISOString(),
        action: e.action,
        details: e.details,
      })),
    });
  } catch (error) {
    console.error("[inventory-forecaster/debug] GET failed", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Debug endpoint failed",
      },
      { status: 500 },
    );
  }
}
