# Shopify + BigCommerce Sync Handoff

Date: 2026-03-24 (addendum: manual `/execute` dispatch + doc corrections — same file, extend as needed)  
Repo root: `C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG`  
App root: `reorg\`  
Production: `https://reorg.theperfectpart.net`

**For the next agent:** Read **§ Manual sync → `/execute` dispatch**, **§ Stale running-job thresholds (current code)**, and **§ Deploy (PowerShell)** first. Use **repo-relative paths** under `reorg/` (avoid hard-coded `C:\Users\...` links — they break on other machines).

## Scope

This handoff is only about the long-running / stuck sync behavior for:

- `SHOPIFY`
- `BIGCOMMERCE`

It also includes the related UI/status work on the `/sync` page that was done to make the problem easier to see and control.

## Current top-level status

What is working:

- **Chunked catalog pulls** for Shopify and BigCommerce with **resume state** (`catalogPullResume` on integration config) and **continuation** via `POST /api/sync/{integrationId}/execute` + `CRON_SECRET` (same pattern as scheduler chunks).
- **Manual sync from `/sync`:** `POST /api/sync/[integrationId]` now **dispatches real work** by firing `/execute` in a **separate** invocation when `AUTH_URL` (or `VERCEL_URL`) **and** `CRON_SECRET` are set — avoids relying on `after(() => startIntegrationSync(..., "inline"))` alone (which matched production symptoms: `RUNNING` + **0 processed** for many minutes).
- Manual Shopify syncs can show steady progress; BigCommerce reports progress in listing batches.
- `Cancel Sync` (DELETE on the sync API route) stops pulls at checkpoints and clears `catalogPullResume`.
- Stale-job cleanup exists with thresholds tuned for **multi-chunk** pulls (longer wall-clock than the old 5/15/20 minute experiment — see below).

What is still broken / under investigation:

- Shopify can still appear to finish the main listing work and then remain in `RUNNING` longer than expected (tail cleanup / completion path — some of this was addressed by completing the job before heavy post-pull work; re-verify on latest deploy).
- BigCommerce can still stall **between** chunks or on a **slow/hanging** marketplace page fetch — progress may freeze at a multiple of batch size (e.g. ~200) until the next page completes or continuation fires.
- If production env is missing `AUTH_URL` / `CRON_SECRET`, manual sync **falls back** to `after()` + inline sync — expect the old “stuck at 0” class of bugs to return.

## Access map for the next agent

This section is intentionally written to help another agent find the right systems and variable names **without exposing actual secret values**.

### Vercel

Production app is hosted on Vercel.

Useful local metadata:

- Local Vercel project file: `reorg/.vercel/project.json`
- Current values from that file:
  - `projectName`: `reorg`
  - `projectId`: `prj_VH1kTPKHbO4M3U9NUH4ssF95Yzb4`
  - `orgId`: `team_aE7hawQ16Q1r4cguIvntKGaK`
  - `rootDirectory`: `reorg`

Where a Vercel API token would normally be found:

- local shell environment variable name: `VERCEL_TOKEN`
- or local uncommitted `.env` / machine-level environment
- if missing locally, create/find it in:
  - Vercel dashboard -> account settings -> tokens

Important Vercel production env vars relevant to this project:

- `DATABASE_URL`
- `DIRECT_URL`
- `NEXT_PUBLIC_APP_ENV`
- `AUTH_URL`
- `CRON_SECRET`
- `BIGCOMMERCE_STORE_HASH`
- `BIGCOMMERCE_ACCESS_TOKEN`
- `BIGCOMMERCE_WEBHOOK_SECRET`
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_WEBHOOK_SECRET`
- `EBAY_MARKETPLACE_ACCOUNT_DELETION_ENDPOINT`
- `EBAY_MARKETPLACE_ACCOUNT_DELETION_VERIFICATION_TOKEN`

Where to see the expected variable names:

- `reorg/.env.example`
- `reorg/docs/env-checklist.md`

### Database / Neon

The app uses PostgreSQL via Prisma. In practice this project has been using Neon-hosted Postgres.

Credential names:

- `DATABASE_URL`
- `DIRECT_URL`

If API-level Neon access is needed, the variable name used previously was:

- `NEON_API_KEY`

Do not put secret values in docs or git. The next agent should only read them from:

- local `.env` if present
- Vercel project environment variables
- machine environment variables

### GitHub

The repo remote is GitHub-based.

Typical access path:

- Git remote + local SSH auth on this machine
- if an agent shell cannot talk to GitHub directly, ask the user to verify with:
  - `git log origin/main --oneline -3`
  - or use their PowerShell with their SSH setup

### eBay Developer Portal

This project already has production eBay app / webhook setup work in place.

Useful docs:

- `reorg/docs/api-tokens.md`
- `reorg/docs/ebay-account-deletion.md`

Known production values that are safe to document:

- Application URL: `https://reorg.theperfectpart.net`
- Account deletion webhook:
  - `https://reorg.theperfectpart.net/api/webhooks/ebay/account-deletion`

