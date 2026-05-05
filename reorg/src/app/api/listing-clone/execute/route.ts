import { NextResponse } from "next/server";
import { z } from "zod";
import type { Platform } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { isLivePushEnabled } from "@/lib/automation-settings";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { checkWriteSafety } from "@/lib/safety";
import { requireCatalogMutationAllowed } from "@/lib/catalog-permissions-server";
import { runListingCloneEbayExecute } from "@/lib/services/listing-clone-ebay";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const executeSchema = z.object({
  sourcePlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
  targetPlatform: z.enum(["TPP_EBAY", "TT_EBAY"]),
  sourceItemId: z.string().min(10).regex(/^\d+$/),
  confirmedLivePush: z.boolean().default(false),
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
        { error: "You must be signed in to publish a cloned listing." },
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
      sourceItemId,
      confirmedLivePush,
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

    const result = await runListingCloneEbayExecute(
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
        action: "LISTING_CLONE_EXECUTE",
        entityType: "ebay_listing_clone",
        entityId: sourceItemId,
        details: {
          sourcePlatform,
          targetPlatform,
          newItemId: result.newItemId ?? null,
          summary: result.summary,
          ack: result.ack,
          confirmedLivePush: true,
        },
      },
    });

    return NextResponse.json({ data: result });
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
