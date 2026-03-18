import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PLATFORM_FULL_LABELS, PLATFORM_LABELS } from "@/lib/integrations/types";
import { getAutomationHealthSnapshot } from "@/lib/services/automation-health";
import type { Platform } from "@prisma/client";

type Severity = "critical" | "warning" | "info";
type ErrorCategory =
  | "stale-pull"
  | "dead-webhook"
  | "sync-failure"
  | "sync-warning"
  | "missing-data"
  | "system";

interface ErrorEntry {
  id: string;
  severity: Severity;
  category: ErrorCategory;
  summary: string;
  technicalDetails: string;
  store: string;
  storeAcronym: string;
  timestamp: string;
  occurredAt: string;
  recommendedAction: string;
  actionLabel: string | null;
  actionHref: string | null;
  priority: number;
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

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return stringifyError(error);
}

function getErrorSku(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "sku" in error &&
    typeof (error as { sku?: unknown }).sku === "string"
  ) {
    return (error as { sku: string }).sku;
  }
  return null;
}

function summarizeSyncErrors(rawErrors: unknown[]): string[] {
  const grouped = new Map<
    string,
    { count: number; skus: string[] }
  >();

  for (const rawError of rawErrors) {
    const message = getErrorMessage(rawError).trim() || "Unknown error";
    const sku = getErrorSku(rawError);
    const existing = grouped.get(message);
    if (existing) {
      existing.count += 1;
      if (sku && sku !== "_global" && existing.skus.length < 3 && !existing.skus.includes(sku)) {
        existing.skus.push(sku);
      }
      continue;
    }

    grouped.set(message, {
      count: 1,
      skus: sku && sku !== "_global" ? [sku] : [],
    });
  }

  return [...grouped.entries()].map(([message, meta]) => {
    const normalizedMessage =
      message === "GetItem returned no payload for this changed listing."
        ? "eBay returned no usable GetItem payload for these changed listings."
        : message === "GetItem returned no item payload for this changed listing."
          ? "eBay returned no usable GetItem payload for these changed listings."
          : message;

    if (meta.count === 1) {
      if (meta.skus.length === 1 && !normalizedMessage.includes(meta.skus[0])) {
        return `${meta.skus[0]}: ${normalizedMessage}`;
      }
      return normalizedMessage;
    }

    const skuSuffix =
      meta.skus.length > 0
        ? ` Example item IDs: ${meta.skus.join(", ")}${meta.count > meta.skus.length ? ", ..." : ""}.`
        : "";

    return `${normalizedMessage} (${meta.count} listings).${skuSuffix}`;
  });
}

function getSeverityRank(severity: Severity) {
  if (severity === "critical") return 0;
  if (severity === "warning") return 1;
  return 2;
}