The verification token exists in Vercel env under:

- `EBAY_MARKETPLACE_ACCOUNT_DELETION_VERIFICATION_TOKEN`

Do not copy its value into docs.

### Shopify

Credential names used by the app:

- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_STORE_DOMAIN`
- `SHOPIFY_ACCESS_TOKEN`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_WEBHOOK_SECRET`

Helpful docs:

- `reorg/docs/shopify-setup.md`
- `reorg/docs/shopify-oauth.md`

### BigCommerce

Credential names used by the app:

- `BIGCOMMERCE_STORE_HASH`
- `BIGCOMMERCE_ACCESS_TOKEN`
- `BIGCOMMERCE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_BIGCOMMERCE_STORE_HASH`

Helpful doc:

- `reorg/docs/api-tokens.md`

### Cron / internal sync execution

Important variable:

- `CRON_SECRET`

This matters because:

- Scheduler / tick routes use it.
- **Catalog continuation** and **manual sync dispatch** POST to `/api/sync/{integrationId}/execute` with `Authorization: Bearer CRON_SECRET` (or `x-cron-secret` header — see execute route).
- **Production manual sync** requires `CRON_SECRET` + `AUTH_URL` (or `VERCEL_URL`) so `dispatchManualSyncExecution` can reach `/execute`. If either is missing, the app falls back to `after()` + inline sync (fragile on Vercel).

Related code paths:

- `reorg/src/app/api/scheduler/tick/route.ts`
- `reorg/src/app/api/sync/[integrationId]/execute/route.ts` — `await startIntegrationSync(..., "inline")` (real work runs here for dispatched jobs)
- `reorg/src/app/api/sync/[integrationId]/route.ts` — POST returns `STARTED` quickly; triggers execute when env allows
- `reorg/src/lib/services/sync-continuation.ts` — `dispatchManualSyncExecution`, `dispatchCatalogSyncContinuation`, shared `postSyncExecute`

### Quick rule for the next agent

If you need access:

- first inspect local uncommitted env on the machine
- then inspect Vercel project env
- use the docs above to confirm which variable name you actually need
- never print the raw secret into the repo or the handoff

## Important safety constraints

These come from `AGENTS.md` and must still be respected:

- Sync is pull-only.
- Sync never pushes to marketplaces.
- Sync never overwrites staged values.
- No marketplace deletion functionality.
- No write behavior should be introduced while debugging sync.

## Current git state at time of handoff

Do **not** trust the commit list below as “latest” forever — run:

```powershell
cd "C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG"
git log --oneline -20
```

Notable historical commits (context only):

```text
310a4de Shorten stuck sync windows and finish Shopify syncs sooner
… (older sync / UI / BC chunking commits — see full log)
```

**Later work (may be newer than the above):** chunked BC/Shopify pulls with `catalogPullResume`, `sync-chunk-budget`, `sync-resume-persist`, `sync-continuation`, and **manual sync → `dispatchManualSyncExecution`** in `reorg/src/app/api/sync/[integrationId]/route.ts`. Verify with `git log` and `git blame` on those files.

If `git status` shows unrelated modified files (e.g. dashboard grid), do **not** revert them while debugging sync unless you know they conflict.

## Deployment / production verification notes

When checking whether production has a specific fix:

1. Verify local git: `git log --oneline -5`
2. Verify pushed branch: `git log origin/main --oneline -5` (adjust branch name if needed)
3. Confirm the latest commit hash matches the Vercel deployment’s commit

### Deploy (PowerShell) — give these steps to the user every time code changes

**Option A — Git-connected Vercel (typical)**

```powershell
cd "C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG"

git status
git add -A
git commit -m "your message here"
git push origin main
```

