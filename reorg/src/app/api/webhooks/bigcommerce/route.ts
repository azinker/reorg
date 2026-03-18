import { NextResponse, type NextRequest } from "next/server";
import { safeCompareText } from "@/lib/security";
import { handleMarketplaceWebhook } from "@/lib/services/webhook-sync";

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

  const topic =
    typeof payload?.scope === "string"
      ? payload.scope
      : request.headers.get("x-bc-topic");
  const sourceLabel =
    typeof payload?.producer === "string"
      ? payload.producer
      : request.headers.get("user-agent");
  const externalId =
    typeof payload?.hash === "string"
      ? payload.hash
      : typeof payload?.id === "number" || typeof payload?.id === "string"
        ? String(payload.id)
        : null;

  const result = await handleMarketplaceWebhook({
    platform: "BIGCOMMERCE",
    topic,
    externalId,
    sourceLabel,
  });

  return NextResponse.json({ data: result }, { status: 202 });
}
