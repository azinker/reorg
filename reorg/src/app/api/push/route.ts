import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { executePush } from "@/lib/services/push";
import { buildAdapter } from "@/lib/integrations/factory";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { isLivePushEnabled } from "@/lib/automation-settings";
import type { Platform } from "@prisma/client";

const pushSchema = z.object({
  changes: z.array(
    z.object({
      stagedChangeId: z.string(),
      masterRowId: z.string(),
      marketplaceListingId: z.string(),
      platform: z.enum(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]),
      listingId: z.string(),
      field: z.enum(["salePrice", "adRate"]),
      oldValue: z.number().nullable(),
      newValue: z.number(),
    })
  ),
  dryRun: z.boolean().default(true),
  confirmedLivePush: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = pushSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { changes, dryRun, confirmedLivePush } = parsed.data;
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "You must be signed in to run a push dry run." },
        { status: 401 },
      );
    }

    if (!dryRun && !confirmedLivePush) {
      return NextResponse.json(
        {
          error:
            "Live marketplace pushes require explicit confirmation. Run a dry run first, then confirm the live push.",
        },
        { status: 400 },
      );
    }

    if (!dryRun) {
      const livePushEnabled = await isLivePushEnabled();
      if (!livePushEnabled) {
        return NextResponse.json(
          {
            error:
              "Live marketplace push is still disabled. The safe bulk push route is wired, but it remains blocked until the product owner approves go-live.",
          },
          { status: 403 },
        );
      }
    }

    const platforms = [...new Set(changes.map((change) => change.platform))];
    const integrations = await db.integration.findMany({
      where: { platform: { in: platforms as Platform[] } },
    });

    const adapters = new Map<Platform, ReturnType<typeof buildAdapter>>();
    for (const integration of integrations) {
      adapters.set(
        integration.platform,
        buildAdapter(integration.platform, getIntegrationConfig(integration)),
      );
    }

    const result = await executePush(
      {
        userId: session.user.id,
        changes,
        dryRun,
      },
      adapters,
    );

    return NextResponse.json({
      data: {
        ...result,
        changes: changes.length,
        message:
          dryRun
            ? "Dry run passed. Review the results, then explicitly confirm if you want a live push later."
            : "Live push executed through the full write safety chain.",
      },
    });
  } catch (error) {
    console.error("[push] Failed to process push request", error);
    return NextResponse.json(
      { error: "Failed to process push request" },
      { status: 500 }
    );
  }
}