Replace `main` with whatever branch triggers **production** deploys for this project.

**Option B — Vercel CLI**

```powershell
cd "C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG\reorg"
npx vercel --prod
```

**After deploy**

1. Vercel dashboard → project **reorg** → latest deployment → **Ready**
2. Hard-refresh `https://reorg.theperfectpart.net/sync`
3. If testing manual BC/Shopify sync: confirm **Production** env has `AUTH_URL=https://reorg.theperfectpart.net` and `CRON_SECRET` set (see § Cron / internal sync execution).

### Production env sanity for sync dispatch

If manual sync shows `RUNNING` with **0 processed** for many minutes after a deploy:

- Confirm `AUTH_URL` and `CRON_SECRET` exist on **Production** in Vercel.
- Confirm `SKIP_AUTH` (or any debug bypass) is **not** accidentally enabled on production unless intentional.
- Tail **Vercel function logs** for `/api/sync/.../execute` around the time the user clicks Sync.

## Problem history

### Original user-reported behavior

The user repeatedly saw:

- Shopify and BigCommerce staying in `RUNNING` for a very long time
- `/sync` showing `0 processed` for too long
- jobs later becoming stale or showing old stale failures
- durations of 30-60+ minutes that were clearly not acceptable

Examples observed:

- Shopify stuck around `3223 processed / 3223 updated`
- BigCommerce stuck around `200 processed / 198 updated`
- old jobs sometimes showed `0 processed`
- stale failure message:
  - `Marked failed automatically because the sync job exceeded the stale running threshold.`

### Earlier false leads / partial fixes

We initially had multiple overlapping issues:

1. The sync UI could show stale cached status.
2. Manual sync dispatch was broken for some code paths.
3. Variation repair / cleanup ran after the heavy marketplace pull and kept jobs in `RUNNING`.
4. BigCommerce first batch was too large, so progress reporting was too slow.
5. Some old stuck jobs were lingering and making the UI look worse.

## What was changed, in order

### 1. Stale sync status / cached `/sync` page fixes

Files touched:

- `reorg/src/app/api/sync/[integrationId]/route.ts`
- `reorg/src/app/(app)/sync/page.tsx`

Intent:

- Force `/api/sync/[integrationId]` to be dynamic and not cached.
- Make the sync page fetch status with `cache: "no-store"`.
- Clear stale local `syncing` state when fresh server status says job is completed/failed.

Why:

- The page was sometimes showing old `RUNNING` states even when the real DB status had moved on.

### 2. Manual sync worker authorization / dispatch fixes

Files touched over several commits:

- `reorg/src/app/api/sync/[integrationId]/route.ts`
- `reorg/src/app/api/sync/[integrationId]/execute/route.ts`
- `reorg/src/proxy.ts`

Intent:

- Allow the internal sync worker route to be reached correctly from manual UI-triggered syncs.
- Support either `CRON_SECRET` or logged-in session access for internal execution.
- Forward session context properly.
- Later simplify BigCommerce manual dispatch to avoid an extra failing hop.

Relevant commits:

- `abc708e Fix manual sync worker authorization`
- `ce30aca Fix BigCommerce manual sync dispatch path`

Observed result:

- Shopify manual sync behavior improved materially after this.
- BigCommerce immediate button-path failure also improved, but BigCommerce still later hung in long-running sync.

### 3. Variation repair was too expensive and was delaying completion

Files touched:

- `reorg/src/lib/services/variation-repair.ts`
- `reorg/src/lib/services/sync.ts`
- `reorg/src/lib/services/shopify-sync.ts`
- `reorg/src/lib/services/bigcommerce-sync.ts`

Intent:

- Make variation repair skip healthy families instead of reprocessing huge sets unnecessarily.
- Mark sync jobs `COMPLETED` before variation repair, so follow-up repair does not keep the visible sync job open.

Measured locally after optimization:

- Shopify variation repair: about `13s`
- BigCommerce variation repair: about `15s`

Relevant commit:

- `8726e84 Finish Shopify and BigCommerce syncs before variation repair`

Important note:

- Even after this, Shopify still had extra local cleanup in `runShopifySync` before completion:
  - `removeStaleListings(...)`
  - `removeOrphanedMasterRows()`

That cleanup was later moved to after completion too.

### 4. BigCommerce batch sizing was reduced for faster progress reporting

