import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { safeCompareText } from "@/lib/security";

export const runtime = "nodejs";

function readSharedSecret(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  return (
    request.headers.get("x-reorg-webhook-secret") ||
    request.headers.get("x-bc-webhook-secret")
  );
}

export async function POST(request: NextRequest) {
  const secret = process.env.BIGCOMMERCE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "BIGCOMMERCE_WEBHOOK_SECRET is not configured." },
      { status: 503 },
    );
  }

  const providedSecret = readSharedSecret(request);
  if (!providedSecret || !safeCompareText(secret, providedSecret)) {
    return NextResponse.json(
      { error: "Invalid BigCommerce webhook secret." },
      { status: 401 },
    );
  }

  const payload = (await request.json().catch(() => null)) as
    | Record<string, unknown>
    | null;

  const integration = await db.integration.findUnique({
    where: { platform: "BIGCOMMERCE" },
    select: { id: true },
  });

  await db.auditLog.create({
    data: {
      action: "webhook_delivery_exception_received",
      entityType: "integration",
      entityId: integration?.id ?? "BIGCOMMERCE",
      details: {
        platform: "BIGCOMMERCE",
        topic:
          typeof payload?.scope === "string"
            ? payload.scope
            : "store/hook/deliveryException",
        externalId:
          typeof payload?.hash === "string"
            ? payload.hash
            : typeof payload?.id === "number" || typeof payload?.id === "string"
              ? String(payload.id)
              : null,
        sourceLabel:
          typeof payload?.producer === "string"
            ? payload.producer
            : request.headers.get("user-agent"),
        payload: payload as Prisma.InputJsonValue,
      },
    },
  });

  return NextResponse.json({ ok: true }, { status: 202 });
}
