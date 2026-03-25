import type { Integration, Platform } from "@prisma/client";

export type SyncMode = "full" | "incremental";

export type IncrementalStrategy =
  | "full_only"
  | "ebay_get_seller_events"
  | "shopify_webhook_reconcile"
  | "bigcommerce_webhook_reconcile";

export interface SyncProfile {
  autoSyncEnabled: boolean;
  timezone: string;
  dayStartHour: number;
  dayEndHour: number;
  dayIntervalMinutes: number;
  overnightIntervalMinutes: number;
  preferredMode: SyncMode;
  fullReconcileIntervalHours: number;
  incrementalStrategy: IncrementalStrategy;
}

/** Resume a long catalog pull across multiple serverless invocations (Shopify/BigCommerce). */
export type CatalogPullResume = {
  jobId: string;
  cursor?: string | null;
  /** Skip this many flattened listings on the current API page after re-fetch. */
  listingOffset?: number;
};

export interface SyncState {
  lastRequestedMode: SyncMode | null;
  lastEffectiveMode: SyncMode | null;
  lastScheduledSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastIncrementalSyncAt: string | null;
  lastCursor: string | null;
  lastWebhookAt: string | null;
  lastFallbackReason: string | null;
  lastRateLimitAt: string | null;
  lastRateLimitMessage: string | null;
  pendingIncrementalItemIds: string[];
  pendingIncrementalWindowEndedAt: string | null;
  catalogPullResume?: CatalogPullResume | null;
  lastRateLimitSnapshot?: Record<string, unknown> | null;
}

export interface WebhookState {
  destination: string | null;
  topics: string[];
  providerIds: string[];
  lastEnsuredAt: string | null;
  lastEnsureError: string | null;
}

export type IntegrationConfigRecord = Record<string, unknown> & {
  syncProfile: SyncProfile;
  syncState: SyncState;
  webhookState: WebhookState;
};

type UnknownRecord = Record<string, unknown>;

const DEFAULT_TIMEZONE = "America/New_York";

const DEFAULT_SYNC_PROFILES: Record<Platform, SyncProfile> = {
  TPP_EBAY: {
    autoSyncEnabled: true,
    timezone: DEFAULT_TIMEZONE,
    dayStartHour: 7,
    dayEndHour: 21,
    dayIntervalMinutes: 60,
    overnightIntervalMinutes: 120,
    preferredMode: "incremental",
    fullReconcileIntervalHours: 24,
    incrementalStrategy: "ebay_get_seller_events",
  },
  TT_EBAY: {
    autoSyncEnabled: true,
    timezone: DEFAULT_TIMEZONE,
    dayStartHour: 7,
    dayEndHour: 21,
    dayIntervalMinutes: 60,
    overnightIntervalMinutes: 240,
    preferredMode: "incremental",
    fullReconcileIntervalHours: 24,
    incrementalStrategy: "ebay_get_seller_events",
  },
  SHOPIFY: {
    autoSyncEnabled: true,
    timezone: DEFAULT_TIMEZONE,
    dayStartHour: 7,
    dayEndHour: 21,
    dayIntervalMinutes: 240,
    overnightIntervalMinutes: 600,
    preferredMode: "full",
    fullReconcileIntervalHours: 24,
    incrementalStrategy: "shopify_webhook_reconcile",
  },
  BIGCOMMERCE: {
    autoSyncEnabled: true,
    timezone: DEFAULT_TIMEZONE,
    dayStartHour: 7,
    dayEndHour: 21,
    dayIntervalMinutes: 240,
    overnightIntervalMinutes: 600,
    preferredMode: "full",
    fullReconcileIntervalHours: 24,
    incrementalStrategy: "bigcommerce_webhook_reconcile",
  },
};

const EMPTY_SYNC_STATE: SyncState = {
  lastRequestedMode: null,
  lastEffectiveMode: null,
  lastScheduledSyncAt: null,
  lastFullSyncAt: null,
  lastIncrementalSyncAt: null,
  lastCursor: null,
  lastWebhookAt: null,
  lastFallbackReason: null,
  lastRateLimitAt: null,
  lastRateLimitMessage: null,
  pendingIncrementalItemIds: [],
  pendingIncrementalWindowEndedAt: null,
  catalogPullResume: null,
  lastRateLimitSnapshot: null,
};

const EMPTY_WEBHOOK_STATE: WebhookState = {
  destination: null,
  topics: [],
  providerIds: [],
  lastEnsuredAt: null,
  lastEnsureError: null,
};

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asSyncMode(value: unknown, fallback: SyncMode): SyncMode {
  return value === "incremental" || value === "full" ? value : fallback;
}

function asIncrementalStrategy(
  value: unknown,
  fallback: IncrementalStrategy,
): IncrementalStrategy {
  switch (value) {
    case "ebay_get_seller_events":
    case "shopify_webhook_reconcile":
    case "bigcommerce_webhook_reconcile":
    case "full_only":
      return value;
    default:
      return fallback;
  }
}

export function getDefaultSyncProfile(platform: Platform): SyncProfile {
  return { ...DEFAULT_SYNC_PROFILES[platform] };
}

export function getEmptySyncState(): SyncState {
  return { ...EMPTY_SYNC_STATE };
}

export function getEmptyWebhookState(): WebhookState {
  return { ...EMPTY_WEBHOOK_STATE };
}

