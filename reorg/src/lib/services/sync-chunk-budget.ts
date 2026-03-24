/**
 * Per-invocation wall clock for catalog paging. Stay below route `maxDuration`
 * so we can persist cursor, schedule a continuation, and exit cleanly.
 */
export const CATALOG_SYNC_CHUNK_BUDGET_MS = 9 * 60 * 1000;
