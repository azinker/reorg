import { NextResponse } from "next/server";
import { createHash, createHmac } from "crypto";
import { db } from "@/lib/db";
import { getRequiredSessionUser } from "@/lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── AWS Sig V4 ──────────────────────────────────────────────────────────────

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data).digest();
}
function sha256hex(data: string) {
  return createHash("sha256").update(data).digest("hex");
}
function awsSign(method: string, path: string, query: string): Record<string, string> {
  const accessKeyId     = process.env.AMAZON_AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.AMAZON_AWS_SECRET_ACCESS_KEY ?? "";
  const host   = "sellingpartnerapi-na.amazon.com";
  const region = "us-east-1";
  const service = "execute-api";
  const now = new Date();
  const amzDate  = now.toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex("");
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-date";
  const canonicalRequest = [method, path, query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256hex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");
  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date": amzDate,
  };
}

async function getLwaToken(refreshToken: string): Promise<string> {
  const clientId     = process.env.AMAZON_LWA_CLIENT_ID ?? "";
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET ?? "";
  const res = await fetch("https://api.amazon.com/auth/o2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) throw new Error(`LWA failed: ${data.error ?? res.status}`);
  return data.access_token;
}

async function spGet(lwaToken: string, path: string, query: string) {
  const headers = awsSign("GET", path, query);
  const url = `https://sellingpartnerapi-na.amazon.com${path}?${query}`;
  const res = await fetch(url, {
    headers: { ...headers, "x-amz-access-token": lwaToken, Accept: "application/json" },
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

// ── Route handler ────────────────────────────────────────────────────────────

export async function GET() {
  const user = await getRequiredSessionUser();
  if (!user || user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const integration = await db.integration.findFirst({
    where: { platform: "AMAZON", enabled: true },
    select: { id: true, label: true, config: true },
  });
  if (!integration) {
    return NextResponse.json({ error: "No enabled Amazon integration found." }, { status: 404 });
  }

  const cfg = integration.config as Record<string, unknown>;
  const refreshToken = cfg.refreshToken as string | undefined;
  if (!refreshToken) {
    return NextResponse.json({ error: "Amazon integration has no refresh token." }, { status: 400 });
  }

  // Check env vars
  const envCheck = {
    AMAZON_LWA_CLIENT_ID:         !!process.env.AMAZON_LWA_CLIENT_ID,
    AMAZON_LWA_CLIENT_SECRET:     !!process.env.AMAZON_LWA_CLIENT_SECRET,
    AMAZON_AWS_ACCESS_KEY_ID:     !!process.env.AMAZON_AWS_ACCESS_KEY_ID,
    AMAZON_AWS_SECRET_ACCESS_KEY: !!process.env.AMAZON_AWS_SECRET_ACCESS_KEY,
  };

  let lwaToken: string;
  try {
    lwaToken = await getLwaToken(refreshToken);
  } catch (err) {
    return NextResponse.json({
      envCheck,
      lwaError: String(err),
    });
  }

  // Probe 1: Single-page of financial events (last 7 days, small window)
  const to  = new Date(Date.now() - 3 * 60 * 1000);
  const frm = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const financesQuery = `PostedAfter=${encodeURIComponent(frm.toISOString())}&PostedBefore=${encodeURIComponent(to.toISOString())}&MaxResultsPerPage=5`;
  const financesProbe = await spGet(lwaToken, "/finances/v0/financialEvents", financesQuery);

  // Summarise fee types found
  type FeeEntry = { FeeType?: string; FeeAmount?: { CurrencyCode?: string; CurrencyAmount?: number } };
  type ItemEntry = { ItemFeeList?: FeeEntry[] };
  type ShipEvent = { AmazonOrderId?: string; ShipmentItemList?: ItemEntry[] };
  type FinEvents = {
    ShipmentEventList?: ShipEvent[];
    AdvertisingTransactionEventList?: unknown[];
    [key: string]: unknown;
  };
  type FinPayload = { FinancialEvents?: FinEvents; NextToken?: string };
  type FinResponse = { payload?: FinPayload; errors?: unknown[] };

  let feeTypesSeen: Record<string, number> = {};
  let advertisingEventCount = 0;
  let allTopLevelKeys: string[] = [];
  let shipmentEventCount = 0;

  if (financesProbe.status === 200) {
    const fr = financesProbe.json as FinResponse;
    const fe = fr.payload?.FinancialEvents ?? {};
    allTopLevelKeys = Object.keys(fe);
    shipmentEventCount = fe.ShipmentEventList?.length ?? 0;
    advertisingEventCount = fe.AdvertisingTransactionEventList?.length ?? 0;

    for (const shipEvent of (fe.ShipmentEventList ?? [])) {
      for (const item of (shipEvent.ShipmentItemList ?? [])) {
        for (const fee of (item.ItemFeeList ?? [])) {
          const ft = fee.FeeType ?? "(null)";
          feeTypesSeen[ft] = (feeTypesSeen[ft] ?? 0) + 1;
        }
      }
    }
  }

  // Probe 2: Check seller account (marketplace participations)
  const participationsProbe = await spGet(lwaToken, "/sellers/v1/marketplaceParticipations", "");

  // Probe 3: Check if Advertising API is reachable (different host/scope)
  let advertisingApiProbe: { status: number; body: string } | null = null;
  try {
    const advRes = await fetch(
      "https://advertising-api.amazon.com/v2/profiles",
      {
        headers: {
          Authorization: `Bearer ${lwaToken}`,
          "Amazon-Advertising-API-ClientId": process.env.AMAZON_LWA_CLIENT_ID ?? "",
        },
      },
    );
    advertisingApiProbe = { status: advRes.status, body: (await advRes.text()).slice(0, 500) };
  } catch (err) {
    advertisingApiProbe = { status: 0, body: String(err) };
  }

  return NextResponse.json({
    integration: { id: integration.id, label: integration.label },
    envCheck,
    lwaTokenObtained: true,

    financialEvents: {
      probeStatus: financesProbe.status,
      // Include raw response (first page only) so you can see all event types
      rawResponse: financesProbe.json,
      summary: {
        allTopLevelKeys,
        shipmentEventCount,
        advertisingEventCount,
        feeTypesSeen,
      },
    },

    marketplaceParticipations: {
      probeStatus: participationsProbe.status,
      rawResponse: participationsProbe.json,
    },

    advertisingApiProbe,
  });
}