export function normalizeSyncProfile(
  platform: Platform,
  raw: unknown,
): SyncProfile {
  const defaults = getDefaultSyncProfile(platform);
  const record = isRecord(raw) ? raw : {};

  return {
    autoSyncEnabled: asBoolean(record.autoSyncEnabled, defaults.autoSyncEnabled),
    timezone: asString(record.timezone, defaults.timezone),
    dayStartHour: asNumber(record.dayStartHour, defaults.dayStartHour),
    dayEndHour: asNumber(record.dayEndHour, defaults.dayEndHour),
    dayIntervalMinutes: asNumber(
      record.dayIntervalMinutes,
      defaults.dayIntervalMinutes,
    ),
    overnightIntervalMinutes: asNumber(
      record.overnightIntervalMinutes,
      defaults.overnightIntervalMinutes,
    ),
    preferredMode: asSyncMode(record.preferredMode, defaults.preferredMode),
    fullReconcileIntervalHours: asNumber(
      record.fullReconcileIntervalHours,
      defaults.fullReconcileIntervalHours,
    ),
    incrementalStrategy: asIncrementalStrategy(
      record.incrementalStrategy,
      defaults.incrementalStrategy,
    ),
  };
}

function normalizeCatalogPullResume(raw: unknown): CatalogPullResume | null {
  if (!isRecord(raw)) return null;
  const jobId = typeof raw.jobId === "string" && raw.jobId.trim() ? raw.jobId : null;
  if (!jobId) return null;
  const cursor =
    raw.cursor === undefined || raw.cursor === null
      ? null
      : typeof raw.cursor === "string"
        ? raw.cursor
        : String(raw.cursor);
  let listingOffset: number | undefined;
  if (
    typeof raw.listingOffset === "number" &&
    Number.isFinite(raw.listingOffset) &&
    raw.listingOffset > 0
  ) {
    listingOffset = Math.floor(raw.listingOffset);
  }
  return { jobId, cursor, listingOffset };
}

export function normalizeSyncState(raw: unknown): SyncState {
  const record = isRecord(raw) ? raw : {};

  return {
    lastRequestedMode:
      record.lastRequestedMode === "incremental" ||
      record.lastRequestedMode === "full"
        ? record.lastRequestedMode
        : null,
    lastEffectiveMode:
      record.lastEffectiveMode === "incremental" ||
      record.lastEffectiveMode === "full"
        ? record.lastEffectiveMode
        : null,
    lastScheduledSyncAt: asNullableString(record.lastScheduledSyncAt),
    lastFullSyncAt: asNullableString(record.lastFullSyncAt),
    lastIncrementalSyncAt: asNullableString(record.lastIncrementalSyncAt),
    lastCursor: asNullableString(record.lastCursor),
    lastWebhookAt: asNullableString(record.lastWebhookAt),
    lastFallbackReason: asNullableString(record.lastFallbackReason),
    lastRateLimitAt: asNullableString(record.lastRateLimitAt),
    lastRateLimitMessage: asNullableString(record.lastRateLimitMessage),
    pendingIncrementalItemIds: asStringArray(record.pendingIncrementalItemIds),
    pendingIncrementalWindowEndedAt: asNullableString(record.pendingIncrementalWindowEndedAt),
    catalogPullResume: normalizeCatalogPullResume(record.catalogPullResume),
    lastRateLimitSnapshot:
      isRecord(record.lastRateLimitSnapshot) ? record.lastRateLimitSnapshot : null,
  };
}

export function normalizeWebhookState(raw: unknown): WebhookState {
  const record = isRecord(raw) ? raw : {};

  return {
    destination: asNullableString(record.destination),
    topics: asStringArray(record.topics),
    providerIds: asStringArray(record.providerIds),
    lastEnsuredAt: asNullableString(record.lastEnsuredAt),
    lastEnsureError: asNullableString(record.lastEnsureError),
  };
}

export function normalizeIntegrationConfig(
  platform: Platform,
  rawConfig: unknown,
): IntegrationConfigRecord {
  const record = isRecord(rawConfig) ? { ...rawConfig } : {};

  return {
    ...record,
    syncProfile: normalizeSyncProfile(platform, record.syncProfile),
    syncState: normalizeSyncState(record.syncState),
    webhookState: normalizeWebhookState(record.webhookState),
  };
}

export function mergeIntegrationConfig(
  platform: Platform,
  currentConfig: unknown,
  patch: UnknownRecord,
): IntegrationConfigRecord {
  const current = normalizeIntegrationConfig(platform, currentConfig);
  const nextProfile =
    isRecord(patch.syncProfile)
      ? normalizeSyncProfile(platform, {
          ...current.syncProfile,
          ...patch.syncProfile,
        })
      : current.syncProfile;
  const nextState =
    isRecord(patch.syncState)
      ? normalizeSyncState({
          ...current.syncState,
          ...patch.syncState,
        })
      : current.syncState;
  const nextWebhookState =
    isRecord(patch.webhookState)
      ? normalizeWebhookState({
          ...current.webhookState,
          ...patch.webhookState,
        })
      : current.webhookState;

  return {
    ...current,
    ...patch,
    syncProfile: nextProfile,
    syncState: nextState,
    webhookState: nextWebhookState,
  };
}

export function getIntegrationConfig(
  integration: Pick<Integration, "platform" | "config">,
): IntegrationConfigRecord {
  return normalizeIntegrationConfig(integration.platform, integration.config);
}

export function isIncrementalReady(platform: Platform): boolean {
  return platform === "TPP_EBAY" || platform === "TT_EBAY";
}
