import { db } from "@/lib/db";
import { createLabelFormatterReship } from "@/lib/label-formatter/reship";
import type { LabelFormatterReshipInput } from "@/lib/label-formatter/types";
import { neweggShipItemsFromRow } from "@/lib/marketplace-orders/newegg-map";
import type { MarketplaceShipInput } from "@/lib/marketplace-orders/types";
import { shipNeweggOrder } from "@/lib/services/newegg";

export type MarketplaceShipResult = {
  batchId: string;
  zipBuffer: Buffer;
  successCount: number;
  failedCount: number;
  trackingPushedCount: number;
  trackingFailedCount: number;
  firstError: string | null;
};

export async function shipNeweggOrdersWithLabels(
  input: MarketplaceShipInput,
  actorUserId: string,
): Promise<MarketplaceShipResult> {
  const labelInput: LabelFormatterReshipInput = {
    rows: input.rows.map((row) => ({
      note: row.note,
      orderNumber: row.orderNumber,
      sourceStore: "NEWEGG",
      buyerName: row.buyerName,
      addressLine1: row.addressLine1,
      addressLine2: row.addressLine2,
      city: row.city,
      state: row.state,
      zipCode: row.zipCode,
      lineItems: row.lineItems.map((item) => ({
        sku: item.sku,
        quantity: item.quantity,
      })),
    })),
    serviceClass: input.serviceClass,
    providerKey: input.providerKey,
    seriesCode: input.seriesCode,
    fromAddress: input.fromAddress,
  };

  const labelResult = await createLabelFormatterReship(labelInput, actorUserId);

  let trackingPushedCount = 0;
  let trackingFailedCount = 0;
  let firstError = labelResult.firstError;

  if (input.confirmMarketplaceTracking) {
    const batch = await db.labelFormatterReshipBatch.findUnique({
      where: { id: labelResult.batchId },
      include: { rows: true },
    });

    const rowsByOrder = new Map(
      input.rows.map((row) => [row.orderNumber.trim(), row]),
    );

    for (const reshipRow of batch?.rows ?? []) {
      if (reshipRow.status !== "created" || !reshipRow.trackingNumber) continue;
      const sourceRow = rowsByOrder.get(reshipRow.orderNumber.trim());
      if (!sourceRow) continue;

      try {
        await shipNeweggOrder({
          orderNumber: reshipRow.orderNumber,
          trackingNumber: reshipRow.trackingNumber,
          shipService: sourceRow.shipService,
          items: neweggShipItemsFromRow(sourceRow),
        });
        trackingPushedCount += 1;
        await db.auditLog.create({
          data: {
            userId: actorUserId,
            action: "MARKETPLACE_ORDER_TRACKING_PUSHED",
            entityType: "LabelFormatterReshipRow",
            entityId: reshipRow.id,
            details: {
              store: "NEWEGG",
              orderNumber: reshipRow.orderNumber,
              trackingNumber: reshipRow.trackingNumber,
            },
          },
        });
      } catch (error) {
        trackingFailedCount += 1;
        const message = error instanceof Error ? error.message : "Failed to push tracking to Newegg.";
        if (!firstError) firstError = message;
        await db.auditLog.create({
          data: {
            userId: actorUserId,
            action: "MARKETPLACE_ORDER_TRACKING_FAILED",
            entityType: "LabelFormatterReshipRow",
            entityId: reshipRow.id,
            details: {
              store: "NEWEGG",
              orderNumber: reshipRow.orderNumber,
              trackingNumber: reshipRow.trackingNumber,
              error: message,
            },
          },
        });
      }
    }
  }

  return {
    batchId: labelResult.batchId,
    zipBuffer: labelResult.zipBuffer,
    successCount: labelResult.successCount,
    failedCount: labelResult.failedCount,
    trackingPushedCount,
    trackingFailedCount,
    firstError,
  };
}
