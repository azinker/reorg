import { XMLParser } from "fast-xml-parser";
import type { Integration } from "@prisma/client";

export const MONITORED_EBAY_METHODS = [
  "GetSellerEvents",
  "GetItem",
  "GetSellerList",
  "ReviseFixedPriceItem",
] as const;

export type MonitoredEbayMethod = (typeof MONITORED_EBAY_METHODS)[number];

export interface EbayMethodRateLimit {
  name: string;
  count: number;
  limit: number;
  remaining: number;
  reset: string | null;
  timeWindowSeconds: number | null;
  status: "healthy" | "tight" | "exhausted";
}

export interface EbayTradingRateLimitSnapshot {
  fetchedAt: string;
  methods: EbayMethodRateLimit[];
  exhaustedMethods: string[];
  nextResetAt: string | null;
}

type FullEbayCredentials = {
  appId: string;
  certId: string;
  refreshToken: string;
  environment: "PRODUCTION" | "SANDBOX";
};

type CacheEntry = {
  expiresAt: number;
  snapshot: EbayTradingRateLimitSnapshot;
};

type TokenCacheEntry = {
  expiresAt: number;
  accessToken: string;
};

const SNAPSHOT_CACHE_TTL_MS = 90_000;
const SITE_ID = "0";
const COMPAT_LEVEL = "1113";

const snapshotCache = new Map<string, CacheEntry>();
const tokenCache = new Map<string, TokenCacheEntry>();

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  isArray: (tagName) => tagName === "ApiAccessRule",
});

function getBaseUrl(environment: FullEbayCredentials["environment"]) {
  return environment === "SANDBOX"
    ? "https://api.sandbox.ebay.com"
    : "https://api.ebay.com";
}

function getTradingUrl(environment: FullEbayCredentials["environment"]) {
  return environment === "SANDBOX"
    ? "https://api.sandbox.ebay.com/ws/api.dll"
    : "https://api.ebay.com/ws/api.dll";
}

function getCacheKey(credentials: FullEbayCredentials) {
  return `${credentials.environment}:${credentials.appId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNullableString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function toStatus(remaining: number, limit: number): EbayMethodRateLimit["status"] {
  if (remaining <= 0) return "exhausted";
  if (limit > 0 && remaining / limit <= 0.1) return "tight";
  return "healthy";
}

async function getUserAccessToken(credentials: FullEbayCredentials) {
  const cacheKey = `user:${getCacheKey(credentials)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const basicAuth = Buffer.from(
    `${credentials.appId}:${credentials.certId}`,
  ).toString("base64");
  const baseUrl = getBaseUrl(credentials.environment);
  const response = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`eBay token refresh failed: ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || typeof payload.expires_in !== "number") {
    throw new Error("eBay token response missing access_token.");
  }

  tokenCache.set(cacheKey, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  });

  return payload.access_token;
}

function extractFullCredentials(integration: Pick<Integration, "config">): FullEbayCredentials | null {
  if (!isRecord(integration.config)) return null;
  const appId = asNullableString(integration.config.appId);
  const certId = asNullableString(integration.config.certId);
  const refreshToken = asNullableString(integration.config.refreshToken);
  const environment =
    integration.config.environment === "SANDBOX" ? "SANDBOX" : "PRODUCTION";

  if (!appId || !certId || !refreshToken) return null;

  return { appId, certId, refreshToken, environment };
}

export function getEbayCredentialFingerprint(
  integration: Pick<Integration, "config">,
) {
  const credentials = extractFullCredentials(integration);
  return credentials ? getCacheKey(credentials) : null;
}

export async function getEbayTradingRateLimitSnapshotForIntegration(
  integration: Pick<Integration, "config">,
) {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  const credentials = extractFullCredentials(integration);
  if (!credentials) return null;

  const cacheKey = getCacheKey(credentials);
  const cached = snapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  const token = await getUserAccessToken(credentials);
  const tradingUrl = getTradingUrl(credentials.environment);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetApiAccessRulesRequest>`;

  const response = await fetch(tradingUrl, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": token,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": "GetApiAccessRules",
      "Content-Type": "text/xml",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`GetApiAccessRules failed: ${response.status}`);
  }

  const xml = await response.text();
  const parsed = xmlParser.parse(xml);
  const apiResponse = parsed?.GetApiAccessRulesResponse;
  const rules: unknown[] = apiResponse?.ApiAccessRule ?? [];

  const monitoredSet = new Set<string>(MONITORED_EBAY_METHODS);
  const methodMap = new Map<string, EbayMethodRateLimit>();

  for (const rule of rules) {
    if (!isRecord(rule)) continue;
    const callName = String(rule.CallName ?? "");
    if (!monitoredSet.has(callName)) continue;

    const dailyLimit = Number(rule.DailyHardLimit) || 0;
    const dailyUsage = Number(rule.DailyUsage) || 0;
    const remaining = Math.max(0, dailyLimit - dailyUsage);

    const periodicEnd = asNullableString(rule.PeriodicEndDate as string);

    methodMap.set(callName, {
      name: callName,
      count: dailyUsage,
      limit: dailyLimit,
      remaining,
      reset: periodicEnd,
      timeWindowSeconds: 86400,
      status: toStatus(remaining, dailyLimit),
    });
  }

  const methods = MONITORED_EBAY_METHODS.map(
    (method) =>
      methodMap.get(method) ?? {
        name: method,
        count: 0,
        limit: 0,
        remaining: 0,
        reset: null,
        timeWindowSeconds: null,
        status: "healthy" as const,
      },
  );

  const exhaustedMethods = methods
    .filter((method) => method.status === "exhausted" && method.reset)
    .map((method) => method.name);
  const resetCandidates = methods
    .filter((method) => method.status === "exhausted" && method.reset)
    .map((method) => new Date(method.reset as string))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  const snapshot: EbayTradingRateLimitSnapshot = {
    fetchedAt: new Date().toISOString(),
    methods,
    exhaustedMethods,
    nextResetAt: resetCandidates[0]?.toISOString() ?? null,
  };

  snapshotCache.set(cacheKey, {
    snapshot,
    expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS,
  });

  return snapshot;
}

