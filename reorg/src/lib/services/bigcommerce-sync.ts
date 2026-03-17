import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { BigCommerceAdapter } from "@/lib/integrations/bigcommerce";
import { runSync, type SyncResult } from "@/lib/services/sync";
import type { SyncExecutionOptions } from "@/lib/services/sync-control";

function getStringConfig(
  config: Record<string, unknown>,
  key: string
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function runBigCommerceSync(
  options: SyncExecutionOptions = {},
): Promise<SyncResult> {
  const integration = await db.integration.findUnique({
    where: { platform: Platform.BIGCOMMERCE },
  });

  if (!integration?.enabled) {
    throw new Error("BigCommerce integration is not enabled");
  }

  const config = (integration.config as Record<string, unknown>) ?? {};
  const storeHash =
    getStringConfig(config, "storeHash") ?? process.env.BIGCOMMERCE_STORE_HASH;
  const accessToken =
    getStringConfig(config, "accessToken") ??
    process.env.BIGCOMMERCE_ACCESS_TOKEN;

  if (!storeHash || !accessToken) {
    throw new Error(
      "BigCommerce credentials missing. Add storeHash and accessToken before syncing."
    );
  }

  const adapter = new BigCommerceAdapter({
    storeHash,
    accessToken,
  });

  return runSync(adapter, integration.id, options);
}
