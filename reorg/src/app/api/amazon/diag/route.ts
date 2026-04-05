/**
 * Amazon SP-API diagnostic endpoint.
 * Visit https://reorg.theperfectpart.net/api/amazon/diag to debug issues.
 *
 * Checks (in order):
 * 1. Env vars present (LWA client ID/secret, AWS keys)
 * 2. Amazon Integration record in DB (refresh token saved)
 * 3. LWA token exchange (can we get an access token?)
 * 4. SP-API connectivity (GetOrders with a dummy ID to verify signing + permissions)
 * 5. IAM policy check (are we getting 403 or 200?)
 */

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createHash, createHmac } from "crypto";

const SP_API_HOST = "sellingpartnerapi-na.amazon.com";
const SP_API_REGION = "us-east-1";
const SP_API_SERVICE = "execute-api";

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function awsSign(opts: {
  method: string;
  path: string;
  query: string;
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Record<string, string> {
  const { method, path, query, body, accessKeyId, secretAccessKey } = opts;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);

  const canonHeaders: Record<string, string> = {
    host: SP_API_HOST,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const sortedKeys = Object.keys(canonHeaders).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${canonHeaders[k]}`).join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${SP_API_REGION}/${SP_API_SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmacSha256(
    hmacSha256(
      hmacSha256(hmacSha256(Buffer.from(`AWS4${secretAccessKey}`, "utf8"), dateStamp), SP_API_REGION),
      SP_API_SERVICE,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    ...canonHeaders,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const testOrderId = searchParams.get("orderId");
  const result: Record<string, unknown> = {};

  // ── 1. Env vars ──────────────────────────────────────────────────────────────
  const lwaClientId = process.env.AMAZON_LWA_CLIENT_ID;
  const lwaClientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;
  const awsKeyId = process.env.AMAZON_AWS_ACCESS_KEY_ID;
  const awsSecret = process.env.AMAZON_AWS_SECRET_ACCESS_KEY;

  result.envVars = {
    AMAZON_LWA_CLIENT_ID: lwaClientId ? `set (${lwaClientId.slice(0, 20)}...)` : "MISSING",
    AMAZON_LWA_CLIENT_SECRET: lwaClientSecret ? `set (${lwaClientSecret.slice(0, 20)}...)` : "MISSING",
    AMAZON_AWS_ACCESS_KEY_ID: awsKeyId ? `set (${awsKeyId.slice(0, 10)}...)` : "MISSING",
    AMAZON_AWS_SECRET_ACCESS_KEY: awsSecret ? `set (length=${awsSecret.length})` : "MISSING",
  };

  const envOk = !!(lwaClientId && lwaClientSecret && awsKeyId && awsSecret);
  result.envVarsOk = envOk;

  // ── 2. DB integration record ─────────────────────────────────────────────────
  const integration = await db.integration.findUnique({
    where: { platform: "AMAZON" },
    select: { id: true, enabled: true, writeLocked: true, config: true },
  }).catch((e: unknown) => ({ error: String(e) }));

  if (!integration || "error" in integration) {
    result.dbIntegration = { found: false, error: integration && "error" in integration ? integration.error : "query failed" };
  } else {
    const cfg = integration.config as Record<string, unknown>;
    const hasRefreshToken = typeof cfg?.refreshToken === "string" && cfg.refreshToken.length > 10;
    result.dbIntegration = {
      found: true,
      id: integration.id,
      enabled: integration.enabled,
      writeLocked: integration.writeLocked,
      hasRefreshToken,
      refreshTokenPreview: hasRefreshToken ? `${String(cfg.refreshToken).slice(0, 10)}...` : null,
      sellerId: cfg?.sellerId ?? null,
    };
  }

  const refreshToken =
    integration && !("error" in integration) && integration.config
      ? ((integration.config as Record<string, unknown>).refreshToken as string | undefined)
      : undefined;

  // ── 3. LWA token exchange ────────────────────────────────────────────────────
  if (!envOk || !refreshToken) {
    result.lwaToken = { skipped: true, reason: !envOk ? "Missing env vars" : "No refresh token in DB" };
  } else {
    try {
      const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: lwaClientId!,
          client_secret: lwaClientSecret!,
        }),
      });
      const tokenBody = await tokenRes.text();
      if (tokenRes.ok) {
        const parsed = JSON.parse(tokenBody) as { access_token?: string; expires_in?: number };
        result.lwaToken = {
          ok: true,
          accessTokenPreview: parsed.access_token ? `${parsed.access_token.slice(0, 20)}...` : null,
          expiresIn: parsed.expires_in,
        };
        // Store for next step
        (result as Record<string, unknown>)._lwaAccessToken = parsed.access_token;
      } else {
        result.lwaToken = { ok: false, status: tokenRes.status, body: tokenBody };
      }
    } catch (e) {
      result.lwaToken = { ok: false, error: String(e) };
    }
  }

  // ── 4. SP-API connectivity — GetOrders with a probe order ID ─────────────────
  const lwaToken = (result as Record<string, unknown>)._lwaAccessToken as string | undefined;
  delete (result as Record<string, unknown>)._lwaAccessToken;

  if (!lwaToken || !awsKeyId || !awsSecret) {
    result.spApi = { skipped: true, reason: "LWA token or AWS credentials unavailable" };
  } else {
    try {
      // Use a dummy order ID — we expect 400 (not found) or 200, NOT 403 (IAM issue) or 401
      const probeQuery = "OrderIds=000-0000000-0000000&MarketplaceIds=ATVPDKIKX0DER";
      const awsHeaders = awsSign({
        method: "GET",
        path: "/orders/v0/orders",
        query: probeQuery,
        body: "",
        accessKeyId: awsKeyId!,
        secretAccessKey: awsSecret!,
      });

      const spRes = await fetch(
        `https://${SP_API_HOST}/orders/v0/orders?${probeQuery}`,
        {
          method: "GET",
          headers: {
            ...awsHeaders,
            "x-amz-access-token": lwaToken,
            Accept: "application/json",
          },
        },
      );

      const spBody = await spRes.text();
      let spBodyParsed: unknown;
      try { spBodyParsed = JSON.parse(spBody); } catch { spBodyParsed = spBody; }

      result.spApi = {
        status: spRes.status,
        statusText: spRes.statusText,
        // 400 = expected (invalid order ID), 200 = success, 403 = IAM/permissions issue
        interpretation:
          spRes.status === 200 || spRes.status === 400
            ? "OK — SP-API reachable and credentials valid"
            : spRes.status === 403
              ? "FORBIDDEN — check IAM policy (execute-api:Invoke) or app authorization"
              : spRes.status === 401
                ? "UNAUTHORIZED — LWA token invalid or app not authorized for this seller"
                : `Unexpected status ${spRes.status}`,
        body: spBodyParsed,
      };
    } catch (e) {
      result.spApi = { skipped: false, error: String(e) };
    }
  }

  // ── 5. Order lookup test (pass ?orderId=111-XXXX-XXXX to test) ───────────────
  if (testOrderId && lwaToken && awsKeyId && awsSecret) {
    try {
      // Step A: GetOrders
      const ordersQuery = `OrderIds=${encodeURIComponent(testOrderId)}&MarketplaceIds=ATVPDKIKX0DER`;
      const awsHeadersOrders = awsSign({
        method: "GET", path: "/orders/v0/orders", query: ordersQuery, body: "",
        accessKeyId: awsKeyId!, secretAccessKey: awsSecret!,
      });
      const ordersRes = await fetch(`https://${SP_API_HOST}/orders/v0/orders?${ordersQuery}`, {
        method: "GET",
        headers: { ...awsHeadersOrders, "x-amz-access-token": lwaToken, Accept: "application/json" },
      });
      const ordersBody = await ordersRes.text();
      let ordersParsed: unknown;
      try { ordersParsed = JSON.parse(ordersBody); } catch { ordersParsed = ordersBody; }
      result.orderLookup = { orderId: testOrderId, getOrdersStatus: ordersRes.status, getOrdersResponse: ordersParsed };

      // Step B: GetOrderItems (if order was found)
      const ordersData = ordersParsed as { payload?: { Orders?: Array<{ AmazonOrderId: string; OrderStatus: string }> } };
      const matched = ordersData?.payload?.Orders?.find((o) => o.AmazonOrderId === testOrderId);
      if (matched) {
        (result.orderLookup as Record<string, unknown>).orderStatus = matched.OrderStatus;
        const itemsQuery = "";
        const awsHeadersItems = awsSign({
          method: "GET", path: `/orders/v0/orders/${testOrderId}/orderItems`, query: itemsQuery, body: "",
          accessKeyId: awsKeyId!, secretAccessKey: awsSecret!,
        });
        const itemsRes = await fetch(`https://${SP_API_HOST}/orders/v0/orders/${testOrderId}/orderItems`, {
          method: "GET",
          headers: { ...awsHeadersItems, "x-amz-access-token": lwaToken, Accept: "application/json" },
        });
        const itemsBody = await itemsRes.text();
        let itemsParsed: unknown;
        try { itemsParsed = JSON.parse(itemsBody); } catch { itemsParsed = itemsBody; }
        (result.orderLookup as Record<string, unknown>).getOrderItemsStatus = itemsRes.status;
        (result.orderLookup as Record<string, unknown>).getOrderItemsResponse = itemsParsed;
      }
    } catch (e) {
      result.orderLookup = { orderId: testOrderId, error: String(e) };
    }
  } else if (testOrderId) {
    result.orderLookup = { skipped: true, reason: "LWA token unavailable — check earlier steps" };
  }

  // ── 6. Summary ───────────────────────────────────────────────────────────────
  const lwaOk = (result.lwaToken as Record<string, unknown>)?.ok === true;
  const spOk =
    [200, 400].includes((result.spApi as Record<string, unknown>)?.status as number);
  const dbOk = (result.dbIntegration as Record<string, unknown>)?.hasRefreshToken === true;

  result.summary = {
    envVarsOk: envOk,
    dbIntegrationOk: dbOk,
    lwaTokenOk: lwaOk,
    spApiOk: spOk,
    overallStatus: envOk && dbOk && lwaOk && spOk ? "ALL OK — Amazon SP-API should work" : "ACTION REQUIRED — see details above",
  };

  return NextResponse.json(result, { status: 200 });
}
