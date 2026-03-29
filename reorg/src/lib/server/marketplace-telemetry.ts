import { AsyncLocalStorage } from "async_hooks";
import type { Platform } from "@prisma/client";
import { recordNetworkTransferSample } from "@/lib/services/network-transfer-samples";

type TelemetryStore = {
  syncJobId: string;
  integrationId: string;
  platform: Platform;
  marketplaceInboundBytes: number;
};

const als = new AsyncLocalStorage<TelemetryStore>();

export function getMarketplaceTelemetryStore(): TelemetryStore | undefined {
  return als.getStore();
}

export function addMarketplaceInboundBytes(byteLength: number): void {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return;
  const store = als.getStore();
  if (store) {
    store.marketplaceInboundBytes += byteLength;
  }
}

/**
 * Wraps marketplace sync work so eBay HTTP response sizes can be aggregated into one sample.
 */
export async function runWithMarketplaceTelemetry<T>(
  ctx: { syncJobId: string; integrationId: string; platform: Platform },
  fn: () => Promise<T>,
): Promise<T> {
  const store: TelemetryStore = {
    ...ctx,
    marketplaceInboundBytes: 0,
  };
  return als.run(store, async () => {
    try {
      return await fn();
    } finally {
      if (store.marketplaceInboundBytes > 0) {
        void recordNetworkTransferSample({
          channel: "MARKETPLACE_INBOUND",
          label: `Marketplace HTTP responses (${store.platform} sync)`,
          bytesEstimate: store.marketplaceInboundBytes,
          integrationId: store.integrationId,
          metadata: {
            syncJobId: store.syncJobId,
            platform: store.platform,
          },
        });
      }
    }
  });
}
