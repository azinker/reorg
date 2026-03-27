import { NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { getIntegrationConfig } from "@/lib/integrations/runtime-config";
import {
  fetchRateLimitSnapshotWithToken,
  getEbayTradingRateLimitSnapshotForIntegration,
  deserializeSnapshotFromConfig,
} from "@/lib/services/ebay-analytics";

export async function GET() {
  const results: Record<string, unknown>[] = [];

  const integrations = await db.integration.findMany({
    where: { platform: { in: ["TPP_EBAY", "TT_EBAY"] as Platform[] }, enabled: true },
  });

  for (const integration of integrations) {
    const config = integration.config as Record<string, unknown>;
    const intConfig = getIntegrationConfig(integration);
    const entry: Record<string, unknown> = {
      platform: integration.platform,
      label: integration.label,
      hasAppId: typeof config.appId === "string" && config.appId.length > 0,
      hasCertId: typeof config.certId === "string" && config.certId.length > 0,
      hasRefreshToken: typeof config.refreshToken === "string" && config.refreshToken.length > 0,
      hasAccessToken: typeof config.accessToken === "string" && config.accessToken.length > 0,
      accessTokenExpiresAt: typeof config.accessTokenExpiresAt === "number"
        ? new Date(config.accessTokenExpiresAt as number).toISOString()
        : null,
      accessTokenExpired: typeof config.accessTokenExpiresAt === "number"
        ? (config.accessTokenExpiresAt as number) < Date.now()
        : "no expiry stored",
    };

    // Test 1: Check saved snapshot in config
    const savedSnapshot = deserializeSnapshotFromConfig(
      intConfig.syncState?.lastRateLimitSnapshot,
    );
    entry.savedSnapshot = savedSnapshot
      ? {
          fetchedAt: savedSnapshot.fetchedAt,
          isDegradedEstimate: savedSnapshot.isDegradedEstimate,
          isLocallyTracked: savedSnapshot.isLocallyTracked,
          methodCount: savedSnapshot.methods.length,
          methods: savedSnapshot.methods.map((m) => ({
            name: m.name,
            count: m.count,
            limit: m.limit,
            remaining: m.remaining,
          })),
        }
      : "none — no valid saved snapshot in config";

    // Test 2: Raw snapshot data in config
    const rawSnapshot = intConfig.syncState?.lastRateLimitSnapshot;
    entry.rawSnapshotPresent = rawSnapshot != null;
    if (rawSnapshot && typeof rawSnapshot === "object") {
      const raw = rawSnapshot as Record<string, unknown>;
      entry.rawSnapshotFetchedAt = raw.fetchedAt;
      entry.rawSnapshotIsLocallyTracked = raw.isLocallyTracked;
      const age = typeof raw.fetchedAt === "string"
        ? Date.now() - new Date(raw.fetchedAt).getTime()
        : null;
      entry.rawSnapshotAgeMinutes = age != null ? Math.round(age / 60_000) : null;
      entry.rawSnapshotExpired = age != null ? age > 60 * 60 * 1000 : "unknown";
    }

    // Test 3: Try the GET handler's live fetch
    try {
      const liveSnapshot = await getEbayTradingRateLimitSnapshotForIntegration(integration);
      entry.liveFetch = liveSnapshot
        ? {
            fetchedAt: liveSnapshot.fetchedAt,
            isDegradedEstimate: liveSnapshot.isDegradedEstimate,
            isLocallyTracked: liveSnapshot.isLocallyTracked,
            degradedNote: liveSnapshot.degradedNote ?? null,
            methodCount: liveSnapshot.methods.length,
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
      entry.liveFetch = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
    }

    // Test 4: Try with stored access token directly
    if (typeof config.accessToken === "string" && config.accessToken.length > 0) {
      try {
        const tokenSnapshot = await fetchRateLimitSnapshotWithToken(config.accessToken);
        entry.tokenFetch = tokenSnapshot
          ? {
              fetchedAt: tokenSnapshot.fetchedAt,
              isDegradedEstimate: tokenSnapshot.isDegradedEstimate,
              methodCount: tokenSnapshot.methods.length,
              methods: tokenSnapshot.methods.map((m) => ({
                name: m.name,
                count: m.count,
                limit: m.limit,
                remaining: m.remaining,
              })),
            }
          : "returned null — GetApiAccessRules call failed or returned Ack=Failure";
      } catch (error) {
        entry.tokenFetch = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      entry.tokenFetch = "skipped — no stored access token";
    }

    // Test 5: Raw GetApiAccessRules call to see exact eBay response
    if (typeof config.accessToken === "string" && config.accessToken.length > 0) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 10_000);
        const xmlBody = `<?xml version="1.0" encoding="utf-8"?><GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents"></GetApiAccessRulesRequest>`;
        const resp = await fetch("https://api.ebay.com/ws/api.dll", {
          method: "POST",
          headers: {
            "X-EBAY-API-IAF-TOKEN": config.accessToken as string,
            "X-EBAY-API-SITEID": "0",
            "X-EBAY-API-COMPATIBILITY-LEVEL": "1199",
            "X-EBAY-API-CALL-NAME": "GetApiAccessRules",
            "Content-Type": "text/xml",
          },
          body: xmlBody,
          signal: ac.signal,
        });
        const rawXml = await resp.text();
        clearTimeout(timer);
        entry.rawApiCall = {
          httpStatus: resp.status,
          ok: resp.ok,
          responsePreview: rawXml.slice(0, 2000),
        };
      } catch (error) {
        entry.rawApiCall = `ERROR: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
      }
    }

    results.push(entry);
  }

  return NextResponse.json({ timestamp: new Date().toISOString(), integrations: results });
}
