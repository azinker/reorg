/**
 * Per-invocation wall clock for catalog paging. Stay below route `maxDuration`
 * (900 s on the execute route) so we can persist cursor, schedule a
 * continuation, and exit cleanly. 13 minutes leaves a 2-minute margin.
 */
export const CATALOG_SYNC_CHUNK_BUDGET_MS = 13 * 60 * 1000;
