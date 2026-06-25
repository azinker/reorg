import type { Platform } from "@prisma/client";

export interface ProfitInput {
  salePrice: number;
  supplierCost: number;
  supplierShipping: number;
  shippingCost: number;
  platformFeeRate: number;
  adRate: number;
  platform: Platform;
}

export interface ProfitResult {
  profit: number;
  margin: number;
  platformFee: number;
  adFee: number;
  totalCost: number;
}

/**
 * Calculate profit for a single store-listing.
 *
 * For BC and SHPFY in v1: platformFeeRate and adRate are forced to 0.
 */
export function calculateProfit(input: ProfitInput): ProfitResult {
  const {
    salePrice,
    supplierCost,
    supplierShipping,
    shippingCost,
    platform,
  } = input;

  const feeExemptPlatforms: Platform[] = ["BIGCOMMERCE", "SHOPIFY"];
  const effectiveFeeRate = feeExemptPlatforms.includes(platform)
    ? 0
    : input.platformFeeRate;
  const effectiveAdRate = feeExemptPlatforms.includes(platform)
    ? 0
    : input.adRate;

  const platformFee = salePrice * effectiveFeeRate;
  const adFee = salePrice * effectiveAdRate;
  const totalCost =
    supplierCost + supplierShipping + shippingCost + platformFee + adFee;
  const profit = salePrice - totalCost;
  const margin = salePrice > 0 ? (profit / salePrice) * 100 : 0;

  return {
    profit: Math.round(profit * 100) / 100,
    margin: Math.round(margin * 100) / 100,
    platformFee: Math.round(platformFee * 100) / 100,
    adFee: Math.round(adFee * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
  };
}

/**
 * Parse weight display format into ounces for shipping rate lookup.
 * Supports: "5" -> 5oz, "12" -> 12oz, "2LBS" -> 32oz, "5LBS" -> 80oz
 */
export function parseWeightToOz(weightDisplay: string): number | null {
  if (!weightDisplay) return null;

  const trimmed = weightDisplay.trim().toUpperCase();

  const lbsMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*LBS?$/i);
  if (lbsMatch) {
    return Math.round(parseFloat(lbsMatch[1]) * 16);
  }

  const ozMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*(OZ)?$/i);
  if (ozMatch) {
    return Math.round(parseFloat(ozMatch[1]));
  }

  return null;
}

/** Unit catalog weight × line quantity (ounces). */
export function totalWeightOzFromCatalogLabel(
  weightDisplay: string,
  quantity: number,
): number | null {
  const unitOz = parseWeightToOz(weightDisplay);
  if (unitOz == null || quantity <= 0) return null;
  return unitOz * quantity;
}

/** Help Desk product line — total weight in ounces. */
export function formatOrderLineWeightOz(totalOz: number): string {
  return `${totalOz}oz`;
}

/** Help Desk product line — total weight in pounds (click-toggle alternate). */
export function formatOrderLineWeightLbs(totalOz: number): string {
  const lbs = totalOz / 16;
  if (Number.isInteger(lbs)) return `${lbs}lbs`;
  const rounded = Math.round(lbs * 100) / 100;
  return `${rounded}lbs`;
}

/**
 * Format weight for display in the user's preferred format.
 */
export function formatWeightDisplay(weightDisplay: string): string {
  if (!weightDisplay) return "";
  const trimmed = weightDisplay.trim().toUpperCase();

  if (trimmed.match(/^\d+\s*LBS?$/i)) {
    return trimmed.replace(/\s+/g, "");
  }

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= 16) {
    return `${num}oz`;
  }

  return trimmed;
}

/**
 * Single label for Help Desk / APIs: prefer `weightDisplay`, then raw `weight`
 * (catalog editable string), then computed ounces. Mirrors how the catalog
 * grid renders the weight column.
 */
export function masterRowWeightLabel(w: {
  weight: string | null;
  weightDisplay: string | null;
  weightOz: number | null;
}): string | null {
  if (w.weightDisplay?.trim()) {
    return formatWeightDisplay(w.weightDisplay.trim());
  }
  if (w.weight?.trim()) {
    const raw = w.weight.trim();
    const t = raw.toUpperCase();
    if (t.endsWith("LBS")) return t.replace(/\s+/g, "");
    const num = parseFloat(raw);
    if (!Number.isNaN(num)) return `${num}oz`;
    return raw;
  }
  if (w.weightOz != null && w.weightOz > 0) {
    if (w.weightOz >= 16 && w.weightOz % 16 === 0) {
      return `${w.weightOz / 16}LBS`;
    }
    if (Number.isInteger(w.weightOz)) {
      return `${w.weightOz}oz`;
    }
    return `${Math.round(w.weightOz * 10) / 10}oz`;
  }
  return null;
}
