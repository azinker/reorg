import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireCatalogMutationAllowed } from "@/lib/catalog-permissions-server";
import { isAuthBypassEnabled } from "@/lib/app-env";
import {
  runListingCloneEbayPreview,
  type ListingCloneVerifyResult,
} from "@/lib/services/listing-clone-ebay";

export const runtime = "nodejs";
export const maxDuration = 800;
export const dynamic = "force-dynamic";

const MAX_BATCH = 12;

const previewSchema = z
  .object({
    sourcePlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
    targetPlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
    sourceItemId: z.string().regex(/^\d+$/).optional(),
    sourceItemIds: z.array(z.string().regex(/^\d+$/)).max(MAX_BATCH).optional(),
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

export type ListingClonePreviewItemPayload = {
  sourceItemId: string;
  ok: boolean;
  preview?: ListingCloneVerifyResult;
  error?: string;
};

function normalizeSourceIds(val: z.infer<typeof previewSchema>): string[] {
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
        { error: "You must be signed in to run a listing clone preview." },
        { status: 401 },
      );
    }

    const body = await request.json();
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const {
      sourcePlatform,
      targetPlatform,
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

    const options = {
      skipPictureUpload,
      itemTypeAspect,
      shippingPolicyId,
      returnPolicyId,
      paymentPolicyId,
      policySourceItemId,
    };

    const items: ListingClonePreviewItemPayload[] = [];

    for (const sourceItemId of sourceIds) {
      try {
        const preview = await runListingCloneEbayPreview(
          sourcePlatform,
          targetPlatform,
          sourceItemId,
          options,
        );
        items.push({ sourceItemId, ok: true, preview });
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
        action: "LISTING_CLONE_PREVIEW",
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
          skipPictureUpload: Boolean(skipPictureUpload),
        },
      },
    });

    return NextResponse.json({ data: { items } });
  } catch (error) {
    console.error("[listing-clone/preview] failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Listing clone preview failed",
      },
      { status: 500 },
    );
  }
}