File touched:

- `reorg/src/lib/integrations/bigcommerce.ts`

Changes over time:

- first reduced BC sync batch behavior to improve first visible progress
- later reduced further to:
  - `SYNC_PAGE_SIZE = 25`
  - `SYNC_LISTING_BATCH_SIZE = 50`
  - tiny pause between pages to smooth processing

Current relevant code (after latest local changes):

- `SYNC_PAGE_SIZE = 25`
- `SYNC_LISTING_BATCH_SIZE = 50`
- request timeout remains `30000ms`

Relevant commit:

- `4479212 Chunk BigCommerce sync batches for faster progress reporting`

Plus later local edits not yet separately called out by a unique commit message in this file, but currently present in `310a4de`.

### 5. Cancel Sync was added

Files touched:

- `reorg/src/app/(app)/sync/page.tsx`
- `reorg/src/app/api/sync/[integrationId]/route.ts`
- `reorg/src/lib/services/sync-jobs.ts`
- `reorg/src/lib/services/sync.ts`
- `reorg/src/lib/services/shopify-sync.ts`

Intent:

- Give the user a safe way to stop a long-running pull and retry.

How it works:

- UI now shows `Cancel Sync` next to `Full Sync`.
- DELETE on `/api/sync/[integrationId]` marks the running job failed/cancelled.
- Worker checks `throwIfSyncJobStopped(...)` at safe checkpoints.

Relevant commit:

- `dbe71c5 Add safe cancel sync control`

### 6. Shopify completion was shortened further

File touched:

- `reorg/src/lib/services/shopify-sync.ts`

Change:

- `runShopifySync(...)` now marks the sync job `COMPLETED` before:
  - `removeStaleListings(...)`
  - `removeOrphanedMasterRows()`
  - `repairVariationFamiliesForIntegration(...)`

Why:

- Shopify could reach `3223 processed / 3223 updated` and still remain `RUNNING`, which strongly suggested it was stuck in post-pull cleanup rather than still actively syncing.

### 7. Stale running-job thresholds (evolved for chunked pulls)

File:

- `reorg/src/lib/services/sync-jobs.ts`

**Current code (as of this doc update)** — tuned so a **legitimate** multi-chunk Shopify/BigCommerce catalog job is not marked stale while waiting for continuations; zero-progress runs still fail faster:

```ts
const STALE_RUNNING_JOB_MS = 55 * 60 * 1000;           // ~55 min (some progress, below 1k items)
const STALE_RUNNING_ACTIVE_JOB_MS = 90 * 60 * 1000;     // ~90 min (>= 1000 items processed)
const LARGE_PROGRESS_ITEM_THRESHOLD = 1000;
const STALE_RUNNING_ZERO_PROGRESS_MS = 12 * 60 * 1000;  // ~12 min (0 processed)
```

**Important:** An older version of this handoff incorrectly quoted **5 / 15 / 20** minute constants. That was superseded by the values above — always read `sync-jobs.ts` on the branch you are debugging.

### 8. User-facing production symptoms after these fixes

Observed from production screenshots:

- Shopify eventually started showing:
  - non-zero progress
  - often `3223 processed / 3223 updated`
  - but still remained in `RUNNING` far too long
- BigCommerce improved from immediate failure to:
  - a true running state
  - then often `200 processed / 198 updated`
  - but then it stalled for very long durations, such as `57 minutes`

This is important because it narrows the failure mode:

- launch path issues are not the only problem anymore
- status caching is not the only problem anymore
- the worker is getting partway through real work and then not reaching a clean completion

### 9. Current sync-job stale settings (verify in repo)

Authoritative source: `reorg/src/lib/services/sync-jobs.ts` (see §7 for the current constant values).

Meaning (current tuning):

- **0 processed** → stale after ~**12 minutes** (catches “never started” / hung first fetch)
- **Some progress, fewer than 1000 items** → ~**55 minutes**
- **≥ 1000 items processed** → ~**90 minutes**

If production shows jobs stuck **beyond** these windows, check: wrong deploy, wrong job row in UI, or `GET` handler not calling `failStaleRunningJob` for that poll path.

### 10. Architecture update: checkpointed Shopify / BigCommerce pulls

The older narrative “Shopify and BigCommerce still need resumable checkpointing” is **out of date** relative to the current codebase:

