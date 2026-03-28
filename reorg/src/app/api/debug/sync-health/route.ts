import { NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { deserializeSnapshotFromConfig } from "@/lib/services/ebay-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeJson(v: unknown, maxLen = 500): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
  if (typeof v !== "object") return v;
  try {
    const s = JSON.stringify(v);
    if (s.length > maxLen) return JSON.parse(s.slice(0, maxLen) + '..."truncated":true}');
    return v;
  } catch {
    return String(v);
  }
}

export async function GET() {
  const allPlatforms: Platform[] = ["TPP_EBAY", "TT_EBAY", "SHOPIFY", "BIGCOMMERCE"];

  const integrations = await db.integration.findMany({
    where: { platform: { in: allPlatforms }, enabled: true },
    select: { id: true, platform: true, label: true, config: true, enabled: true },
  });

  const storeReports = [];

  for (const integration of integrations) {
    const config = getIntegrationConfig(integration);

    // Last 5 sync jobs
    const recentJobs = await db.syncJob.findMany({
      where: { integrationId: integration.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    });

    const jobs = recentJobs.map((job) => {
      const errors = Array.isArray(job.errors) ? job.errors : [];
      return {
        id: job.id,
        status: job.status,
        triggeredBy: job.triggeredBy,
        itemsProcessed: job.itemsProcessed,
        itemsCreated: job.itemsCreated,
        itemsUpdated: job.itemsUpdated,
        errorCount: errors.length,
        errors: errors.slice(0, 10).map((e) => safeJson(e, 300)),
        startedAt: job.startedAt?.toISOString() ?? null,
        completedAt: job.completedAt?.toISOString() ?? null,
        createdAt: job.createdAt.toISOString(),
        durationSeconds: job.startedAt && job.completedAt
          ? Math.round((job.completedAt.getTime() - job.startedAt.getTime()) / 1000)
          : null,
      };
    });

    // Sync state from config
    const syncState = config.syncState ?? {};
    const localUsage = isRecord(syncState.localApiUsage) ? syncState.localApiUsage : null;
    const savedSnapshot = deserializeSnapshotFromConfig(syncState.lastRateLimitSnapshot);

    // Recent audit logs for this platform
    const recentAudits = await db.auditLog.findMany({
      where: {
        OR: [
          { action: { startsWith: "sync" }, entityId: integration.id },
          { action: "ebay_sync_completed", entityId: integration.platform },
          { action: { startsWith: "forecast_sales" } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, action: true, entityType: true, entityId: true, createdAt: true, details: true },
    });

    const audits = recentAudits.map((a) => ({
      id: a.id,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      createdAt: a.createdAt.toISOString(),
      details: safeJson(a.details, 800),
    }));

    // DB listing count for this integration
    const listingCount = await db.marketplaceListing.count({
      where: { integration: { platform: integration.platform } },
    });

    // Sales line count for this platform
    const salesLineCount = await db.marketplaceSaleLine.count({
      where: { platform: integration.platform },
    });

    storeReports.push({
      platform: integration.platform,
      label: integration.label,
      integrationId: integration.id,
      listingCountInDb: listingCount,
      salesLineCountInDb: salesLineCount,
      localApiUsage: localUsage,
      savedSnapshot: savedSnapshot
        ? {
            fetchedAt: savedSnapshot.fetchedAt,
            isLocallyTracked: savedSnapshot.isLocallyTracked,
            isDegradedEstimate: savedSnapshot.isDegradedEstimate,
            methods: savedSnapshot.methods.map((m) => ({
              name: m.name,
              count: m.count,
              limit: m.limit,
              remaining: m.remaining,
            })),
          }
        : "none",
      recentSyncJobs: jobs,
      recentAuditLogs: audits,
    });
  }

  // Master row + unmatched counts
  const masterRowCount = await db.masterRow.count();
  const unmatchedCount = await db.marketplaceListing.count({
    where: { masterRowId: { equals: undefined } },
  });

  return NextResponse.json(
    {
      timestamp: new Date().toISOString(),
      summary: {
        masterRows: masterRowCount,
        unmatchedListings: unmatchedCount,
      },
      stores: storeReports,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
