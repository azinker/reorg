import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getIntegrationConfig,
  isIncrementalReady,
} from "@/lib/integrations/runtime-config";
import { hasConnectedCredentials } from "@/lib/integrations/factory";
import { isLivePushEnabled } from "@/lib/automation-settings";

export async function GET() {
  try {
    const integrations = await db.integration.findMany({
      orderBy: { platform: "asc" },
    });
    const livePushEnabled = await isLivePushEnabled();

    const data = integrations.map((i) => {
      const config = getIntegrationConfig(i);
      const connected = hasConnectedCredentials(i.platform, config);

      return {
        platform: i.platform,
        label: i.label,
        enabled: i.enabled,
        writeLocked: i.writeLocked,
        isMaster: i.isMaster,
        lastSyncAt: i.lastSyncAt,
        connected,
        incrementalReady: isIncrementalReady(i.platform),
        livePushEnabled,
        syncProfile: config.syncProfile,
        syncState: config.syncState,
      };
    });

    return NextResponse.json({ data });
  } catch (error) {
    console.error("[integrations] GET failed", error);
    return NextResponse.json(
      { error: "Failed to fetch integrations" },
      { status: 500 }
    );
  }
}
