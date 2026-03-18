import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PLATFORM_FULL_LABELS, PLATFORM_LABELS } from "@/lib/integrations/types";
import type { Platform } from "@prisma/client";

type Severity = "critical" | "warning" | "info";

interface ErrorEntry {
  id: string;
  severity: Severity;
  summary: string;
  technicalDetails: string;
  store: string;
  storeAcronym: string;
  timestamp: string;
  occurredAt: string;
}

function formatTimestamp(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  }).format(date);
}

function normalizeWeightKey(weight: string | null): string | null {
  if (!weight) return null;
  const trimmed = weight.trim().toUpperCase();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return trimmed;
  if (trimmed.endsWith("LBS")) return trimmed;
  return trimmed;
}

function stringifyError(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

export async function GET() {
  try {
    const [masterRows, syncJobs, shippingRates, integrations] = await Promise.all([
      db.masterRow.findMany({
        where: {
          OR: [
            { weight: null },
            { supplierCost: null },
            { supplierShipping: null },
          ],
        },
        orderBy: { updatedAt: "desc" },
        take: 300,
      }),
      db.syncJob.findMany({
        include: { integration: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      db.shippingRate.findMany({
        where: { cost: { not: null } },
      }),
      db.integration.findMany(),
    ]);

    const rateKeys = new Set(shippingRates.map((rate) => rate.weightKey.trim().toUpperCase()));
    const entries: ErrorEntry[] = [];

    for (const row of masterRows) {
      const missing: string[] = [];
      if (!row.weight?.trim()) missing.push("weight");
      if (row.supplierCost == null) missing.push("supplier cost");
      if (row.supplierShipping == null) missing.push("supplier shipping cost");

      const normalizedWeight = normalizeWeightKey(row.weight);
      const missingShippingTier =
        normalizedWeight &&
        row.shippingCostOverride == null &&
        !rateKeys.has(normalizedWeight);

      if (missingShippingTier) {
        missing.push(`shipping rate for ${normalizedWeight}`);
      }

      if (missing.length === 0) continue;

      entries.push({
        id: `data-${row.id}`,
        severity: "warning",
        summary: `${row.sku} is missing internal data`,
        technicalDetails: [
          `SKU: ${row.sku}`,
          `Title: ${row.title ?? "Untitled"}`,
          `Missing: ${missing.join(", ")}`,
          "Fix this from the dashboard, import page, or shipping-rates page before relying on profit calculations.",
        ].join("\n"),
        store: "Internal Product Data",
        storeAcronym: "DATA",
        timestamp: formatTimestamp(row.updatedAt),
        occurredAt: row.updatedAt.toISOString(),
      });
    }

    for (const job of syncJobs) {
      const rawErrors = Array.isArray(job.errors) ? job.errors : [];
      if (job.status === "COMPLETED" && rawErrors.length === 0) continue;

      const platform = job.integration.platform as Platform;
      const occurredAt = job.completedAt ?? job.startedAt ?? job.createdAt;
      const storeLabel = PLATFORM_FULL_LABELS[platform];
      const storeAcronym = PLATFORM_LABELS[platform];

      if (job.status === "FAILED") {
        entries.push({
          id: `sync-${job.id}`,
          severity: "critical",
          summary: `${storeLabel} sync failed`,
          technicalDetails: rawErrors.length
            ? rawErrors.map(stringifyError).join("\n")
            : "The sync job failed without a captured error payload.",
          store: storeLabel,
          storeAcronym,
          timestamp: formatTimestamp(occurredAt),
          occurredAt: occurredAt.toISOString(),
        });
        continue;
      }

      if (rawErrors.length > 0) {
        entries.push({
          id: `sync-warning-${job.id}`,
          severity: "info",
          summary: `${storeLabel} sync completed with skipped rows or warnings`,
          technicalDetails: [
            `Processed: ${job.itemsProcessed}`,
            `Created: ${job.itemsCreated}`,
            `Updated: ${job.itemsUpdated}`,
            ...rawErrors.map(stringifyError),
          ].join("\n"),
          store: storeLabel,
          storeAcronym,
          timestamp: formatTimestamp(occurredAt),
          occurredAt: occurredAt.toISOString(),
        });
      }
    }

    if (entries.length === 0) {
      const latestIntegration = integrations.find((integration) => integration.lastSyncAt != null);
      const fallbackTime = latestIntegration?.lastSyncAt ?? new Date();
      entries.push({
        id: "status-ok",
        severity: "info",
        summary: "No blocking data issues detected",
        technicalDetails:
          "All connected rows currently have the required internal data and there are no captured sync failures in the recent job history.",
        store: "System",
        storeAcronym: "SYS",
        timestamp: formatTimestamp(fallbackTime),
        occurredAt: fallbackTime.toISOString(),
      });
    }

    return NextResponse.json({
      data: entries.sort(
        (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
      ),
    });
  } catch (error) {
    console.error("[errors] Failed to fetch error summary", error);
    return NextResponse.json(
      { error: "Failed to fetch error summary" },
      { status: 500 },
    );
  }
}