export function getRelevantMonitoredEbayMethods(message: string | null | undefined) {
  const normalized = message?.toLowerCase() ?? "";
  if (normalized.includes("getsellerevents")) return ["GetSellerEvents"] as const;
  if (normalized.includes("getitem")) return ["GetItem"] as const;
  if (normalized.includes("getsellerlist")) return ["GetSellerList"] as const;
  return [...MONITORED_EBAY_METHODS];
}

export function getEbayMethodRate(
  snapshot: EbayTradingRateLimitSnapshot | null,
  method: MonitoredEbayMethod,
) {
  return snapshot?.methods.find((entry) => entry.name === method) ?? null;
}

export function buildEbayQuotaExhaustedMessage(
  method: MonitoredEbayMethod,
  snapshot: EbayTradingRateLimitSnapshot | null,
) {
  const rate = getEbayMethodRate(snapshot, method);
  const resetLabel = rate?.reset
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/New_York",
        timeZoneName: "short",
      }).format(new Date(rate.reset))
    : null;

  return resetLabel
    ? `${method} is out of eBay Trading API calls until about ${resetLabel}.`
    : `${method} is out of eBay Trading API calls until the next eBay reset window.`;
}

export function getEbayCooldownUntilFromSnapshot(
  snapshot: EbayTradingRateLimitSnapshot | null,
  message: string | null | undefined,
  now = new Date(),
) {
  if (!snapshot) return null;
  const relevantMethods = new Set(getRelevantMonitoredEbayMethods(message));
  const resets = snapshot.methods
    .filter(
      (method) =>
        relevantMethods.has(method.name as MonitoredEbayMethod) &&
        method.status === "exhausted" &&
        method.reset,
    )
    .map((method) => new Date(method.reset as string))
    .filter((value) => !Number.isNaN(value.getTime()) && value.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime());

  if (resets.length > 0) return resets[0];

  const fallbackResets = snapshot.methods
    .filter((method) => method.status === "exhausted" && method.reset)
    .map((method) => new Date(method.reset as string))
    .filter((value) => !Number.isNaN(value.getTime()) && value.getTime() > now.getTime())
    .sort((a, b) => b.getTime() - a.getTime());

  return fallbackResets[0] ?? null;
}
