import { db } from "@/lib/db";
import { Platform, Prisma } from "@prisma/client";
import {
  mergeIntegrationConfig,
  type CatalogPullResume,
} from "@/lib/integrations/runtime-config";

export async function persistCatalogPullResume(
  integrationId: string,
  platform: Platform,
  resume: CatalogPullResume | null,
) {
  const row = await db.integration.findUnique({
    where: { id: integrationId },
    select: { config: true },
  });
  if (!row) return;

  await db.integration.update({
    where: { id: integrationId },
    data: {
      config: mergeIntegrationConfig(platform, row.config, {
        syncState: { catalogPullResume: resume },
      }) as unknown as Prisma.InputJsonValue,
    },
  });
}