- **BigCommerce:** `reorg/src/lib/services/sync.ts` — chunked loop, `persistCatalogPullResume`, `dispatchCatalogSyncContinuation` when `CATALOG_SYNC_CHUNK_BUDGET_MS` is exceeded.
- **Shopify:** `reorg/src/lib/services/shopify-sync.ts` — same pattern (per-item loop with budget, resume cursor + offset).
- **Budget:** `reorg/src/lib/services/sync-chunk-budget.ts`
- **Resume persistence:** `reorg/src/lib/services/sync-resume-persist.ts`, `CatalogPullResume` in `reorg/src/lib/integrations/runtime-config.ts`

**Remaining suspicion areas (updated):**

1. **Continuation request not running or failing silently** — `void fetch(...)` to `/execute` from `sync-continuation.ts`; check Vercel logs, `CRON_SECRET`, and that `AUTH_URL` points at the **public** production URL (not a preview URL).
2. **First page / first batch hangs** — UI shows `RUNNING` + **0 processed** until first `fetchListings` returns and first batch persists progress (can look like a “stuck start”).
3. **Manual sync path** — must use **`dispatchManualSyncExecution`** on Vercel so work runs under `/execute` (see §11); fallback `after()` + inline is for local dev without secrets.
4. **Tail work after catalog loop** — Shopify still has post-pull cleanup; ensure job is marked `COMPLETED` before the slowest optional steps (already partially addressed — re-verify in `shopify-sync.ts`).

### 11. Manual sync → `/execute` dispatch (critical for Vercel)

**Problem observed:** On production, BC + Shopify both showed **Sync running** with **Processed: 0** for several minutes (“Starting pull…”). A plausible cause was manual sync only scheduling `after(() => startIntegrationSync(..., "inline"))` from `POST /api/sync/[integrationId]`, which is a poor fit for long work on serverless.

**Fix (in tree):**

- `reorg/src/lib/services/sync-continuation.ts` — `dispatchManualSyncExecution(integrationId, mode?)` POSTs to `${AUTH_URL or https://VERCEL_URL}/api/sync/${integrationId}/execute` with `Authorization: Bearer ${CRON_SECRET}` and optional JSON `{ "mode": "full" | "incremental" }`.
- `reorg/src/app/api/sync/[integrationId]/route.ts` — after duplicate-job checks, calls `dispatchManualSyncExecution(integration.id, parsed.data?.mode)` **before** returning `STARTED`. If that returns `false` (missing `AUTH_URL`/`VERCEL_URL` or `CRON_SECRET`), falls back to `after(() => startIntegrationSync(..., "inline"))`.

**Implications for the next agent:**

- Treat **`AUTH_URL` + `CRON_SECRET` on Production** as **required** for healthy manual BC/Shopify sync on Vercel.
- Continuations already used the same `postSyncExecute` helper with `{ resumeContinuation: true }`; manual start now shares the infrastructure.
- The Sync UI still receives `jobId: null` on `STARTED` from the **main** POST route — it must keep polling `GET /api/sync/...` for `lastJob` (unchanged contract).

## What we know from direct inspection

### Local DB inspection

At one point, querying the local DB showed recent successful jobs for Shopify and BigCommerce, including:

- Shopify targeted refresh jobs completing in about 1 second
- BigCommerce targeted refresh jobs completing in about 1 second
- older successful manual full syncs:
  - Shopify: completed with `3223 processed / 3223 updated`
  - BigCommerce: completed with `3148 processed / 3088 updated`

This matters because it suggests:

- marketplace credentials are probably not the core problem
- the sync architecture can work
- the failure mode is likely around long-running production execution and job lifecycle, not basic adapter correctness

### Production code state

Assume the repo may already include: manual sync auth fixes, BC batch chunking, completing jobs before variation repair, cancel sync, **relaxed stale thresholds for chunked jobs**, **catalog resume + continuation**, and **manual dispatch to `/execute`**. Use `git log` / blame on the files in § Files most relevant — do not re-implement from scratch without reading current code.

### Production UI observations

Recent production behavior reported by user:

- Shopify:
  - sometimes shows real progress (`3223 processed / 3223 updated`)
  - then stays in `RUNNING` for very long durations
- BigCommerce:
  - initially often failed immediately
  - after dispatch fixes, it started showing real progress
  - then stalled at values like `200 processed / 198 updated` for nearly an hour

