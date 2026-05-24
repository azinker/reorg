import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import {
  adjustSkuVaultQuantity,
  getSkuVaultQuantity,
  InsufficientSkuVaultQuantityError,
} from "@/lib/services/skuvault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  sku: z.string().trim().min(1).max(120),
  quantity: z.coerce.number().int().positive().max(100_000),
  action: z.enum(["add", "remove"]),
});

function withExtensionCors(request: NextRequest, response: NextResponse) {
  const origin = request.headers.get("origin");
  if (origin?.startsWith("chrome-extension://")) {
    response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Access-Control-Allow-Credentials", "true");
    response.headers.set("Vary", "Origin");
  }
  return response;
}

export async function OPTIONS(request: NextRequest) {
  return withExtensionCors(
    request,
    new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    }),
  );
}

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    const userId = session?.user?.id ?? null;
    if (!userId && !isAuthBypassEnabled()) {
      return withExtensionCors(
        request,
        NextResponse.json({ error: "Unauthorized. Log into reorG first, then try again." }, { status: 401 }),
      );
    }

    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return withExtensionCors(
        request,
        NextResponse.json({ error: "Invalid adjustment request.", details: parsed.error.flatten() }, { status: 400 }),
      );
    }

    const before = await getSkuVaultQuantity(parsed.data.sku);
    const data = await adjustSkuVaultQuantity(parsed.data, {
      currentQuantityOnHand: before.quantityOnHand,
      fetchUpdatedQuantity: false,
      skipRemoveQuantityCheck: true,
    });
    await db.auditLog.create({
      data: {
        userId: userId ?? undefined,
        action: "skuvault_quantity_adjust",
        entityType: "sku",
        entityId: data.sku,
        details: {
          sku: data.sku,
          action: data.action,
          quantityChanged: data.quantityChanged,
          resultingQuantityOnHand: data.quantityOnHand,
          warehouse: data.warehouse,
          location: data.location,
          previousQuantityOnHand: before.quantityOnHand,
        },
      },
    }).catch(() => {});

    return withExtensionCors(request, NextResponse.json({
      data: {
        ...data,
        previousQuantityOnHand: before.quantityOnHand,
      },
    }));
  } catch (error) {
    console.error("[skuvault/adjust] failed", error);
    if (error instanceof InsufficientSkuVaultQuantityError) {
      return withExtensionCors(
        request,
        NextResponse.json(
          {
            error: `Cannot remove ${error.requestedQuantity} from ${error.sku}. Only ${error.availableQuantity} is available.`,
            details: {
              sku: error.sku,
              requestedQuantity: error.requestedQuantity,
              availableQuantity: error.availableQuantity,
            },
          },
          { status: 409 },
        ),
      );
    }

    return withExtensionCors(
      request,
      NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to update SkuVault quantity." },
        { status: 500 },
      ),
    );
  }
}
