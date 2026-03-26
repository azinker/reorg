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
  /** True when live GetApiAccessRules failed but UI shows a GetItem-only cooldown estimate */
  isDegradedEstimate?: boolean;
  degradedNote?: string;
  /** True when counts come from local call tracking, not eBay's GetApiAccessRules */
  isLocallyTracked?: boolean;
}

export interface LocalEbayApiUsage {
  date: string;
  GetItem: number;
  GetSellerList: number;
  GetSellerEvents: number;
  ReviseFixedPriceItem: number;
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
const FALLBACK_CACHE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const SITE_ID = "0";
const COMPAT_LEVEL = "1113";

const snapshotCache = new Map<string, CacheEntry>();
const fallbackSnapshotCache = new Map<string, CacheEntry>();
const tokenCache = new Map<string, TokenCacheEntry>();
let lastGetApiAccessRulesFailure: { at: number; status: number } | null = null;

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
  const ac = new AbortController();
  const abortTimer = setTimeout(() => ac.abort(), 8_000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
      }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(abortTimer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`eBay token refresh failed: ${response.status} — ${body.slice(0, 200)}`);
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

/**
 * Evict the snapshot cache for an integration so the next call to
 * `getEbayTradingRateLimitSnapshotForIntegration` fetches live data.
 * Call this after any eBay sync that consumed API quota.
 */
export function invalidateEbayRateLimitSnapshotCache(
  integration: Pick<Integration, "config">,
): void {
  const credentials = extractFullCredentials(integration);
  if (!credentials) return;
  const key = getCacheKey(credentials);
  snapshotCache.delete(key);
}

/**
 * Shown when GetApiAccessRules is unavailable but we know GetItem is in a
 * cooldown window. All non-GetItem method counts are shown as UNKNOWN (limit 0)
 * because GetApiAccessRules failing means we genuinely cannot determine their
 * usage — ReviseFixedPriceItem, GetSellerList, and GetSellerEvents may each
 * also be exhausted. Never show fake ~0 values that imply available quota.
 */
export function buildGetItemCooldownRateLimitsSnapshot(cooldownUntil: Date): EbayTradingRateLimitSnapshot {
  const resetIso = cooldownUntil.toISOString();
  return {
    fetchedAt: new Date().toISOString(),
    methods: MONITORED_EBAY_METHODS.map((name) => ({
      name,
      // limit=0 signals "unknown" to the UI so it renders "—" instead of a fake count
      count: name === "GetItem" ? 5000 : 0,
      limit: name === "GetItem" ? 5000 : 0,
      remaining: 0,
      reset: resetIso,
      timeWindowSeconds: 86400,
      status: (name === "GetItem" ? "exhausted" : "healthy") as EbayMethodRateLimit["status"],
    })),
    exhaustedMethods: ["GetItem"],
    nextResetAt: resetIso,
    isDegradedEstimate: true,
    degradedNote:
      "Live per-method counts from eBay could not be loaded. GetItem is over quota — shown as fully consumed. Other method counts are unknown (shown as —); they may also be exhausted. Exact usage appears after the quota resets.",
  };
}

function buildServiceUnavailableSnapshot(httpStatus: number): EbayTradingRateLimitSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    methods: MONITORED_EBAY_METHODS.map((name) => ({
      name,
      count: 0,
      limit: 0,
      remaining: 0,
      reset: null,
      timeWindowSeconds: 86400,
      status: "healthy" as EbayMethodRateLimit["status"],
    })),
    exhaustedMethods: [],
    nextResetAt: null,
    isDegradedEstimate: true,
    degradedNote: `eBay's reporting service is temporarily down (HTTP ${httpStatus}). Syncs still work normally — credit counts will appear once eBay's service recovers.`,
  };
}

