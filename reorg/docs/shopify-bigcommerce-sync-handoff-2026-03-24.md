# Shopify + BigCommerce Sync Handoff

Date: 2026-03-24  
Repo root: `C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG`  
App root: `reorg\`  
Production: `https://reorg.theperfectpart.net`
Staging: `https://stage.reorg.theperfectpart.net`

## Scope

This handoff is only about the long-running / stuck sync behavior for:

- `SHOPIFY`
- `BIGCOMMERCE`

It also includes the related UI/status work on the `/sync` page that was done to make the problem easier to see and control.

## Current top-level status

What is working:

- Manual Shopify syncs now at least start correctly and show real progress.
- BigCommerce manual sync launch no longer immediately fails at the button path the way it did before.
- There is now a `Cancel Sync` button on the sync page so a user can stop a stuck pull safely and retry.
- Stale job detection is stricter than before, so dead jobs should not sit around for hours as easily.

What is still broken / under investigation:

- Shopify can still appear to finish the main listing work and then remain in `RUNNING` much longer than it should.
- BigCommerce can still stall after the first chunk, for example around `200 processed / 198 updated`, and remain in `RUNNING` far too long.
- The remaining issue now looks less like a UI bug and more like a worker lifecycle / long-running function / checkpointing problem.

## Access map for the next agent

This section is intentionally written to help another agent find the right systems and variable names **without exposing actual secret values**.

### Vercel

Production app is hosted on Vercel.

Useful local metadata:

- Local Vercel project file:
  - [project.json](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/.vercel/project.json)
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

- [.env.example](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/.env.example)
- [env-checklist.md](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/docs/env-checklist.md)

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

- [api-tokens.md](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/docs/api-tokens.md)
- [ebay-account-deletion.md](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/docs/ebay-account-deletion.md)

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

- [shopify-setup.md](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/docs/shopify-setup.md)
- [shopify-oauth.md](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/docs/shopify-oauth.md)

### BigCommerce

Credential names used by the app:

- `BIGCOMMERCE_STORE_HASH`
- `BIGCOMMERCE_ACCESS_TOKEN`
- `BIGCOMMERCE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_BIGCOMMERCE_STORE_HASH`

Helpful doc:

- [api-tokens.md](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/docs/api-tokens.md)

### Cron / internal sync execution

Important variable:

- `CRON_SECRET`

This matters because:

- scheduler calls use it
- some internal sync execution / continuation flows depend on it

Related code paths:

- [tick route](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/src/app/api/scheduler/tick/route.ts)
- [execute sync route](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/src/app/api/sync/[integrationId]/execute/route.ts)
- [sync-continuation.ts](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/src/lib/services/sync-continuation.ts)

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

Latest commits in local history:

```text
310a4de Shorten stuck sync windows and finish Shopify syncs sooner
cd72f47 Keep variation parent item IDs scoped to parent listings
dbe71c5 Add safe cancel sync control
8c4c68d Show N/A for Shopify and BigCommerce ad rates
8726e84 Finish Shopify and BigCommerce syncs before variation repair
2262081 Inherit eBay ad rates from child variations on parent rows
bad8eeb Show eBay ad rates on synthetic variation parent rows
9a4ebc3 Show eBay parent ad rates on variation parent rows
4479212 Chunk BigCommerce sync batches for faster progress reporting
ce30aca Fix BigCommerce manual sync dispatch path
abc708e Fix manual sync worker authorization
9047418 Fix sync worker auth and refine variation marketplace placeholders
```

At the moment this handoff file was created, `git status --short` showed:

```text
 M reorg/src/components/grid/data-grid.tsx
 M reorg/src/lib/grid-query.ts
```

These are dashboard-related local changes and are **not** the core Shopify/BigCommerce sync work.  
Do **not** casually revert them while debugging sync.

## Deployment / production verification notes

When checking whether production has a specific fix:

1. Verify local git:
   - `git log --oneline -5`
2. Verify pushed branch:
   - `git log origin/main --oneline -5`
3. Confirm the latest commit hash matches
4. Then confirm the newest Vercel deployment is based on that commit

At one point the user explicitly verified:

```text
cd72f47 (HEAD -> main, origin/main) Keep variation parent item IDs scoped to parent listings
dbe71c5 Add safe cancel sync control
8c4c68d Show N/A for Shopify and BigCommerce ad rates
```

So that pattern is a valid way to confirm what is really pushed.

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

### 7. Stale running-job thresholds were tightened

File touched:

- `reorg/src/lib/services/sync-jobs.ts`

Current thresholds:

- zero progress: `5 minutes`
- some progress: `15 minutes`
- large progress (`>= 1000` items): `20 minutes`

Current constants:

```ts
const STALE_RUNNING_JOB_MS = 15 * 60 * 1000;
const STALE_RUNNING_ACTIVE_JOB_MS = 20 * 60 * 1000;
const LARGE_PROGRESS_ITEM_THRESHOLD = 1000;
const STALE_RUNNING_ZERO_PROGRESS_MS = 5 * 60 * 1000;
```

Why:

- Earlier thresholds were too forgiving, so stuck jobs lingered for 60-240 minutes.

Relevant latest commit:

- `310a4de Shorten stuck sync windows and finish Shopify syncs sooner`

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

### 9. Current sync-job stale settings at handoff time

