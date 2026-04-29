import type { Platform } from "@prisma/client";

export interface CurrentInventoryCandidate {
  platform: Platform;
  inventory: number | null;
}

function maxKnownInventory(candidates: CurrentInventoryCandidate[]): number | null {
  const values = candidates
    .map((candidate) => candidate.inventory)
    .filter((value): value is number => value != null);

  return values.length > 0 ? Math.max(...values) : null;
}

export function selectCurrentInventory(
  candidates: CurrentInventoryCandidate[],
): number | null {
  const masterStoreInventory = maxKnownInventory(
    candidates.filter((candidate) => candidate.platform === "TPP_EBAY"),
  );

  return masterStoreInventory ?? maxKnownInventory(candidates);
}
