# Shopify + BigCommerce Sync Handoff

Date: 2026-03-24  
Repo root: `C:\Users\thepe\OneDrive - theperfectpart.net\Desktop\The Perfect Part reorG`  
App root: `reorg\`  
Production: `https://reorg.theperfectpart.net`

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

UI/status:

- `reorg/src/app/(app)/sync/page.tsx`

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

This would make them behave more like a checkpointed job instead of one giant long-lived serverless call.

### 4. Specifically for BigCommerce

Investigate whether later pages after the first chunk are slow/hanging:

- log page numbers
- log elapsed time per page
- log batch emission timing

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

## Commands that were useful during debugging

Check git state:

```powershell
git status --short
git log --oneline -12
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

