import { NextResponse, after, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { executePush, finalizeDeferredPostPushRefresh } from "@/lib/services/push";
import { buildAdapter } from "@/lib/integrations/factory";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import { isLivePushEnabled } from "@/lib/automation-settings";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { requireCatalogMutationAllowed } from "@/lib/catalog-permissions-server";
import type { Platform } from "@prisma/client";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const pushSchema = z.object({
  changes: z.array(
    z.object({
      stagedChangeId: z.string().optional(),
      masterRowId: z.string().optional(),
      marketplaceListingId: z.string().optional(),
      platformVariantId: z.string().optional(),
      sku: z.string().optional(),
      title: z.string().optional(),
      platform: z.enum(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]),
      listingId: z.string(),
      field: z.enum(["salePrice", "adRate", "upc"]),
      oldValue: z.union([z.number(), z.string(), z.null()]),
      newValue: z.union([z.number(), z.string()]),
    })
  ),
  dryRun: z.boolean().default(true),
  confirmedLivePush: z.boolean().default(false),
  skipPrePushBackup: z.boolean().default(false),
});

const FIRST_LIVE_PUSH_CHECKLIST = [
  {
    label: "Keep the batch small",
    detail: "Use a small first live push so the result is easy to inspect and recover if anything behaves unexpectedly.",
  },
  {
    label: "Confirm backup readiness",
    detail: "If the push touches many listings, make sure the dry run says the automatic pre-push backup is ready before you confirm.",
  },
  {
    label: "Watch Engine Room after push",
    detail: "After the live push finishes, check Engine Room and Sync to confirm the post-push refresh and audit trail look correct.",
  },
  {
    label: "Retry only failures",
    detail: "If any listing fails, retry only those failed staged changes instead of rerunning the whole batch immediately.",
  },
] as const;