export async function GET() {
  try {
    const [masterRows, syncJobs, shippingRates, integrations, automationHealth] = await Promise.all([
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
      getAutomationHealthSnapshot(),
    ]);

    const rateKeys = new Set(shippingRates.map((rate) => rate.weightKey.trim().toUpperCase()));
    const entries: ErrorEntry[] = [];
    const latestCleanCompletedByIntegration = new Map<string, Date>();
    const latestUnrecoveredFailureByIntegration = new Map<string, Date>();
    for (const job of syncJobs) {
      const rawErrors = Array.isArray(job.errors) ? job.errors : [];
      if (job.status !== "COMPLETED" || rawErrors.length > 0 || !job.completedAt) continue;
      if (latestCleanCompletedByIntegration.has(job.integrationId)) continue;
      latestCleanCompletedByIntegration.set(job.integrationId, job.completedAt);
    }
    for (const job of syncJobs) {
      if (job.status !== "FAILED") continue;
      const occurredAt = job.completedAt ?? job.startedAt ?? job.createdAt;
      const recoveredAfterFailure =
        !!job.integration.lastSyncAt &&
        job.integration.lastSyncAt.getTime() > occurredAt.getTime();
      if (recoveredAfterFailure) continue;
      if (latestUnrecoveredFailureByIntegration.has(job.integrationId)) continue;
      latestUnrecoveredFailureByIntegration.set(job.integrationId, occurredAt);
    }

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
        category: "missing-data",
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
        recommendedAction:
          "Fill in the missing internal values from Dashboard, Import, or Shipping Rates before relying on profit calculations.",
        actionLabel: "Fix Data",
        actionHref: "/dashboard",
        priority: missingShippingTier ? 50 : 55,
      });
    }

    for (const job of syncJobs) {
      const rawErrors = Array.isArray(job.errors) ? job.errors : [];
      if (job.status === "COMPLETED" && rawErrors.length === 0) continue;

      const platform = job.integration.platform as Platform;
      const occurredAt = job.completedAt ?? job.startedAt ?? job.createdAt;
      const storeLabel = PLATFORM_FULL_LABELS[platform];
      const storeAcronym = PLATFORM_LABELS[platform];
      const recoveredAfterFailure =
        job.status === "FAILED" &&
        !!job.integration.lastSyncAt &&
        job.integration.lastSyncAt.getTime() > occurredAt.getTime();

      if (job.status === "FAILED") {
        if (recoveredAfterFailure) continue;
        const supersededByLaterFailure =
          !!latestUnrecoveredFailureByIntegration.get(job.integrationId) &&
          latestUnrecoveredFailureByIntegration.get(job.integrationId)!.getTime() >
            occurredAt.getTime();
        if (supersededByLaterFailure) continue;
        entries.push({
          id: `sync-${job.id}`,
          severity: "critical",
          category: "sync-failure",
          summary: `${storeLabel} sync failed`,
          technicalDetails: rawErrors.length
            ? summarizeSyncErrors(rawErrors).join("\n")
            : "The sync job failed without a captured error payload.",
          store: storeLabel,
          storeAcronym,
          timestamp: formatTimestamp(occurredAt),
          occurredAt: occurredAt.toISOString(),
          recommendedAction:
            "Open Sync and run a manual pull. If it fails again, review the integration credentials and recent job details.",
          actionLabel: "Run Sync Now",
          actionHref: "/sync",
          priority: 20,
        });
        continue;
      }

      if (rawErrors.length > 0) {
        const recoveredByLaterCleanSync =
          !!job.completedAt &&
          !!latestCleanCompletedByIntegration.get(job.integrationId) &&
          latestCleanCompletedByIntegration.get(job.integrationId)!.getTime() >
            job.completedAt.getTime();
        const supersededByLaterFailure =
          !!job.completedAt &&
          !!latestUnrecoveredFailureByIntegration.get(job.integrationId) &&
          latestUnrecoveredFailureByIntegration.get(job.integrationId)!.getTime() >
            job.completedAt.getTime();
        if (recoveredByLaterCleanSync || supersededByLaterFailure) continue;

        entries.push({
          id: `sync-warning-${job.id}`,
          severity: "info",
          category: "sync-warning",
          summary: `${storeLabel} sync completed with skipped rows or warnings`,
          technicalDetails: [
            `Processed: ${job.itemsProcessed}`,
            `Created: ${job.itemsCreated}`,
            `Updated: ${job.itemsUpdated}`,
            ...summarizeSyncErrors(rawErrors),
          ].join("\n"),
          store: storeLabel,
          storeAcronym,
          timestamp: formatTimestamp(occurredAt),
          occurredAt: occurredAt.toISOString(),
          recommendedAction:
            "Review the skipped rows in the job details and fix the affected data before the next pull.",
          actionLabel: "Review Job",
          actionHref: "/engine-room",
          priority: 70,
        });
      }
    }

    for (const item of automationHealth.integrationHealth) {
      if (latestUnrecoveredFailureByIntegration.has(item.integrationId)) {
        continue;
      }

      const timestampSource = item.lastSyncAt ?? item.lastWebhookAt ?? new Date().toISOString();
      const timestampDate = new Date(timestampSource);
      const hasMissingWebhook = item.webhookExpected && item.webhookStatus === "missing";
      const needsPullAttention = item.status === "attention";
      const isDelayedPull = item.status === "delayed";

      if (item.combinedStatus === "attention") {
        entries.push({
          id: `automation-attention-${item.integrationId}`,
          severity: "critical",
          category: hasMissingWebhook ? "dead-webhook" : "stale-pull",
          summary: hasMissingWebhook
            ? `${item.label} is behind and webhook coverage is missing`
            : `${item.label} updates need attention`,
          technicalDetails: [
            `Store: ${item.label}`,
            `Platform: ${item.platform}`,
            `Update health: ${item.syncMessage}`,
            `Last completed pull: ${item.lastSyncAt ? formatTimestamp(new Date(item.lastSyncAt)) : "Never"}`,
            item.nextDueAt
              ? `Next automatic check: ${formatTimestamp(new Date(item.nextDueAt))}`
              : "Next automatic check: Not scheduled",
            item.running ? "A pull is running now." : "No pull is running right now.",
            item.webhookExpected ? `Webhook status: ${item.webhookMessage}` : "Webhook status: Not applicable",
            `Recommended action: ${item.recommendedAction}`,
          ].join("\n"),
          store: item.label,
          storeAcronym:
            PLATFORM_LABELS[item.platform as Platform] ?? item.platform,
          timestamp: formatTimestamp(timestampDate),
          occurredAt: timestampDate.toISOString(),
          recommendedAction: item.recommendedAction,
          actionLabel: hasMissingWebhook ? "Check Webhooks" : "Run Sync Now",
          actionHref: hasMissingWebhook ? "/integrations" : "/sync",
          priority: hasMissingWebhook ? 10 : 15,
        });
      }

      if (isDelayedPull && !hasMissingWebhook) {
        entries.push({
          id: `automation-delayed-${item.integrationId}`,
          severity: "warning",
          category: "stale-pull",
          summary: `${item.label} updates are behind schedule`,
          technicalDetails: [
            `Store: ${item.label}`,
            `Platform: ${item.platform}`,
            `Update health: ${item.syncMessage}`,
            `Last completed pull: ${item.lastSyncAt ? formatTimestamp(new Date(item.lastSyncAt)) : "Never"}`,
            item.nextDueAt
              ? `Next automatic check: ${formatTimestamp(new Date(item.nextDueAt))}`
              : "Next automatic check: Not scheduled",
            item.running ? "A pull is running now." : "No pull is running right now.",
            `Recommended action: ${item.recommendedAction}`,
          ].join("\n"),
          store: item.label,
          storeAcronym:
            PLATFORM_LABELS[item.platform as Platform] ?? item.platform,
          timestamp: formatTimestamp(timestampDate),
          occurredAt: timestampDate.toISOString(),
          recommendedAction: item.recommendedAction,
          actionLabel: "Run Sync Now",
          actionHref: "/sync",
          priority: 30,
        });
      }

      if (hasMissingWebhook && !needsPullAttention) {
        entries.push({
          id: `automation-webhook-missing-${item.integrationId}`,
          severity: "warning",
          category: "dead-webhook",
          summary: `${item.label} is missing store change notices`,
          technicalDetails: [
            `Store: ${item.label}`,
            `Platform: ${item.platform}`,
            `Webhook health: ${item.webhookMessage}`,
            `Last completed pull: ${item.lastSyncAt ? formatTimestamp(new Date(item.lastSyncAt)) : "Never"}`,
            "Scheduled pulls are still the safety net, but webhook-triggered refreshes will not be available until notices arrive.",
            `Recommended action: ${item.recommendedAction}`,
          ].join("\n"),
          store: item.label,
          storeAcronym:
            PLATFORM_LABELS[item.platform as Platform] ?? item.platform,
          timestamp: formatTimestamp(timestampDate),
          occurredAt: timestampDate.toISOString(),
          recommendedAction: item.recommendedAction,
          actionLabel: "Check Webhooks",
          actionHref: "/integrations",
          priority: 40,
        });
      }

      if (item.webhookExpected && item.webhookStatus === "quiet") {
        entries.push({
          id: `automation-webhook-quiet-${item.integrationId}`,
          severity: "info",
          category: "dead-webhook",
          summary: `${item.label} webhook traffic has gone quiet`,
          technicalDetails: [
            `Store: ${item.label}`,
            `Platform: ${item.platform}`,
            `Webhook health: ${item.webhookMessage}`,
            `Last recorded notice: ${item.lastWebhookAt ? formatTimestamp(new Date(item.lastWebhookAt)) : "Never"}`,
            "This can be normal if the store was quiet, but it is worth checking if you expected recent changes to trigger early refreshes.",
            `Recommended action: ${item.recommendedAction}`,
          ].join("\n"),
          store: item.label,
          storeAcronym:
            PLATFORM_LABELS[item.platform as Platform] ?? item.platform,
          timestamp: formatTimestamp(timestampDate),
          occurredAt: timestampDate.toISOString(),
          recommendedAction: item.recommendedAction,
          actionLabel: "Check Webhooks",
          actionHref: "/integrations",
          priority: 80,
        });
      }
    }

    if (entries.length === 0) {
      const latestIntegration = integrations.find((integration) => integration.lastSyncAt != null);
      const fallbackTime = latestIntegration?.lastSyncAt ?? new Date();
      entries.push({
        id: "status-ok",
        severity: "info",
        category: "system",
        summary: "No blocking data issues detected",
        technicalDetails:
          "All connected rows currently have the required internal data and there are no captured sync failures in the recent job history.",
        store: "System",
        storeAcronym: "SYS",
        timestamp: formatTimestamp(fallbackTime),
        occurredAt: fallbackTime.toISOString(),
        recommendedAction: "No action needed.",
        actionLabel: null,
        actionHref: null,
        priority: 999,
      });
    }

    return NextResponse.json({
      data: entries.sort(
        (a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          if (getSeverityRank(a.severity) !== getSeverityRank(b.severity)) {
            return getSeverityRank(a.severity) - getSeverityRank(b.severity);
          }
          return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
        },
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
