# reorG — Full Agent Handoff

This document is a complete handoff for an AI agent (e.g. Codex API extension or another Cursor agent) taking over or continuing work on **reorG**. Read it together with **AGENTS.md** (source of truth for rules, safety, and conventions).

---

## 1. What reorG Is

- **Product:** Internal marketplace operations app by The Perfect Part.
- **Purpose:** Aggregate, compare, simulate, stage, and selectively push listing data across connected marketplaces (eBay TPP, eBay TT, BigCommerce, Shopify). One master row per SKU (master store = TPP eBay); other stores attach by exact SKU match. Staged changes are separate from live data; sync is pull-only; push requires explicit user confirmation and goes through a strict write-safety chain.
- **Tech:** Next.js 15 (App Router), TypeScript strict, PostgreSQL + Prisma, Auth.js v5, shadcn/ui + Tailwind, TanStack Table + Virtual, Zustand, SheetJS (xlsx), Resend, Cloudflare R2 (for backups). Hosted on Vercel.
- **Domains:** Production `reorg.theperfectpart.net`.

---

## 2. Absolute Safety Rules (from AGENTS.md — Never Violate)

1. **NEVER** implement marketplace listing deletion (no delete endpoints/UI/code paths).
2. **NEVER** push any marketplace change without explicit user confirmation.
3. **NEVER** let sync push data — sync is pull-only.
4. **NEVER** let sync overwrite staged values — sync only refreshes live marketplace values.
5. **NEVER** auto-restore backups into marketplaces (v1 = export/download only).
6. **NEVER** expose secrets client-side, in logs, API responses, or git.
7. **NEVER** allow writes in staging unless an admin explicitly disables the staging write lock.
8. When in doubt, treat any operation as read-only until the spec says otherwise.

---

## 3. Write Safety Architecture (Must Be Respected)

All marketplace writes must go through:

1. Check global write lock → block if locked  
2. Check per-integration write lock → block if locked  
3. Check environment (staging = blocked by default)  
4. Run dry-run first → show results to user  
5. User confirms dry-run results  
6. Execute real push with full audit logging  
7. Auto-backup before bulk pushes (when implemented)  
8. Update staged change status  
9. Refresh live values via targeted sync  

Global and per-integration write locks are already in the UI (Settings = global, Integrations = per-store). The code path that performs the actual push must call `checkWriteSafety(platform)` and support dry-run; see `src/lib/safety.ts` and `src/lib/services/push.ts`.

---

## 4. What Has Already Been Done (Current State)

### Implemented and wired

- **Auth:** Auth.js v5, email/password + magic link (Resend), Prisma adapter, session.
- **Database:** Prisma schema with User, Account, Session, Integration, MasterRow, MarketplaceListing, UnmatchedListing, StagedChange, SyncJob, PushJob, AuditLog, Backup, AppSetting, ShippingRate, etc. Migrations and seed (admin users + integrations).
- **Dashboard / Grid:** Main data grid loads from `GET /api/grid` (via `getGridData()` in `src/lib/grid-query.ts`). Falls back to `MOCK_ROWS` only if the request fails. Grid supports edit (master + per-listing), stage/discard/clear for price and ad rate, frozen columns, search, density, theme. Profit and shipping derived from weight and shipping rate table.
- **Sync (pull-only):**
  - **TPP eBay:** Implemented. `runEbayTppSync()` in `src/lib/services/ebay-tpp-sync.ts`; uses eBay Inventory + Marketing APIs; creates SyncJob; calls ad-rate backfill after sync. Triggered by `POST /api/sync/[integrationId]` when platform is TPP_EBAY.
  - **Shopify:** Implemented. `runShopifySync()` in `src/lib/services/shopify-sync.ts`. Triggered by same route when platform is SHOPIFY.
  - **TT eBay:** **NOT implemented.** Sync route returns 501 “Sync for TT_EBAY is not yet implemented” for that platform.
  - **BigCommerce:** **NOT implemented.** Sync route returns 501 for BIGCOMMERCE.
- **Staging flow:** Grid stage/discard/clear and “Push” (single-cell push from grid) go through `POST /api/grid/stage` with action `stage` | `push` | `discard` | `clear_all`. The **push** action there performs a **single-listing push** (writes to DB and marketplace for that one listing). There is **no** bulk “push to live” flow wired to the shared push service yet (see “Not done yet” below).
- **eBay Marketing (ad rate):** Live data from eBay Marketing API; stored and shown in grid; parent-only editable for variations; backfill after TPP sync.
- **Engine Room:** Real data. `GET /api/engine-room` returns SyncJobs, StagedChanges (status STAGED), AuditLog (change log + raw events), and summary (activeSyncs, queuedPushes, recentErrors, recentErrorDetail, writeLockOn). UI shows tabs and summary cards; failed sync jobs show error message in card and in Sync Jobs table “Error” column.
- **Write locks:**
  - **Global:** Settings page toggles “Global Write Lock”; persisted to `AppSetting` key `global_write_lock`; hydrated from API; `checkWriteSafety()` in `src/lib/safety.ts` reads it.
  - **Per-integration:** Integrations page shows Write Lock per card; state loaded from `GET /api/integrations`; toggling calls `PATCH /api/integrations/[platform]` with `{ writeLocked }` and updates DB.