Interpretation:

- Shopify likely completes the main work and then hangs in tail-end work or never reaches the final DB completion update.
- BigCommerce likely gets through its first yielded batch and then hangs on a later page fetch, later chunk, or finalization boundary.

## Current likely root causes

Updated for **checkpointed** BC/Shopify + **manual `/execute` dispatch**:

1. **Continuation or manual `/execute` request failing** — wrong `AUTH_URL`, missing `CRON_SECRET`, preview URL vs production, or fetch dropped when the parent invocation ends (monitor logs; `postSyncExecute` uses fire-and-forget `fetch`).

2. **Per-invocation time budget** — `CATALOG_SYNC_CHUNK_BUDGET_MS` ends a chunk and schedules the next; if continuation never runs, job stays `RUNNING` with partial progress.

3. **Marketplace API slowness or hang** — first `fetchListings` can hold `itemsProcessed` at 0 for a long time; not always a “dispatch bug.”

4. **Stale job detection is wall-clock only** — no `SyncJob.updatedAt`; heartbeat-based stale detection was considered and backed out. Thresholds are long for active large jobs by design (§7).

5. **Tail-phase work** — Shopify post-pull cleanup / integration update ordering can still affect perceived “done” time even after job status improvements.

## Files most relevant for the next agent

Primary sync orchestration:

- `reorg/src/app/api/sync/[integrationId]/route.ts` — POST manual start + `dispatchManualSyncExecution`; GET status; DELETE cancel
- `reorg/src/app/api/sync/[integrationId]/execute/route.ts` — runs `startIntegrationSync(..., "inline")` (worker)
- `reorg/src/lib/services/sync-control.ts`
- `reorg/src/lib/services/sync-scheduler.ts`
- `reorg/src/lib/services/sync-jobs.ts`
- `reorg/src/lib/services/sync-continuation.ts` — manual + continuation `fetch` to `/execute`
- `reorg/src/lib/services/sync-chunk-budget.ts`
- `reorg/src/lib/services/sync-resume-persist.ts`

Shopify path:

- `reorg/src/lib/integrations/shopify.ts`
- `reorg/src/lib/services/shopify-sync.ts`

BigCommerce path:

- `reorg/src/lib/integrations/bigcommerce.ts`
- `reorg/src/lib/services/bigcommerce-sync.ts`
- `reorg/src/lib/services/sync.ts`

Variation tail work:

- `reorg/src/lib/services/variation-repair.ts`

Runtime config / env assumptions:

- `reorg/src/lib/integrations/runtime-config.ts`
- `reorg/.env.example`
- `reorg/docs/env-checklist.md`

UI/status:

- `reorg/src/app/(app)/sync/page.tsx`

Ops / deployment metadata:

- `reorg/.vercel/project.json`
- `reorg/docs/api-tokens.md`
- `reorg/docs/ebay-account-deletion.md`

## Recommended next debugging steps

### 1. Confirm what is actually deployed

Use `git log` / Vercel deployment metadata to confirm production includes:

- Chunked BC/Shopify + resume + continuation work (`sync.ts`, `shopify-sync.ts`, `sync-continuation.ts`, etc.)
- **Manual `dispatchManualSyncExecution`** in `reorg/src/app/api/sync/[integrationId]/route.ts` (fixes “RUNNING + 0 processed” class of issues when env is correct)

Then verify **Vercel Production** env: `AUTH_URL`, `CRON_SECRET`.

### 2. Check production DB job rows after a fresh manual sync

The next agent should inspect production DB job rows specifically for:

- most recent Shopify manual sync
- most recent BigCommerce manual sync

Look for:

- `startedAt`
- `completedAt`
- `itemsProcessed`
- `itemsUpdated`
- `status`
- `errors`

Need to know whether:

- the job row remains truly `RUNNING` in DB
- or the UI is again stale/misreading it

### 3. If DB still shows true long-running `RUNNING`

Shopify/BigCommerce **already** use checkpointed catalog pulls (`catalogPullResume` + `/execute` continuations). Next steps are more likely:

- Confirm **continuations** are firing (Vercel logs for `/api/sync/.../execute` with `resumeContinuation: true`).
- Add **targeted logging** around `postSyncExecute` / first `fetchListings` / `dispatchCatalogSyncContinuation` to see where time goes.
- Confirm **no duplicate** stuck jobs: UI `lastJob` is “most recent by `createdAt`” — an old `RUNNING` row could confuse operators even if a new job completed (rare; usually stale-fail cleans this).

