/**
 * Per-invocation wall clock for catalog paging. Stay well below route
 * `maxDuration` (800 s) so we have room to: write the cursor to the DB,
 * dispatch the continuation POST, and exit cleanly before Vercel terminates
 * the function. 10 minutes (600 s) leaves a 200-second margin — enough for
 * the DB write (~2 s) + continuation dispatch (~5–20 s) + overhead.
 */
export const CATALOG_SYNC_CHUNK_BUDGET_MS = 10 * 60 * 1000;
