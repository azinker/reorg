import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { getSkuVaultQuantity } from "@/lib/services/skuvault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  sku: z.string().trim().min(1).max(120),
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
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    }),
  );
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id && !isAuthBypassEnabled()) {
      return withExtensionCors(
        request,
        NextResponse.json({ error: "Unauthorized. Log into reorG first, then try again." }, { status: 401 }),
      );
    }

    const parsed = querySchema.safeParse({
      sku: request.nextUrl.searchParams.get("sku") ?? "",
    });
    if (!parsed.success) {
      return withExtensionCors(
        request,
        NextResponse.json({ error: "Enter a valid SKU." }, { status: 400 }),
      );
    }

    const data = await getSkuVaultQuantity(parsed.data.sku);
    return withExtensionCors(request, NextResponse.json({ data }));
  } catch (error) {
    console.error("[skuvault/quantity] failed", error);
    return withExtensionCors(
      request,
      NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to load SkuVault quantity." },
        { status: 500 },
      ),
    );
  }
}
