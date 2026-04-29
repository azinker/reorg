import { db } from "@/lib/db";
import {
  selectCurrentInventory,
  type CurrentInventoryCandidate,
} from "@/lib/helpdesk/inventory";

export async function getCurrentInventoryBySkus(
  skus: string[],
): Promise<Map<string, number | null>> {
  const uniqueSkus = [...new Set(skus.map((sku) => sku.trim()).filter(Boolean))];
  const inventoryBySku = new Map<string, number | null>(
    uniqueSkus.map((sku) => [sku, null]),
  );

  if (uniqueSkus.length === 0) {
    return inventoryBySku;
  }

  const listings = await db.marketplaceListing.findMany({
    where: {
      sku: { in: uniqueSkus },
    },
    select: {
      sku: true,
      inventory: true,
      integration: {
        select: { platform: true },
      },
    },
  });

  const candidatesBySku = new Map<string, CurrentInventoryCandidate[]>();
  for (const listing of listings) {
    const candidates = candidatesBySku.get(listing.sku) ?? [];
    candidates.push({
      platform: listing.integration.platform,
      inventory: listing.inventory,
    });
    candidatesBySku.set(listing.sku, candidates);
  }

  for (const [sku, candidates] of candidatesBySku) {
    inventoryBySku.set(sku, selectCurrentInventory(candidates));
  }

  return inventoryBySku;
}

export async function getCurrentInventoryBySku(
  sku: string,
): Promise<number | null> {
  const inventoryBySku = await getCurrentInventoryBySkus([sku]);
  return inventoryBySku.get(sku.trim()) ?? null;
}
