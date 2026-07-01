import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import {
  auditEbayTrackingAdditionsBlocked,
  buildEbayTrackingAdditionPlan,
  executeEbayTrackingAdditions,
  type EbayTrackingAdditionInput,
} from "@/lib/manage-orders/add-tracking";
import { isBlockedAutomationContext, liveEbayOrderMutationsEnabled } from "@/lib/manage-orders/safety";
import type { EbayStore } from "@/lib/manage-orders/types";
import { labelFormatterSourceStoreSchema } from "@/lib/label-formatter/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TOKEN_VERSION = "lfat1";
const TOKEN_TTL_MS = 5 * 60 * 1000;

const reshipRowSchema = z.object({
  reshipRowId: z.string().trim().min(1).max(120),
  orderNumber: z.string().trim().min(1).max(80),
  sourceStore: labelFormatterSourceStoreSchema,
  trackingNumber: z.string().trim().max(120).nullable().optional(),
});

const bodySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("preview"),
    rows: z.array(reshipRowSchema).min(1).max(100),
  }),
  z.object({
    mode: z.literal("execute"),
    rows: z.array(reshipRowSchema).min(1).max(100),
    confirmationToken: z.string().trim().min(1),
  }),
]);

type NormalizedTokenRow = {
  reshipRowId: string;
  orderNumber: string;
  sourceStore: string;
  trackingNumber: string;
};

type ConfirmationPayload = {
  userId: string;
  rows: NormalizedTokenRow[];
  expiresAt: number;
  nonce: string;
};

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
    return { id: session.user.id, role: session.user.role };
  }
  if (isAuthBypassEnabled()) {
    const user = await getSystemUser();
    return { id: user.id, role: user.role };
  }
  return null;
}

function secret() {
  const value =
    process.env.MANAGE_ORDERS_HUMAN_ACTION_SECRET ??
    process.env.AUTH_SECRET ??
    process.env.NEXTAUTH_SECRET;
  if (!value || value.length < 16) {
    throw new Error("Label Formatter add-tracking confirmation secret is not configured.");
  }
  return value;
}

function signPayload(payloadBase64: string) {
  return crypto.createHmac("sha256", secret()).update(payloadBase64).digest("base64url");
}

