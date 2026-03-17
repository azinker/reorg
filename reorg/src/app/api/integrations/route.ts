import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET() {
  try {
    const integrations = await db.integration.findMany({
      orderBy: { platform: "asc" },
    });

    const data = integrations.map((i) => {
      const config = (i.config as Record<string, unknown>) ?? {};
      const hasToken =
        (i.platform === "SHOPIFY" && !!config.accessToken) ||
        ((i.platform === "TPP_EBAY" || i.platform === "TT_EBAY") && !!config.refreshToken) ||
        (i.platform === "BIGCOMMERCE" &&
          !!config.storeHash &&
          !!config.accessToken);

      return {
        platform: i.platform,
        label: i.label,
        enabled: i.enabled,
        writeLocked: i.writeLocked,
        isMaster: i.isMaster,
        lastSyncAt: i.lastSyncAt,
        connected: hasToken,
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
