import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const integration = await db.integration.findFirst({
    where: { platform: "SHOPIFY", enabled: true },
    select: { id: true, config: true },
  });

  if (!integration) {
    return NextResponse.json({ error: "No enabled Shopify integration found" }, { status: 404 });
  }

  const cfg = integration.config as Record<string, unknown>;
  const storeDomain = cfg.storeDomain as string;
  const accessToken = cfg.accessToken as string;
  const apiVersion = (cfg.apiVersion as string) || "2026-01";

  const results: Record<string, unknown> = {
    storeDomain,
    apiVersion,
    integrationId: integration.id,
  };

  // 1. Check token scopes
  try {
    const scopeRes = await fetch(
      `https://${storeDomain}/admin/oauth/access_scopes.json`,
      { headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" } },
    );
    const scopeBody = await scopeRes.text();
    results.scopeStatus = scopeRes.status;
    results.scopes = scopeRes.ok ? JSON.parse(scopeBody) : scopeBody;
  } catch (e) {
    results.scopeError = String(e);
  }

  // 2. Check if fulfillment_orders endpoint is accessible (requires read_merchant_managed_fulfillment_orders)
  try {
    const testOrderRes = await fetch(
      `https://${storeDomain}/admin/api/${apiVersion}/orders.json?limit=1&status=unfulfilled`,
      { headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" } },
    );
    const testBody = await testOrderRes.text();
    results.ordersEndpointStatus = testOrderRes.status;

    if (testOrderRes.ok) {
      const orders = JSON.parse(testBody) as { orders?: Array<{ id: number; name: string }> };
      const firstOrder = orders.orders?.[0];
      results.sampleOrder = firstOrder ? { id: firstOrder.id, name: firstOrder.name } : "none";

      // 3. If we have an order, test the fulfillment_orders endpoint on it
      if (firstOrder) {
        const foRes = await fetch(
          `https://${storeDomain}/admin/api/${apiVersion}/orders/${firstOrder.id}/fulfillment_orders.json`,
          { headers: { "X-Shopify-Access-Token": accessToken, Accept: "application/json" } },
        );
        const foBody = await foRes.text();
        results.fulfillmentOrdersEndpointStatus = foRes.status;
        results.fulfillmentOrdersResponse = foRes.ok ? JSON.parse(foBody) : foBody;
      }
    }
  } catch (e) {
    results.ordersError = String(e);
  }

  return NextResponse.json(results);
}
