import { NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import {
  fetchRateLimitSnapshotWithToken,
  getEbayTradingRateLimitSnapshotForIntegration,
  deserializeSnapshotFromConfig,
} from "@/lib/services/ebay-analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

async function getFreshAccessToken(config: Record<string, unknown>): Promise<string | null> {
  const appId = typeof config.appId === "string" ? config.appId : null;
  const certId = typeof config.certId === "string" ? config.certId : null;
  const refreshToken = typeof config.refreshToken === "string" ? config.refreshToken : null;
  if (!appId || !certId || !refreshToken) return null;

  const basicAuth = Buffer.from(`${appId}:${certId}`).toString("base64");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { access_token?: string };
    return data.access_token ?? null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function rawGetApiAccessRules(token: string, compatLevel: string) {
  const body = `<?xml version="1.0" encoding="utf-8"?><GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetApiAccessRulesRequest>`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const resp = await fetch("https://api.ebay.com/ws/api.dll", {
      method: "POST",
      headers: {
        "X-EBAY-API-IAF-TOKEN": token,
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-COMPATIBILITY-LEVEL": compatLevel,
        "X-EBAY-API-CALL-NAME": "GetApiAccessRules",
        "Content-Type": "text/xml",
      },
      body,
      signal: ac.signal,
    });
    const xml = await resp.text();
    clearTimeout(timer);
    return { httpStatus: resp.status, ok: resp.ok, responsePreview: xml.slice(0, 3000) };
  } catch (e) {
    clearTimeout(timer);
    return { httpStatus: 0, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET() {
  const results: Record<string, unknown>[] = [];

  const integrations = await db.integration.findMany({
    where: { platform: { in: ["TPP_EBAY", "TT_EBAY"] as Platform[] }, enabled: true },
  });

  for (const integration of integrations) {
    const config = isRecord(integration.config) ? integration.config : {};
    const intConfig = getIntegrationConfig(integration);
    const entry: Record<string, unknown> = {
      platform: integration.platform,
      label: integration.label,
    };

    const savedSnapshot = deserializeSnapshotFromConfig(
      intConfig.syncState?.lastRateLimitSnapshot,
    );
    entry.savedSnapshot = savedSnapshot
      ? {
          fetchedAt: savedSnapshot.fetchedAt,
          isDegradedEstimate: savedSnapshot.isDegradedEstimate,
          isLocallyTracked: savedSnapshot.isLocallyTracked,
          methods: savedSnapshot.methods.map((m) => ({
            name: m.name,
            count: m.count,
            limit: m.limit,
            remaining: m.remaining,
          })),
        }
      : "none — no valid saved snapshot";

    // Test 1: Module-level fetch (what the sync page uses)
    try {
      const liveSnapshot = await getEbayTradingRateLimitSnapshotForIntegration(integration);
      entry.moduleFetch = liveSnapshot
        ? {
            fetchedAt: liveSnapshot.fetchedAt,
            isDegradedEstimate: liveSnapshot.isDegradedEstimate,
            isLocallyTracked: liveSnapshot.isLocallyTracked,
            degradedNote: liveSnapshot.degradedNote ?? null,
            methods: liveSnapshot.methods.map((m) => ({
              name: m.name,
              count: m.count,
              limit: m.limit,
              remaining: m.remaining,
              status: m.status,
            })),
          }
        : "returned null";
    } catch (error) {
      entry.moduleFetch = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }

    // Test 2: Get a fresh OAuth token and try GetApiAccessRules directly
    const freshToken = await getFreshAccessToken(config);
    entry.freshTokenObtained = !!freshToken;

    if (freshToken) {
      // Try with compat level 1199
      entry.rawCall_1199 = await rawGetApiAccessRules(freshToken, "1199");

      // Try with compat level 1113 (used by analytics module)
      entry.rawCall_1113 = await rawGetApiAccessRules(freshToken, "1113");

      // Try fetchRateLimitSnapshotWithToken with fresh token
      try {
        const snap = await fetchRateLimitSnapshotWithToken(freshToken);
        entry.freshTokenSnapshot = snap
          ? {
              fetchedAt: snap.fetchedAt,
              isDegradedEstimate: snap.isDegradedEstimate,
              methods: snap.methods.map((m) => ({
                name: m.name,
                count: m.count,
                limit: m.limit,
                remaining: m.remaining,
              })),
            }
          : "returned null";
      } catch (error) {
        entry.freshTokenSnapshot = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    // Test 3: Try stored token too for comparison
    const storedToken = typeof config.accessToken === "string" ? config.accessToken : null;
    if (storedToken) {
      entry.storedTokenRawCall = await rawGetApiAccessRules(storedToken, "1199");
    }

    results.push(entry);
  }

  return NextResponse.json(
    { timestamp: new Date().toISOString(), integrations: results },
    { headers: { "Cache-Control": "no-store" } },
  );
}
