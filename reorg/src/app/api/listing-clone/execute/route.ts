import { NextResponse } from "next/server";
import { z } from "zod";
import type { Platform } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isLivePushEnabled } from "@/lib/automation-settings";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { checkWriteSafety } from "@/lib/safety";
import { requireCatalogMutationAllowed } from "@/lib/catalog-permissions-server";
import {
  runListingCloneEbayExecute,
  type ListingCloneExecuteResult,
} from "@/lib/services/listing-clone-ebay";

export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const MAX_BATCH = 12;

const executeSchema = z
  .object({
    sourcePlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
    targetPlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
    sourceItemId: z.string().regex(/^\d+$/).optional(),
    sourceItemIds: z.array(z.string().regex(/^\d+$/)).max(MAX_BATCH).optional(),
    confirmedLivePush: z.boolean().default(false),
    skipPictureUpload: z.boolean().optional(),
    itemTypeAspect: z.string().optional(),
    shippingPolicyId: z.string().optional(),
    returnPolicyId: z.string().optional(),
    paymentPolicyId: z.string().optional(),
    policySourceItemId: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const ids = normalizeSourceIds(val);
    if (ids.length < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Provide sourceItemId or sourceItemIds (1–${MAX_BATCH}).`,
        path: ["sourceItemId"],
      });
    }
    if (ids.length > MAX_BATCH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_BATCH} listings per batch.`,
        path: ["sourceItemIds"],
      });
    }
  });

export type ListingCloneExecuteItemPayload = {
  sourceItemId: string;
  ok: boolean;
  result?: ListingCloneExecuteResult;
  error?: string;
};

function normalizeSourceIds(val: z.infer<typeof executeSchema>): string[] {
  const raw =
    val.sourceItemIds != null && val.sourceItemIds.length > 0
      ? val.sourceItemIds
      : val.sourceItemId != null && val.sourceItemId !== ""
        ? [val.sourceItemId]
        : [];
  return [...new Set(raw)];
}

async function getSystemUserId(): Promise<string | null> {
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
  return user.id;
}

export async function POST(request: Request) {
  try {
    const access = await requireCatalogMutationAllowed();
    if (!access.allowed) return access.response;

    const session = await auth();
    const actorUserId =
      session?.user?.id ??
      (isAuthBypassEnabled() ? await getSystemUserId() : null);

    if (!actorUserId) {
      return NextResponse.json(
        { error: "You must be signed in to publish cloned listings." },
        { status: 401 },
      );
    }

    const body = await request.json();
    const parsed = executeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const {
      sourcePlatform,
      targetPlatform,
      confirmedLivePush,
      skipPictureUpload,
      itemTypeAspect,
      shippingPolicyId,
      returnPolicyId,
      paymentPolicyId,
      policySourceItemId,
    } = parsed.data;

    const sourceIds = normalizeSourceIds(parsed.data);

    if (sourcePlatform === targetPlatform) {
      return NextResponse.json(
        { error: "Source and target eBay stores must differ." },
        { status: 400 },
      );
    }

    if (!confirmedLivePush) {
      return NextResponse.json(
        {
          error:
            "Live listing clone requires explicit confirmation. Run a preview first, then confirm with confirmedLivePush: true.",
        },
        { status: 400 },
      );
    }

    const livePushEnabled = await isLivePushEnabled();
    if (!livePushEnabled) {
      return NextResponse.json(
        {
          error:
            "Live marketplace writes are disabled until go-live is approved (same gate as Catalog push). Enable live push in automation settings.",
        },
        { status: 403 },
      );
    }

    const safety = await checkWriteSafety(targetPlatform as Platform);
    if (!safety.allowed) {
      return NextResponse.json(
        { error: safety.reason ?? "Write blocked by safety rules." },
        { status: 403 },
      );
    }

    const options = {
      skipPictureUpload,
      itemTypeAspect,
      shippingPolicyId,
      returnPolicyId,
      paymentPolicyId,
      policySourceItemId,
    };

    const items: ListingCloneExecuteItemPayload[] = [];

    for (const sourceItemId of sourceIds) {
      try {
        const result = await runListingCloneEbayExecute(
          sourcePlatform,
          targetPlatform,
          sourceItemId,
          options,
        );
        items.push({ sourceItemId, ok: true, result });
      } catch (err) {
        items.push({
          sourceItemId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await db.auditLog.create({
      data: {
        userId: actorUserId,
        action: "LISTING_CLONE_EXECUTE",
        entityType: "ebay_listing_clone",
        entityId: sourceIds.slice(0, 3).join(",") + (sourceIds.length > 3 ? "…" : ""),
        details: {
          sourcePlatform,
          targetPlatform,
          batch: sourceIds.length > 1,
          count: sourceIds.length,
          sourceItemIds: sourceIds,
          okCount: items.filter((i) => i.ok).length,
          failCount: items.filter((i) => !i.ok).length,
          results: items.map((i) => ({
            sourceItemId: i.sourceItemId,
            ok: i.ok,
            newItemId: i.result?.newItemId ?? null,
            error: i.error ?? null,
          })),
          confirmedLivePush: true,
        },
      },
    });

    return NextResponse.json({ data: { items } });
  } catch (error) {
    console.error("[listing-clone/execute] failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Listing clone publish failed",
      },
      { status: 500 },
    );
  }
}
