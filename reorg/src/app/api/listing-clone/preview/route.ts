import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireCatalogMutationAllowed } from "@/lib/catalog-permissions-server";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { runListingCloneEbayPreview } from "@/lib/services/listing-clone-ebay";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const previewSchema = z.object({
  sourcePlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
  targetPlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
  sourceItemId: z.string().min(10).regex(/^\d+$/),
  skipPictureUpload: z.boolean().optional(),
  itemTypeAspect: z.string().optional(),
  shippingPolicyId: z.string().optional(),
  returnPolicyId: z.string().optional(),
  paymentPolicyId: z.string().optional(),
  policySourceItemId: z.string().optional(),
});

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
      sourceItemId,
      skipPictureUpload,
      itemTypeAspect,
      shippingPolicyId,
      returnPolicyId,
      paymentPolicyId,
      policySourceItemId,
    } = parsed.data;

    if (sourcePlatform === targetPlatform) {
      return NextResponse.json(
        { error: "Source and target eBay stores must differ." },
        { status: 400 },
      );
    }

    const result = await runListingCloneEbayPreview(
      sourcePlatform,
      targetPlatform,
      sourceItemId,
      {
        skipPictureUpload,
        itemTypeAspect,
        shippingPolicyId,
        returnPolicyId,
        paymentPolicyId,
        policySourceItemId,
      },
    );

    await db.auditLog.create({
      data: {
        userId: actorUserId,
        action: "LISTING_CLONE_PREVIEW",
        entityType: "ebay_listing_clone",
        entityId: sourceItemId,
        details: {
          sourcePlatform,
          targetPlatform,
          summary: result.summary,
          ack: result.ack,
          skipPictureUpload: Boolean(skipPictureUpload),
        },
      },
    });

    return NextResponse.json({ data: result });
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