async function resolvePushChanges(
  changes: z.infer<typeof pushSchema>["changes"],
) {
  const withId = changes.filter((c) => c.marketplaceListingId);
  const withoutId = changes.filter((c) => !c.marketplaceListingId);

  const listingIds = [...new Set(withId.map((c) => c.marketplaceListingId!))];
  const listingMap = new Map<string, {
    id: string;
    masterRowId: string;
    platformVariantId: string | null;
    salePrice: number | null;
    adRate: number | null;
    masterRow: { id: string; sku: string; upc: string | null };
    stagedChanges: { id: string; field: string }[];
    integration: { platform: Platform };
  }>();

  const BULK_CHUNK = 500;
  for (let i = 0; i < listingIds.length; i += BULK_CHUNK) {
    const batch = listingIds.slice(i, i + BULK_CHUNK);
    const listings = await db.marketplaceListing.findMany({
      where: { id: { in: batch } },
      include: {
        masterRow: { select: { id: true, sku: true, upc: true } },
        stagedChanges: {
          where: { status: "STAGED" },
          orderBy: { createdAt: "desc" },
        },
        integration: { select: { platform: true } },
      },
    });
    for (const l of listings) listingMap.set(l.id, l);
  }

  const resolved = withId.map((change) => {
    const listing = listingMap.get(change.marketplaceListingId!);
    if (!listing) {
      throw new Error(
        `Could not resolve ${change.platform} listing ${change.listingId} for ${change.field}.`,
      );
    }
    const matchingStagedChange = listing.stagedChanges.find((sc) => sc.field === change.field);
    return {
      stagedChangeId: change.stagedChangeId ?? matchingStagedChange?.id ?? null,
      masterRowId: change.masterRowId ?? listing.masterRowId,
      marketplaceListingId: listing.id,
      platformVariantId: change.platformVariantId ?? listing.platformVariantId ?? null,
      platform: change.platform,
      listingId: change.listingId,
      field: change.field,
      oldValue:
        change.oldValue ??
        (change.field === "adRate"
          ? listing.adRate
          : change.field === "salePrice"
            ? listing.salePrice
            : listing.masterRow.upc) ??
        null,
      newValue: change.newValue,
    };
  });

  const RESOLVE_CHUNK = 50;
  for (let i = 0; i < withoutId.length; i += RESOLVE_CHUNK) {
    const chunk = withoutId.slice(i, i + RESOLVE_CHUNK);
    const batch = await Promise.all(
      chunk.map(async (change) => {
        const listing = await db.marketplaceListing.findFirst({
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
            masterRow: { select: { id: true, sku: true, upc: true } },
            stagedChanges: {
              where: { status: "STAGED", field: change.field },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
            integration: { select: { platform: true } },
          },
        });
        if (!listing) {
          throw new Error(
            `Could not resolve ${change.platform} listing ${change.listingId} for ${change.field}.`,
          );
        }
        return {
          stagedChangeId: change.stagedChangeId ?? listing.stagedChanges[0]?.id ?? null,
          masterRowId: change.masterRowId ?? listing.masterRowId,
          marketplaceListingId: listing.id,
          platformVariantId: change.platformVariantId ?? listing.platformVariantId ?? null,
          platform: change.platform,
          listingId: change.listingId,
          field: change.field,
          oldValue:
            change.oldValue ??
            (change.field === "adRate"
              ? listing.adRate
              : change.field === "salePrice"
                ? listing.salePrice
                : listing.masterRow.upc) ??
            null,
          newValue: change.newValue,
        };
      }),
    );
    resolved.push(...batch);
  }

  return resolved;
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

    const { changes, dryRun, confirmedLivePush, skipPrePushBackup } = parsed.data;
    const access = await requireCatalogMutationAllowed();
    if (!access.allowed) return access.response;

    const session = await auth();
    const actorUserId = session?.user?.id ?? ((isAuthBypassEnabled() ? (await getSystemUser()).id : null));

    if (!actorUserId) {
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

    const priorLivePushCount = await db.pushJob.count({
      where: {
        dryRun: false,
        status: { in: ["EXECUTING", "COMPLETED", "FAILED"] },
      },
    });
    const result = await executePush(
      {
        userId: actorUserId,
        changes: resolvedChanges,
        dryRun,
      },
      adapters,
      { deferPostPushRefresh: !dryRun, skipPrePushBackup },
    );
    const { deferredPostPushRefreshTask, ...publicResult } = result;
    if (deferredPostPushRefreshTask) {
      after(async () => {
        try {
          await finalizeDeferredPostPushRefresh(deferredPostPushRefreshTask);
        } catch (error) {
          console.error(
            "[push] Failed to finalize deferred post-push refresh",
            error,
          );
        }
      });
    }
    const firstLivePush = priorLivePushCount === 0;

    const nextStep =
      publicResult.status === "blocked"
          ? publicResult.blockedReason ?? "Resolve the blocker before retrying this push."
          : dryRun
            ? "Review the dry-run summary, go-live checklist, and post-push refresh readiness before confirming a live push."
            : publicResult.status === "partial"
              ? "Review the failed listings, then retry only the remaining staged changes after checking Engine Room."
          : publicResult.postPushRefresh?.status === "completed"
            ? "Review Engine Room or Sync if you want to inspect the targeted post-push refresh jobs."
            : publicResult.postPushRefresh?.status === "warning"
              ? "Review Sync or Engine Room to confirm the targeted refresh finishes cleanly."
              : "Review Engine Room or Sync if you need to inspect the live push and follow-up refresh.";

    const message =
      publicResult.status === "blocked"
        ? "Push blocked by a safety rule."
        : dryRun
          ? "Dry run completed. Review the impact summary, batch guardrails, and live-push readiness before confirming anything."
          : publicResult.status === "partial"
            ? "Live push partially completed. Some listings updated, and some still need attention before you retry."
          : publicResult.prePushBackup?.status === "completed"
            ? "Live push completed through the write safety chain, including the automatic pre-push backup."
            : "Live push completed through the write safety chain.";

    return NextResponse.json(
      {
        data: {
          ...publicResult,
          firstLivePush,
          operatorChecklist: firstLivePush ? FIRST_LIVE_PUSH_CHECKLIST : [],
          changes: changes.length,
          message,
          nextStep,
        },
      },
      { status: publicResult.status === "blocked" ? 409 : 200 },
    );
  } catch (error) {
    console.error("[push] Failed to process push request", error);
    return NextResponse.json(
      { error: "Failed to process push request" },
      { status: 500 }
    );
  }
}

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: {
        email: "system@reorg.internal",
        name: "System",
        role: "ADMIN",
      },
    });
  }
  return user;
}
