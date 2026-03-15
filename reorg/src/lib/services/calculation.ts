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

  const lbsMatch = trimmed.match(/^(\d+)\s*LBS?$/i);
  if (lbsMatch) {
    return parseInt(lbsMatch[1], 10) * 16;
  }

  const ozMatch = trimmed.match(/^(\d+)\s*(OZ)?$/i);
  if (ozMatch) {
    return parseInt(ozMatch[1], 10);
  }

  return null;
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
