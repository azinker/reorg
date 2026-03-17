import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { runShopifySync } from "@/lib/services/shopify-sync";
import { runEbayTppSync } from "@/lib/services/ebay-tpp-sync";
import { runBigCommerceSync } from "@/lib/services/bigcommerce-sync";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  try {
    const integration = await db.integration.findFirst({
      where: {
        OR: [
          { id: integrationId },
          { platform: integrationId.toUpperCase() as Platform },
        ],
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: `Integration "${integrationId}" not found` },
        { status: 404 }
      );
    }

    if (!integration.enabled) {
      return NextResponse.json(
        { error: `Integration "${integration.label}" is not connected` },
        { status: 400 }
      );
    }

    if (integration.platform === Platform.SHOPIFY) {
      const job = await db.syncJob.findFirst({
        where: { integrationId: integration.id, status: "RUNNING" },
      });
      if (job) {
        return NextResponse.json({
          data: { jobId: job.id, status: "ALREADY_RUNNING" },
        });
      }

      runShopifySync().catch((err) =>
        console.error("[sync] SHOPIFY background error:", err)
      );

      await new Promise((r) => setTimeout(r, 500));

      const newJob = await db.syncJob.findFirst({
        where: { integrationId: integration.id },
        orderBy: { createdAt: "desc" },
      });

      return NextResponse.json({
        data: {
          jobId: newJob?.id ?? null,
          status: "STARTED",
          message: "Shopify sync started in background. Poll GET for progress.",
        },
      });
    }

    if (integration.platform === Platform.TPP_EBAY) {
      const job = await db.syncJob.findFirst({
        where: { integrationId: integration.id, status: "RUNNING" },
      });
      if (job) {
        return NextResponse.json({
          data: { jobId: job.id, status: "ALREADY_RUNNING" },
        });
      }

      runEbayTppSync().catch((err) =>
        console.error("[sync] TPP_EBAY background error:", err)
      );

      await new Promise((r) => setTimeout(r, 500));

      const newJob = await db.syncJob.findFirst({
        where: { integrationId: integration.id },
        orderBy: { createdAt: "desc" },
      });

      return NextResponse.json({
        data: {
          jobId: newJob?.id ?? null,
          status: "STARTED",
          message: "eBay TPP sync started in background. Poll GET for progress.",
        },
      });
    }

    if (integration.platform === Platform.BIGCOMMERCE) {
      const job = await db.syncJob.findFirst({
        where: { integrationId: integration.id, status: "RUNNING" },
      });
      if (job) {
        return NextResponse.json({
          data: { jobId: job.id, status: "ALREADY_RUNNING" },
        });
      }

      const result = await runBigCommerceSync();

      return NextResponse.json({
        data: {
          jobId: result.syncJobId,
          status: result.status.toUpperCase(),
          itemsProcessed: result.itemsProcessed,
          itemsCreated: result.itemsCreated,
          itemsUpdated: result.itemsUpdated,
          unmatchedCount: result.unmatchedCount,
          errors: result.errors,
          durationMs: result.durationMs,
          message: "BigCommerce sync completed.",
        },
      });
    }

    return NextResponse.json(
      {
        error: `Sync for ${integration.platform} is not yet implemented`,
      },
      { status: 501 }
    );
  } catch (error) {
    console.error(`[sync] ${integrationId} failed`, error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Sync failed",
      },
      { status: 500 }
    );
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  const { integrationId } = await params;

  try {
    const integration = await db.integration.findFirst({
      where: {
        OR: [
          { id: integrationId },
          { platform: integrationId.toUpperCase() as Platform },
        ],
      },
    });

    if (!integration) {
      return NextResponse.json(
        { error: `Integration "${integrationId}" not found` },
        { status: 404 }
      );
    }

    const lastJob = await db.syncJob.findFirst({
      where: { integrationId: integration.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      data: {
        integrationId: integration.id,
        platform: integration.platform,
        label: integration.label,
        enabled: integration.enabled,
        lastSyncAt: integration.lastSyncAt,
        lastJob: lastJob
          ? {
              id: lastJob.id,
              status: lastJob.status,
              itemsProcessed: lastJob.itemsProcessed,
              itemsCreated: lastJob.itemsCreated,
              itemsUpdated: lastJob.itemsUpdated,
              errors: lastJob.errors,
              startedAt: lastJob.startedAt,
              completedAt: lastJob.completedAt,
            }
          : null,
      },
    });
  } catch (error) {
    console.error(`[sync] GET ${integrationId} failed`, error);
    return NextResponse.json(
      { error: "Failed to fetch sync status" },
      { status: 500 }
    );
  }
}
