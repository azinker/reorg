import type { Integration } from "@prisma/client";
import { db } from "@/lib/db";
import type { SyncState } from "@/lib/integrations/runtime-config";
import {
  getEbayCredentialFingerprint,
  getEbayMethodRate,
  type EbayTradingRateLimitSnapshot,
} from "@/lib/services/ebay-analytics";
import {
  getFallbackPerRunEbayGetItemBudget,
  getPerRunEbayGetItemBudget,
  getReservedEbayGetItemCalls,
} from "@/lib/services/ebay-sync-policy";

export interface EbayIncrementalWindowState {
  itemIds: string[];
  windowEndedAt: Date;
  source: "pending" | "fresh";
}

export interface EbayIncrementalBudgetPlan {
  budget: number;
  itemIdsToProcess: string[];
  pendingItemIds: string[];
  sharedStoreCount: number;
  usedFallbackBudget: boolean;
  reservedGetItemCalls: number | null;
}

export function getPendingIncrementalWindow(
  syncState: Pick<SyncState, "pendingIncrementalItemIds" | "pendingIncrementalWindowEndedAt">,
) {
  if (syncState.pendingIncrementalItemIds.length === 0) {
    return null;
  }

  if (!syncState.pendingIncrementalWindowEndedAt) {
    return null;
  }

  const windowEndedAt = new Date(syncState.pendingIncrementalWindowEndedAt);
  if (Number.isNaN(windowEndedAt.getTime())) {
    return null;
  }

  return {
    itemIds: syncState.pendingIncrementalItemIds,
    windowEndedAt,
    source: "pending" as const,
  };
}

export async function getSharedEbayQuotaStoreCount(
  integration: Pick<Integration, "id" | "platform" | "config">,
) {
  const fingerprint = getEbayCredentialFingerprint(integration);
  if (!fingerprint) return 1;

  const ebayIntegrations = await db.integration.findMany({
    where: {
      enabled: true,
      platform: {
        in: ["TPP_EBAY", "TT_EBAY"],
      },
    },
    select: {
      id: true,
      platform: true,
      config: true,
    },
  });

  const sharedCount = ebayIntegrations.filter(
    (candidate) => getEbayCredentialFingerprint(candidate) === fingerprint,
  ).length;

  return Math.max(1, sharedCount);
}

export async function buildEbayIncrementalBudgetPlan(args: {
  integration: Pick<Integration, "id" | "platform" | "config">;
  snapshot: EbayTradingRateLimitSnapshot | null;
  timeZone: string;
  window: EbayIncrementalWindowState;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const sharedStoreCount = await getSharedEbayQuotaStoreCount(args.integration);
  const getItemRate = getEbayMethodRate(args.snapshot, "GetItem");
  const reservedGetItemCalls =
    getItemRate && getItemRate.limit > 0
      ? getReservedEbayGetItemCalls(getItemRate.limit, sharedStoreCount)
      : null;
  const budget =
    getItemRate && getItemRate.limit > 0
      ? getPerRunEbayGetItemBudget({
          remaining: getItemRate.remaining,
          limit: getItemRate.limit,
          now,
          timeZone: args.timeZone,
          sharedStoreCount,
        })
      : getFallbackPerRunEbayGetItemBudget(now, args.timeZone);

  return {
    budget,
    itemIdsToProcess: args.window.itemIds.slice(0, budget),
    pendingItemIds: args.window.itemIds.slice(budget),
    sharedStoreCount,
    usedFallbackBudget: !getItemRate || getItemRate.limit <= 0,
    reservedGetItemCalls,
  } satisfies EbayIncrementalBudgetPlan;
}