function createConfirmationToken(input: { userId: string; rows: NormalizedTokenRow[] }) {
  const payload: ConfirmationPayload = {
    userId: input.userId,
    rows: input.rows,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${TOKEN_VERSION}.${payloadBase64}.${signPayload(payloadBase64)}`;
}

function parseConfirmationToken(token: string): ConfirmationPayload {
  const [version, payloadBase64, signature] = token.split(".");
  if (version !== TOKEN_VERSION || !payloadBase64 || !signature) {
    throw new Error("Invalid confirmation token.");
  }
  const expected = signPayload(payloadBase64);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid confirmation token signature.");
  }
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8")) as ConfirmationPayload;
  if (payload.expiresAt < Date.now()) throw new Error("Confirmation token expired. Preview the rows again.");
  return payload;
}

function isProductionRuntime() {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === "production";
  return process.env.NEXT_PUBLIC_APP_ENV === "production" && process.env.NODE_ENV === "production";
}

function hasValidSameOrigin(headers: Headers) {
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function storeHint(sourceStore: string): EbayStore | null {
  if (sourceStore === "EBAY_TPP") return "TPP_EBAY";
  if (sourceStore === "EBAY_TT") return "TT_EBAY";
  return null;
}

function normalizeTokenRows(rows: z.infer<typeof reshipRowSchema>[]): NormalizedTokenRow[] {
  return rows
    .map((row) => ({
      reshipRowId: row.reshipRowId.trim(),
      orderNumber: row.orderNumber.trim(),
      sourceStore: row.sourceStore,
      trackingNumber: row.trackingNumber?.trim().replace(/\s+/g, "") ?? "",
    }))
    .sort((a, b) =>
      `${a.reshipRowId}:${a.orderNumber}:${a.trackingNumber}`.localeCompare(
        `${b.reshipRowId}:${b.orderNumber}:${b.trackingNumber}`,
      ),
    );
}

function tokenRowsMatch(a: NormalizedTokenRow[], b: NormalizedTokenRow[]) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toTrackingInputs(rows: z.infer<typeof reshipRowSchema>[]): EbayTrackingAdditionInput[] {
  return rows.map((row, index) => {
    const hint = storeHint(row.sourceStore);
    return {
      sourceRow: index + 1,
      reshipRowId: row.reshipRowId,
      orderId: row.orderNumber,
      trackingNumber: row.trackingNumber?.trim() ?? "",
      storeHint: hint,
      preflightBlockers: hint
        ? []
        : ["Only eBay TPP and eBay TT rows can have eBay tracking added."],
    };
  });
}

function planResponse(planResult: Awaited<ReturnType<typeof buildEbayTrackingAdditionPlan>>, confirmationToken?: string) {
  return {
    data: {
      ...planResult,
      confirmationToken,
    },
  };
}

export async function POST(request: NextRequest) {
  const actor = await resolveActor();
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid add-tracking request", details: parsed.error.flatten() }, { status: 400 });
  }

  const rows = toTrackingInputs(parsed.data.rows);

  if (parsed.data.mode === "preview") {
    const planResult = await buildEbayTrackingAdditionPlan(rows);
    const confirmationToken = planResult.summary.blockedCount === 0
      ? createConfirmationToken({ userId: actor.id, rows: normalizeTokenRows(parsed.data.rows) })
      : undefined;
    return NextResponse.json(planResponse(planResult, confirmationToken));
  }

  const tokenRows = normalizeTokenRows(parsed.data.rows);
  try {
    const tokenPayload = parseConfirmationToken(parsed.data.confirmationToken);
    if (tokenPayload.userId !== actor.id || !tokenRowsMatch(tokenPayload.rows, tokenRows)) {
      throw new Error("Confirmation token does not match this selection.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid confirmation token.";
    await auditEbayTrackingAdditionsBlocked({
      actorUserId: actor.id,
      reason: "invalid_confirmation_token",
      rows,
      details: { message },
    });
    return NextResponse.json({ error: message }, { status: 403 });
  }

  if (!liveEbayOrderMutationsEnabled()) {
    await auditEbayTrackingAdditionsBlocked({
      actorUserId: actor.id,
      reason: "live_flag_disabled",
      rows,
    });
    return NextResponse.json({ error: "Live eBay order actions are currently disabled." }, { status: 403 });
  }
  if (!isProductionRuntime()) {
    await auditEbayTrackingAdditionsBlocked({
      actorUserId: actor.id,
      reason: "not_production",
      rows,
    });
    return NextResponse.json({ error: "Live eBay order actions are only allowed in production." }, { status: 403 });
  }
  if (isBlockedAutomationContext(request.headers)) {
    await auditEbayTrackingAdditionsBlocked({
      actorUserId: actor.id,
      reason: "automation_context",
      rows,
    });
    return NextResponse.json({ error: "Live eBay order actions cannot run from automated test or background contexts." }, { status: 403 });
  }
  if (!hasValidSameOrigin(request.headers)) {
    await auditEbayTrackingAdditionsBlocked({
      actorUserId: actor.id,
      reason: "csrf_origin_mismatch",
      rows,
    });
    return NextResponse.json({ error: "Could not verify request origin. Please refresh and try again." }, { status: 403 });
  }

  try {
    const result = await executeEbayTrackingAdditions({
      rows,
      actorUserId: actor.id,
      feature: "label_formatter_reshipped_tab",
    });
    return NextResponse.json({ data: result }, { status: result.failureCount > 0 ? 207 : 200 });
  } catch (error) {
    const planResult = await buildEbayTrackingAdditionPlan(rows);
    const message = error instanceof Error ? error.message : "Failed to add tracking to selected eBay orders.";
    await auditEbayTrackingAdditionsBlocked({
      actorUserId: actor.id,
      reason: "execution_blocked",
      rows,
      details: { message },
    });
    return NextResponse.json({ error: message, data: planResult }, { status: 409 });
  }
}