Current code in [sync-jobs.ts](C:/Users/thepe/OneDrive%20-%20theperfectpart.net/Desktop/The%20Perfect%20Part%20reorG/reorg/src/lib/services/sync-jobs.ts):

```ts
const STALE_RUNNING_JOB_MS = 15 * 60 * 1000;
const STALE_RUNNING_ACTIVE_JOB_MS = 20 * 60 * 1000;
const LARGE_PROGRESS_ITEM_THRESHOLD = 1000;
const STALE_RUNNING_ZERO_PROGRESS_MS = 5 * 60 * 1000;
```

Meaning:

- zero-progress jobs should fail after about 5 minutes
- lower-progress jobs after about 15 minutes
- large-progress jobs after about 20 minutes

If production still shows jobs stuck beyond that, one of the following is likely true:

- production is not actually on the newest code
- the displayed job is not the DB job the UI thinks it is
- the stale-fail path is not being triggered for that record

### 10. Current concrete suspicion

As of this handoff, the strongest suspicion is:

- BigCommerce and Shopify still need **resumable / checkpointed full sync execution**
- right now they are still too dependent on a single long-running function invocation
- BigCommerce especially appears to get through an early chunk and then stop advancing
- Shopify appears to finish the bulk listing work but still not flip to a final clean state reliably enough

In other words:

- the system is beyond the “button is broken” stage
- it is now in “long-running production job architecture still needs another pass”

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

### Production code state that was confirmed locally

At handoff time, the local branch already contained these sync-related commits:

- `abc708e Fix manual sync worker authorization`
- `ce30aca Fix BigCommerce manual sync dispatch path`
- `4479212 Chunk BigCommerce sync batches for faster progress reporting`
- `8726e84 Finish Shopify and BigCommerce syncs before variation repair`
- `dbe71c5 Add safe cancel sync control`
- `310a4de Shorten stuck sync windows and finish Shopify syncs sooner`

So a next agent should assume those ideas have already been attempted and should not rediscover them from scratch.

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

As of this handoff, the most likely remaining causes are:

1. **Long-running serverless invocation limits / execution lifecycle**
   - manual sync may still be too monolithic for production Vercel execution
   - even after progress starts, later pages or tail-end work may exceed safe runtime behavior

2. **Lack of checkpointed resumable sync for Shopify/BigCommerce**
   - eBay has richer sync-state/cursor handling already
   - Shopify and BigCommerce still largely run as one long pull
   - if that invocation stalls or dies, the job can remain misleadingly `RUNNING`

3. **Stale job detection still only looks at elapsed time since start**
   - we attempted a heartbeat-based stale check using `updatedAt`, but `SyncJob` does not have an `updatedAt` column, so that was backed out
   - current stale detection is still wall-clock only
   - that is better than before, but not ideal

4. **BigCommerce page/chunk boundaries may still be too large or a later fetch may be hanging**
   - especially since BC can stall after the first chunk reports correctly

## Files most relevant for the next agent

Primary sync orchestration:

- `reorg/src/app/api/sync/[integrationId]/route.ts`
- `reorg/src/lib/services/sync-control.ts`
- `reorg/src/lib/services/sync-scheduler.ts`
- `reorg/src/lib/services/sync-jobs.ts`

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

The user should verify that production includes commit:

- `310a4de Shorten stuck sync windows and finish Shopify syncs sooner`

This is important because the latest shortened-threshold + Shopify-post-completion changes are part of that commit.

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

Then the best next architectural fix is probably:

- break Shopify and BigCommerce full sync into resumable chunks using `syncState.lastCursor`
- each invocation processes only a bounded amount of work
- route re-dispatches next chunk until done

This is probably the highest-leverage next step.

There is already some cursor/state vocabulary in the codebase:

- `syncState.lastCursor`
- `pendingIncrementalItemIds`
- `pendingIncrementalWindowEndedAt`

That machinery is richer on the eBay side than on Shopify/BigCommerce right now.

This would make them behave more like a checkpointed job instead of one giant long-lived serverless call.

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

If it still shows `3223 / 3223` and remains `RUNNING` even after `310a4de`:

- check whether production is still on older code
- if code is current, instrument exactly what happens after the last `db.syncJob.update(...)` in `runShopifySync`
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

Inspect recent sync jobs in the current DB:

```powershell
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

The team has already fixed:

- stale sync page caching
- broken manual dispatch/auth
- expensive variation repair staying on the critical path
- BigCommerce first-batch size being too large
- missing cancel control

What still seems wrong is:

- Shopify and BigCommerce can still remain in `RUNNING` far longer than acceptable
- BigCommerce especially can stall after an early progress chunk

So the next agent should treat this as a **production sync execution / checkpointing problem**, not as a credential problem and not primarily as a UI bug.

## Short plain-English access summary for the next agent

- Vercel project is `reorg`, linked locally in `.vercel/project.json`
- Production domain is `reorg.theperfectpart.net`
- Expected Vercel auth token name is `VERCEL_TOKEN`
- Database secrets live under `DATABASE_URL` and `DIRECT_URL`
- BigCommerce secrets use `BIGCOMMERCE_*`
- Shopify secrets use `SHOPIFY_*`
- eBay deletion webhook details are documented in `docs/ebay-account-deletion.md`
- Do not copy or print actual secret values into the repo