- **Unmatched Listings:** Page loads from `GET /api/unmatched`. Link (match manually with master SKU) via `POST /api/unmatched/link`; Ignore via `POST /api/unmatched/ignore`. Empty state explains that the list is filled after syncs when listings can’t be matched to a master SKU.
- **Backups:** Backups page loads from `GET /api/backup` (real Backup table). “Run Backup Now” calls `POST /api/backup` and shows the API response message; list refreshes after. Actual backup execution (snapshot + R2 upload) is not implemented — API returns a placeholder message.
- **Import:** Import wizard (steps 1–5). Step 2: file upload. Step 3: “Validate file” calls `POST /api/import` with `mode=preview`; shows valid/error row counts. Step 4: mode = fill_blanks | overwrite. Step 5: “Run import” sends file + mode; API parses XLSX/CSV, validates (SKU required), upserts MasterRow (fill_blanks only fills empty fields; overwrite replaces). Real DB writes.
- **Shipping rates:** Shipping rate table editor and API wired to DB.
- **Settings:** Theme, density, timezone, frozen columns, search bar, row height, default sort, global write lock, etc. Persisted to `AppSetting` (and global_write_lock synced for safety). TopBar density/theme use a “mounted” guard to avoid hydration mismatch with localStorage.
- **Integrations UI:** Connect flows for eBay (TPP, TT) and Shopify (OAuth); Test connection; Write lock toggles; Last sync from API. TT and BigCommerce cards exist but sync is 501 for them.

### Explicitly not done yet (by design until “push to live” is wired)

- **Bulk “push to live” flow:** The app must **not** call the real push execution for bulk/live pushes until the product owner explicitly asks to “wire push to live.” Currently:
  - `POST /api/push` exists but returns a **mock** response (dry_run_passed / “Connect a database and integration to execute real pushes”). It does **not** call `executePush()` from `src/lib/services/push.ts`.
  - `executePush()` in `src/lib/services/push.ts` is implemented (safety checks, dry-run path, live push via adapters, audit, PushJob record) but is **not** invoked from any API route for real pushes.
  - Grid “Push” for a single cell goes through `POST /api/grid/stage` with action `push`, which updates one listing directly (and DB). Bulk “Push all staged” or “Push to live” from a central control should eventually go through `executePush()` and `POST /api/push` (or equivalent) with dry-run → confirm → execute. Do **not** wire that until the owner approves.
- So: **Do not** connect the UI “push to live” / bulk push button (if any) or any new “Push all” flow to `executePush()` or to adapter `pushPriceUpdates`/`pushAdRateUpdates` until explicitly requested.

---

## 5. What Still Needs To Be Done (Roadmap)

### Integrations and sync

- **TT eBay (Telitetech) integration**
  - Same eBay APIs as TPP but with TT store credentials (separate refresh token / app if needed). Reuse or extend `EbayAdapter` and the same sync pattern as TPP.
  - Add a sync runner for TT (e.g. `runEbayTtSync()` or parameterize the existing eBay sync by integration) and call it from `POST /api/sync/[integrationId]` when `platform === Platform.TT_EBAY`. Create SyncJob, update Integration.lastSyncAt, audit log, handle errors. Optionally run ad-rate backfill for TT if that store uses Promoted Listings.
- **BigCommerce integration**
  - Adapter exists at `src/lib/integrations/bigcommerce.ts`. Wire sync: implement a sync runner (e.g. `runBigCommerceSync()`) that uses the adapter to fetch all listings, runs matching (matchListings), upserts MarketplaceListing, saves unmatched to UnmatchedListing, creates SyncJob, updates Integration.lastSyncAt, audit log. Call it from `POST /api/sync/[integrationId]` when `platform === Platform.BIGCOMMERCE`. Ensure env vars (e.g. BIGCOMMERCE_STORE_HASH, BIGCOMMERCE_ACCESS_TOKEN) are documented and used.

### Push to live (only when product owner approves)