Incremental/delta vocabulary (`syncState.lastCursor`, `pendingIncrementalItemIds`, etc.) remains richer on **eBay** than on BC/Shopify; catalog checkpointing is separate from that.

### 4. Specifically for BigCommerce

Investigate whether later pages after the first chunk are slow/hanging:

- log page numbers
- log elapsed time per page
- log batch emission timing
- log whether the function exits before hitting the final `db.syncJob.update(... status: "COMPLETED")`

The symptom `200 processed / 198 updated` strongly suggests:

- first yielded batch finished
- next page or next chunk did not complete

### 5. Specifically for Shopify

If it still shows `3223 / 3223` and remains `RUNNING` on a **current** deploy:

- Confirm production is on the latest commit (not a stale preview).
- Instrument what happens after the main loop in `runShopifySync` (job completion vs post-pull cleanup).
- possible hidden problem:
  - `db.integration.update(...)`
  - post-completion cleanup
  - audit logging
  - worker lifecycle after response scheduling

Also verify whether the UI card is still tied to the same DB row you think it is.

## Commands that were useful during debugging

Check git state:

```powershell
git status --short
git log --oneline -12
```

Check Vercel linkage metadata:

```powershell
Get-Content '.vercel/project.json'
```

Check env variable names expected by the app:

```powershell
Get-Content 'reorg/.env.example'
Get-Content 'reorg/docs/env-checklist.md'
Get-Content 'reorg/docs/api-tokens.md'
```

Inspect recent sync jobs in the current DB (run from **`reorg`** so `@prisma/client` resolves):

```powershell
cd "C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG\reorg"
@'
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const jobs = await db.syncJob.findMany({
    where: { integration: { platform: { in: ['BIGCOMMERCE','SHOPIFY'] } } },
    include: { integration: true },
    orderBy: { startedAt: 'desc' },
    take: 12,
  });
  for (const job of jobs) {
    console.log(JSON.stringify({
      id: job.id,
      platform: job.integration.platform,
      status: job.status,
      triggeredBy: job.triggeredBy,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      itemsProcessed: job.itemsProcessed,
      itemsCreated: job.itemsCreated,
      itemsUpdated: job.itemsUpdated,
      errors: job.errors,
      integrationId: job.integrationId,
    }));
  }
  await db.$disconnect();
})().catch(async (error) => { console.error(error); await db.$disconnect(); process.exit(1); });
'@ | node
```

## Short plain-English summary for the next agent

Already in place:

- Stale `/sync` caching fixes, cancel sync, BC batch sizing, job completion before the heaviest variation repair, **checkpointed catalog pulls** for BC/Shopify, and **manual sync that POSTs to `/execute`** when `AUTH_URL` + `CRON_SECRET` exist.

Still worth investigating if users report pain:

- **Env misconfiguration** on Vercel (manual sync falls back to fragile `after()` behavior).
- **Continuation or `/execute` failures** (silent `fetch` errors — add logging/alerts).
- **Long `RUNNING` with partial progress** (stuck between chunks or slow marketplace API).
- **Tail work** on Shopify after the main catalog loop.

Treat new bugs as **execution + observability + env**, not as “missing checkpointing” unless code regresses.

## Short plain-English access summary for the next agent

- Vercel project is `reorg`, linked locally in `.vercel/project.json`
- Production domain is `reorg.theperfectpart.net`
- Expected Vercel auth token name is `VERCEL_TOKEN`
- Database secrets live under `DATABASE_URL` and `DIRECT_URL`
- BigCommerce secrets use `BIGCOMMERCE_*`
- Shopify secrets use `SHOPIFY_*`
- eBay deletion webhook details are documented in `docs/ebay-account-deletion.md`
- Do not copy or print actual secret values into the repo

---

## Maintaining this handoff

When sync behavior or thresholds change again:

1. Update **§ Current top-level status**, **§7 / §9** (stale thresholds), and **§11** if the manual/execute contract changes.
2. Refresh **§ Deploy (PowerShell)** only if the team’s deploy process changes.
3. Replace narrative claims with **file paths + “read the source”** so the doc does not drift (this file previously had incorrect stale-timeout numbers — fixed in this revision).
