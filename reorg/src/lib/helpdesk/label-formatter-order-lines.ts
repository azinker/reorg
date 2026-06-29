import { db } from "@/lib/db";
import type { LabelFormatterLineItem } from "@/lib/label-formatter/types";

export type LabelFormatterOrderLineInput = {
  sku: string | null;
  quantity: number;
  itemId: string;
};

function mergeQuantities(
  lines: Array<{ sku: string; quantity: number }>,
): LabelFormatterLineItem[] {
  const bySku = new Map<string, number>();
  for (const line of lines) {
    const quantity = Number(line.quantity);
    bySku.set(
      line.sku,
      (bySku.get(line.sku) ?? 0) + (Number.isInteger(quantity) && quantity > 0 ? quantity : 1),
    );
  }
  return [...bySku.entries()].map(([sku, quantity]) => ({ sku, quantity }));
}

/**
 * Build Label Formatter line items from eBay order lines, falling back to a
 * unique catalog SKU per item id when eBay omits the variation SKU.
 */
export async function resolveLabelFormatterOrderLineItems(
  integrationId: string,
  lines: LabelFormatterOrderLineInput[],
): Promise<LabelFormatterLineItem[]> {
  const missingItemIds = [
    ...new Set(
      lines
        .filter((line) => !line.sku?.trim() && line.itemId.trim())
        .map((line) => line.itemId.trim()),
    ),
  ];

  const skuByItemId = new Map<string, string>();
  if (missingItemIds.length > 0) {
    const listings = await db.marketplaceListing.findMany({
      where: {
        integrationId,
        platformItemId: { in: missingItemIds },
      },
      select: { platformItemId: true, sku: true },
    });

    const distinctSkusByItemId = new Map<string, Set<string>>();
    for (const listing of listings) {
      const sku = listing.sku?.trim();
      if (!sku) continue;
      const bucket = distinctSkusByItemId.get(listing.platformItemId) ?? new Set<string>();
      bucket.add(sku);
      distinctSkusByItemId.set(listing.platformItemId, bucket);
    }

    for (const [itemId, skus] of distinctSkusByItemId) {
      if (skus.size === 1) {
        skuByItemId.set(itemId, [...skus][0]!);
      }
    }
  }

  const resolved: Array<{ sku: string; quantity: number }> = [];
  for (const line of lines) {
    const sku = line.sku?.trim() || skuByItemId.get(line.itemId.trim()) || null;
    if (!sku) continue;
    resolved.push({ sku, quantity: line.quantity });
  }

  return mergeQuantities(resolved);
}
