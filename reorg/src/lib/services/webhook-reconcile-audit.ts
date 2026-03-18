import { db } from "@/lib/db";
import type { WebhookPlatform } from "@/lib/services/webhook-sync";

interface WebhookReconcileAuditInput {
  platform: WebhookPlatform;
  integrationId: string;
  syncJobId: string;
  productIds: string[];
  deletedProductIds: string[];
  changedVariantIds: string[];
  prunedListings: number;
  itemsProcessed: number;
  itemsCreated: number;
  itemsUpdated: number;
  durationMs: number;
  error?: string | null;
}

function buildDetails(input: WebhookReconcileAuditInput) {
  return {
    platform: input.platform,
    syncJobId: input.syncJobId,
    productCount: input.productIds.length,
    deletedProductCount: input.deletedProductIds.length,
    changedVariantCount: input.changedVariantIds.length,
    prunedListings: input.prunedListings,
    itemsProcessed: input.itemsProcessed,
    itemsCreated: input.itemsCreated,
    itemsUpdated: input.itemsUpdated,
    durationMs: input.durationMs,
    error: input.error ?? null,
  };
}

export async function recordWebhookReconcileCompleted(
  input: WebhookReconcileAuditInput,
) {
  await db.auditLog.create({
    data: {
      action: "webhook_reconcile_completed",
      entityType: "integration",
      entityId: input.integrationId,
      details: buildDetails(input),
    },
  });
}

export async function recordWebhookReconcileFailed(
  input: WebhookReconcileAuditInput,
) {
  await db.auditLog.create({
    data: {
      action: "webhook_reconcile_failed",
      entityType: "integration",
      entityId: input.integrationId,
      details: buildDetails(input),
    },
  });
}