export async function getEbayTradingRateLimitSnapshotForIntegration(
  integration: Pick<Integration, "config">,
): Promise<EbayTradingRateLimitSnapshot | null> {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

  // Short-circuit if eBay's GetApiAccessRules recently returned 503/5xx.
  // Avoids hammering a down endpoint every 2s during polling.
  if (
    lastGetApiAccessRulesFailure &&
    Date.now() - lastGetApiAccessRulesFailure.at < NEGATIVE_CACHE_TTL_MS
  ) {
    return buildServiceUnavailableSnapshot(lastGetApiAccessRulesFailure.status);
  }

  const credentials = extractFullCredentials(integration);
  if (!credentials) return null;

  const cacheKey = getCacheKey(credentials);
  const cached = snapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.snapshot;
  }

  try {
    const token = await getUserAccessToken(credentials);
    const tradingUrl = getTradingUrl(credentials.environment);

    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetApiAccessRulesRequest>`;

    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 8_000);
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
      signal: ac.signal,
    });
    clearTimeout(abortTimer);

    if (!response.ok) {
      if (response.status >= 500) {
        lastGetApiAccessRulesFailure = { at: Date.now(), status: response.status };
      }
      throw new Error(`GetApiAccessRules failed: ${response.status}`);
    }

    const xml = await response.text();
    const parsed = xmlParser.parse(xml);
    const apiResponse = parsed?.GetApiAccessRulesResponse;
    const ack =
      apiResponse && typeof apiResponse === "object"
        ? String((apiResponse as Record<string, unknown>).Ack ?? "")
        : "";
    if (ack === "Failure") {
      console.warn("[ebay-analytics] GetApiAccessRules returned Failure Ack");
      throw new Error("GetApiAccessRules Ack=Failure");
    }
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
    fallbackSnapshotCache.set(cacheKey, {
      snapshot,
      expiresAt: Date.now() + FALLBACK_CACHE_TTL_MS,
    });

    return snapshot;
  } catch (error) {
    const errMsg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.error(`[ebay-analytics] GetApiAccessRules failed for cacheKey=${cacheKey.slice(0, 8)}…: ${errMsg}`);
    const fallback = fallbackSnapshotCache.get(cacheKey);
    if (fallback && fallback.expiresAt > Date.now()) {
      return {
        ...fallback.snapshot,
        isDegradedEstimate: true,
        degradedNote: `Last refreshed ${fallback.snapshot.fetchedAt ? new Date(fallback.snapshot.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" }) : "recently"}. Live refresh failed — counts may be slightly outdated.`,
      };
    }
    // No fallback available — show "Unknown" for all methods instead of
    // fabricating ~0/~5,000 which misleads the user into thinking quota
    // is available.  limit=0 triggers "Unknown" in the UI.
    console.warn("[ebay-analytics] No fallback snapshot available, returning Unknown placeholder");
    return {
      fetchedAt: new Date().toISOString(),
      methods: MONITORED_EBAY_METHODS.map((name) => ({
        name,
        count: 0,
        limit: 0,
        remaining: 0,
        reset: null,
        timeWindowSeconds: 86400,
        status: "healthy" as EbayMethodRateLimit["status"],
      })),
      exhaustedMethods: [],
      nextResetAt: null,
      isDegradedEstimate: true,
      degradedNote: "Live API credit counts could not be fetched from eBay. Credits will refresh automatically when eBay responds.",
    };
  }
}

/**
 * Fetch rate-limit snapshot using an ALREADY-VALID access token.
 * Use this from sync functions that have their own working token — it
 * bypasses the analytics module's `getUserAccessToken` (which may fail
 * on serverless cold-starts or when the eBay token endpoint is slow).
 */
export async function fetchRateLimitSnapshotWithToken(
  accessToken: string,
): Promise<EbayTradingRateLimitSnapshot | null> {
  // Skip if eBay's endpoint recently returned 5xx
  if (
    lastGetApiAccessRulesFailure &&
    Date.now() - lastGetApiAccessRulesFailure.at < NEGATIVE_CACHE_TTL_MS
  ) {
    return null;
  }

  const SYNC_COMPAT = "1199";
  try {
    const tradingUrl = "https://api.ebay.com/ws/api.dll";
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
</GetApiAccessRulesRequest>`;

    const ac = new AbortController();
    const abortTimer = setTimeout(() => ac.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(tradingUrl, {
        method: "POST",
        headers: {
          "X-EBAY-API-IAF-TOKEN": accessToken,
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": SYNC_COMPAT,
          "X-EBAY-API-CALL-NAME": "GetApiAccessRules",
          "Content-Type": "text/xml",
        },
        body,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(abortTimer);
    }

    const xml = await response.text();
    console.log(`[ebay-analytics] GetApiAccessRules HTTP ${response.status}, body length=${xml.length}, first 300: ${xml.slice(0, 300)}`);

    if (!response.ok) {
      if (response.status >= 500) {
        lastGetApiAccessRulesFailure = { at: Date.now(), status: response.status };
      }
      console.error(`[ebay-analytics] GetApiAccessRules non-OK: ${response.status}`);
      return null;
    }

    const parsed = xmlParser.parse(xml);
    const apiResponse = parsed?.GetApiAccessRulesResponse;
    const ack =
      apiResponse && typeof apiResponse === "object"
        ? String((apiResponse as Record<string, unknown>).Ack ?? "")
        : "";
    if (ack === "Failure") {
      const errors = apiResponse?.Errors;
      console.error(`[ebay-analytics] GetApiAccessRules Ack=Failure, Errors:`, JSON.stringify(errors).slice(0, 500));
      return null;
    }

    const rules: unknown[] = apiResponse?.ApiAccessRule ?? [];
    console.log(`[ebay-analytics] GetApiAccessRules returned ${rules.length} rules, Ack=${ack}`);

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
      .filter((m) => m.status === "exhausted" && m.reset)
      .map((m) => m.name);
    const resetCandidates = methods
      .filter((m) => m.status === "exhausted" && m.reset)
      .map((m) => new Date(m.reset as string))
      .filter((v) => !Number.isNaN(v.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());

    const snapshot: EbayTradingRateLimitSnapshot = {
      fetchedAt: new Date().toISOString(),
      methods,
      exhaustedMethods,
      nextResetAt: resetCandidates[0]?.toISOString() ?? null,
    };

    console.log(`[ebay-analytics] fetchRateLimitSnapshotWithToken SUCCESS: ${methods.map((m) => `${m.name}=${m.count}/${m.limit}`).join(", ")}`);
    return snapshot;
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[ebay-analytics] fetchRateLimitSnapshotWithToken FAILED: ${msg}`);
    return null;
  }
}

