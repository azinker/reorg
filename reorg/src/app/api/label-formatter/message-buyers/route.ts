import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import {
  enqueueReshipBuyerMessages,
  type ReshipMessageTarget,
} from "@/lib/label-formatter/message-buyers";
import { labelFormatterSourceStoreSchema } from "@/lib/label-formatter/types";
import { sourceStoreLabel } from "@/lib/label-formatter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const targetSchema = z.object({
  reshipRowId: z.string().trim().min(1),
  orderNumber: z.string().trim().min(1).max(80),
  sourceStore: labelFormatterSourceStoreSchema,
  buyerName: z.string().trim().min(1).max(200),
  trackingNumber: z.string().trim().max(80).nullable().optional(),
});

const bodySchema = z.object({
  bodyText: z.string().trim().min(1).max(10_000),
  sendDelaySeconds: z.coerce.number().int().min(0).max(60).default(5),
  targets: z.array(targetSchema).min(1).max(100),
});

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: { email: "system@reorg.internal", name: "System", role: "ADMIN" },
    });
  }
  return user;
}

async function resolveActor() {
  const session = await auth();
  if (session?.user?.id && ["ADMIN", "OPERATOR"].includes(session.user.role)) {
    return session.user.id;
  }
  if (isAuthBypassEnabled()) {
    const user = await getSystemUser();
    return user.id;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const actorUserId = await resolveActor();
  if (!actorUserId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const targets: ReshipMessageTarget[] = parsed.data.targets.map((row) => ({
    reshipRowId: row.reshipRowId,
    orderNumber: row.orderNumber,
    sourceStore: row.sourceStore,
    buyerName: row.buyerName,
    trackingNumber: row.trackingNumber?.trim() || null,
    sourceStoreLabel: sourceStoreLabel(row.sourceStore),
  }));

  const results = await enqueueReshipBuyerMessages({
    authorUserId: actorUserId,
    bodyTemplate: parsed.data.bodyText,
    sendDelaySeconds: parsed.data.sendDelaySeconds,
    targets,
  });

  const queued = results.filter((row) => row.status === "queued").length;
  const failed = results.filter((row) => row.status === "error").length;
  const skipped = results.filter((row) => row.status === "skipped").length;

  return NextResponse.json({
    data: {
      queued,
      failed,
      skipped,
      results,
    },
  });
}