- Wire bulk/live push:
  - Connect the UI flow (e.g. “Push all staged” or “Push to live” from Engine Room or grid) to `POST /api/push` with the list of staged changes.
  - In `POST /api/push`: resolve session/user, build adapters map (TPP eBay, TT eBay, BigCommerce, Shopify from DB + env), call `executePush(request, adapters)`. Return real push job id, status, results, and blockedReason.
  - Ensure dry-run is always run first and user confirms before executing live.
  - After successful push: update StagedChange status, optionally trigger a targeted sync for affected listings.

### Backups

- Implement real backup execution in `POST /api/backup`: snapshot MasterRows, MarketplaceListings, StagedChanges (and any other needed data), generate export files (e.g. CSV/XLSX), upload to Cloudflare R2, create Backup record with storageKey, fileName, size, 30-day expiry. Wire download: signed URL or proxy from R2 so “Download” on the Backups page works.

### Product and docs

- **Errors page:** Wire to real error source (e.g. SyncJob errors, AuditLog failure entries, or a dedicated errors table) and show friendly summaries + technical detail toggle.
- **Setup page:** Drive checklist state from real data (integrations connected, first sync done, write locks, etc.) per `docs/go-live-checklist.md`.
- **Documentation:** Ensure `/docs/` is complete (README, architecture, setup, env checklist, API token guides for eBay/BC/Shopify, import template, shipping rates, smoke test, dry-run plan, go-live checklist, write safety, backup/recovery, Cursor setup). All readable by a non-engineer owner.
- **Design system:** Design system under `design-system/` (MASTER.md, pages) should be followed for visual decisions only; it does not override safety or data model.

### Optional / later

- Operator role (restricted permissions).
- Master store change flow (multi-step confirmation as in AGENTS.md).
- Staging write lock override for admins (if desired).

---

## 6. Key Files and Locations

| Area | Path |
|------|------|
| Agent rules & safety | `AGENTS.md` (repo root) |
| Prisma schema | `reorg/prisma/schema.prisma` |
| Write safety | `reorg/src/lib/safety.ts` |
| Push service | `reorg/src/lib/services/push.ts` |
| Sync services | `reorg/src/lib/services/sync.ts`, `ebay-tpp-sync.ts`, `shopify-sync.ts` |
| Adapters | `reorg/src/lib/integrations/types.ts`, `ebay.ts`, `bigcommerce.ts`, `shopify.ts` |
| Sync API | `reorg/src/app/api/sync/[integrationId]/route.ts` |
| Push API | `reorg/src/app/api/push/route.ts` (currently mock) |
| Grid API | `reorg/src/app/api/grid/route.ts`, `reorg/src/app/api/grid/stage/route.ts`, `reorg/src/app/api/grid/edit/route.ts` |
| Grid data | `reorg/src/lib/grid-query.ts` |
| Engine Room API | `reorg/src/app/api/engine-room/route.ts` |
| Settings API | `reorg/src/app/api/settings/route.ts` |
| Integrations API | `reorg/src/app/api/integrations/route.ts`, `reorg/src/app/api/integrations/[platform]/route.ts` |
| Unmatched API | `reorg/src/app/api/unmatched/route.ts`, `unmatched/ignore/route.ts`, `unmatched/link/route.ts` |
| Backup API | `reorg/src/app/api/backup/route.ts` |
| Import API | `reorg/src/app/api/import/route.ts` |
| Matching | `reorg/src/lib/services/matching.ts` (matchListings, upsertMarketplaceListings, saveUnmatchedListings) |
| Docs | `reorg/docs/` (architecture, go-live-checklist, env-checklist, api-tokens, etc.) |

---

## 7. Conventions To Follow

- **TypeScript strict**, no `any` unless documented.
- **API:** Zod for request validation; use service layer for DB writes (no raw Prisma in route handlers).
- **Adapters:** Implement `MarketplaceAdapter` from `src/lib/integrations/types.ts`; no delete methods.
- **Audit:** Log writes, sync jobs, push attempts, admin actions; retain per AGENTS.md.
- **UI:** Lucide SVG icons, cursor-pointer on clickables, no layout-shifting hovers; dark default, density toggle; frozen columns and sticky search as per AGENTS.md.
- **Env:** Use `NEXT_PUBLIC_APP_ENV` (local | staging | production); staging write-protected by default.

---

## 8. Summary for the Next Agent

- **You can proceed with:** TT eBay sync, BigCommerce sync, Errors page wiring, Setup checklist from real data, backup execution + R2 + download, and documentation. Respect all safety rules and the existing write-lock and dry-run design.
- **Do not wire yet:** Bulk “push to live” to `executePush()` or to live adapter pushes — that is explicitly deferred until the product owner asks for it. Single-cell push from the grid (via `/api/grid/stage` action `push`) is already live for one listing at a time.
- **Use this handoff + AGENTS.md** as the source of truth for scope, safety, and roadmap. If anything conflicts with AGENTS.md, AGENTS.md wins.

End of handoff.