/** Persist last successful snapshot to integration config for cold-start recovery. */
export function serializeSnapshotForConfig(
  snapshot: EbayTradingRateLimitSnapshot,
): Record<string, unknown> {
  return {
    fetchedAt: snapshot.fetchedAt,
    methods: snapshot.methods,
    exhaustedMethods: snapshot.exhaustedMethods,
    nextResetAt: snapshot.nextResetAt,
    isLocallyTracked: snapshot.isLocallyTracked ?? false,
  };
}

/** Recover a snapshot from integration config. */
export function deserializeSnapshotFromConfig(
  raw: unknown,
): EbayTradingRateLimitSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.fetchedAt !== "string" || !Array.isArray(obj.methods)) return null;
  const age = Date.now() - new Date(obj.fetchedAt).getTime();
  const maxAge = obj.isLocallyTracked === true ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  if (age > maxAge) return null;
  const isLocal = obj.isLocallyTracked === true;
  return {
    fetchedAt: obj.fetchedAt,
    methods: obj.methods as EbayMethodRateLimit[],
    exhaustedMethods: Array.isArray(obj.exhaustedMethods) ? obj.exhaustedMethods as string[] : [],
    nextResetAt: typeof obj.nextResetAt === "string" ? obj.nextResetAt : null,
    isDegradedEstimate: true,
    isLocallyTracked: isLocal,
    degradedNote: isLocal
      ? "eBay's reporting service is temporarily down. These counts are tracked locally by reorG and may be slightly lower than actual usage."
      : `Saved at ${new Date(obj.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" })} — live refresh is temporarily unavailable.`,
  };
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

const EBAY_DAILY_LIMIT = 5_000;

/**
 * Merge the current sync's API call counts into the cumulative daily tracker.
 * Resets to zero when the date (America/New_York) changes.
 */
export function mergeSyncCallsIntoLocalUsage(
  existing: LocalEbayApiUsage | null | undefined,
  delta: Partial<Record<MonitoredEbayMethod, number>>,
): LocalEbayApiUsage {
  const todayET = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());

  const base: LocalEbayApiUsage =
    existing && existing.date === todayET
      ? { ...existing }
      : { date: todayET, GetItem: 0, GetSellerList: 0, GetSellerEvents: 0, ReviseFixedPriceItem: 0 };

  for (const [key, value] of Object.entries(delta)) {
    if (key in base && typeof value === "number") {
      (base as unknown as Record<string, number>)[key] += value;
    }
  }
  return base;
}

/**
 * Build a rate-limit snapshot from locally tracked API call counts.
 * Used as fallback when eBay's GetApiAccessRules is unreachable (e.g. 503).
 */
export function buildLocallyTrackedSnapshot(
  usage: LocalEbayApiUsage,
): EbayTradingRateLimitSnapshot {
  const methods: EbayMethodRateLimit[] = MONITORED_EBAY_METHODS.map((name) => {
    const count = usage[name] ?? 0;
    const remaining = Math.max(0, EBAY_DAILY_LIMIT - count);
    let status: EbayMethodRateLimit["status"] = "healthy";
    if (remaining === 0) status = "exhausted";
    else if (remaining < EBAY_DAILY_LIMIT * 0.1) status = "tight";
    return { name, count, limit: EBAY_DAILY_LIMIT, remaining, reset: null, timeWindowSeconds: 86400, status };
  });

  return {
    fetchedAt: new Date().toISOString(),
    methods,
    exhaustedMethods: methods.filter((m) => m.status === "exhausted").map((m) => m.name),
    nextResetAt: null,
    isDegradedEstimate: true,
    isLocallyTracked: true,
    degradedNote:
      "eBay's reporting service is temporarily down. These counts are tracked locally by reorG and may be slightly lower than actual usage.",
  };
}
