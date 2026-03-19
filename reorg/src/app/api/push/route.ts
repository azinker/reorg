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
      stagedChangeId: z.string().optional(),
      masterRowId: z.string().optional(),
      marketplaceListingId: z.string().optional(),
      sku: z.string().optional(),
      title: z.string().optional(),
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

async function resolvePushChanges(
  changes: z.infer<typeof pushSchema>["changes"],
) {
  return Promise.all(
    changes.map(async (change) => {
      const listing =
        change.marketplaceListingId
          ? await db.marketplaceListing.findUnique({
              where: { id: change.marketplaceListingId },
              include: {
                masterRow: { select: { id: true, sku: true } },
                stagedChanges: {
                  where: { status: "STAGED", field: change.field },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                },
              },
            })
          : await db.marketplaceListing.findFirst({
              where: {
                platformItemId: change.listingId,
                integration: { platform: change.platform },
                ...(change.masterRowId
                  ? { masterRowId: change.masterRowId }
                  : change.sku
                    ? { masterRow: { sku: change.sku } }
                    : {}),
              },
              include: {
                masterRow: { select: { id: true, sku: true } },
                stagedChanges: {
                  where: { status: "STAGED", field: change.field },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                },
              },
            });

      if (!listing) {
        throw new Error(
          `Could not resolve ${change.platform} listing ${change.listingId} for ${change.field}.`,
        );
      }

      const stagedChangeId =
        change.stagedChangeId ??
        listing.stagedChanges[0]?.id ??
        null;

      return {
        stagedChangeId,
        masterRowId: change.masterRowId ?? listing.masterRowId,
        marketplaceListingId: change.marketplaceListingId ?? listing.id,
        platform: change.platform,
        listingId: change.listingId,
        field: change.field,
        oldValue:
          change.oldValue ??
          (change.field === "adRate" ? listing.adRate : listing.salePrice) ??
          null,
        newValue: change.newValue,
      };
    }),
  );
}

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

    const resolvedChanges = await resolvePushChanges(changes);

    const result = await executePush(
      {
        userId: session.user.id,
        changes: resolvedChanges,
        dryRun,
      },
      adapters,
    );

    const nextStep =
      result.status === "blocked"
          ? result.blockedReason ?? "Resolve the blocker before retrying this push."
          : dryRun
            ? "Review the dry-run summary, go-live checklist, and post-push refresh readiness before confirming a live push."
            : result.status === "partial"
              ? "Review the failed listings, then retry only the remaining staged changes after checking Engine Room."
          : result.postPushRefresh?.status === "completed"
            ? "Review Engine Room or Sync if you want to inspect the targeted post-push refresh jobs."
            : result.postPushRefresh?.status === "warning"
              ? "Review Sync or Engine Room to confirm the targeted refresh finishes cleanly."
              : "Review Engine Room or Sync if you need to inspect the live push and follow-up refresh.";

    const message =
      result.status === "blocked"
        ? "Push blocked by a safety rule."
        : dryRun
          ? "Dry run completed. Review the impact summary, batch guardrails, and live-push readiness before confirming anything."
          : result.status === "partial"
            ? "Live push partially completed. Some listings updated, and some still need attention before you retry."
          : result.prePushBackup?.status === "completed"
            ? "Live push completed through the write safety chain, including the automatic pre-push backup."
            : "Live push completed through the write safety chain.";

    return NextResponse.json(
      {
        data: {
          ...result,
          changes: changes.length,
          message,
          nextStep,
        },
      },
      { status: result.status === "blocked" ? 409 : 200 },
    );
  } catch (error) {
    console.error("[push] Failed to process push request", error);
    return NextResponse.json(
      { error: "Failed to process push request" },
      { status: 500 }
    );
  }
}
