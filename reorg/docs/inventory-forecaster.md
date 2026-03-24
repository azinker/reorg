# Inventory Forecaster

This document explains what the Inventory Forecaster needs, what was added to the codebase, and how to roll it out safely.

---

## What It Does

The Inventory Forecaster is a read-only replenishment planning tool at `/inventory-forecaster`.

It:

- pulls sales history from enabled marketplace integrations
- snapshots live master inventory by SKU
- estimates short-term demand
- subtracts open internal supplier orders already on the way
- lets the team save forecast runs
- lets the team create internal supplier order drafts
- exports a purchasing workbook

It does **not** push any marketplace changes.

---

## Code Added

The feature now includes:

- app page: `src/app/(app)/inventory-forecaster/page.tsx`
- APIs: `src/app/api/inventory-forecaster/*`
- core forecast logic: `src/lib/inventory-forecast/*`
- sidebar and onboarding wiring
- scheduler snapshot hook in `src/app/api/scheduler/tick/route.ts`
- Prisma models and enums in `prisma/schema.prisma`

---

## Database Changes

Two Prisma migrations were prepared locally:

- baseline: `prisma/migrations/0001_initial_baseline/migration.sql`
- forecaster: `prisma/migrations/20260323_inventory_forecaster/migration.sql`

The forecaster migration adds:

- enums:
  `ForecastBucket`, `ForecastConfidence`, `DemandPattern`, `SupplierOrderStatus`, `InventorySourceType`
- tables:
  `marketplace_sale_orders`,
  `marketplace_sale_lines`,
  `inventory_snapshots`,
  `forecast_runs`,
  `forecast_run_lines`,
  `supplier_orders`,
  `supplier_order_lines`

Important: the current Neon database was created outside Prisma Migrate, so the baseline migration must be marked as already applied on existing environments before `prisma migrate deploy` is run.

---

## Environment Requirements

No brand-new environment variables were introduced just for this feature.

The forecaster depends on the existing marketplace credentials already used elsewhere in the app:

- `EBAY_TPP_*`
- `EBAY_TT_*`
- `SHOPIFY_*`
- `BIGCOMMERCE_*`

If one or more integrations are missing credentials, the forecaster still loads, but sales coverage will be partial and warnings will appear in the UI.

The export endpoint also relies on the app being able to fetch product images from stored image URLs.

---

## Safe Rollout Order

Use this order:

1. Deploy to staging first.
2. Mark the baseline migration as applied on staging.
3. Run Prisma migrate deploy on staging.
4. Open the forecaster and run the smoke test.
5. Repeat the same sequence in production.

Do not start by running migration commands against production first.

---

## Existing Database Rollout

For an existing environment like staging or production:

1. Confirm the app is pointed at the correct database.
2. Mark the baseline migration as already applied:

```bash
npx prisma migrate resolve --applied 0001_initial_baseline
```

3. Apply the pending forecaster migration:

```bash
npx prisma migrate deploy
```

4. Verify status:

```bash
npx prisma migrate status
```

Expected result:

- `0001_initial_baseline` is recorded as applied
- `20260323_inventory_forecaster` is applied by deploy

---

## Fresh Database Rollout

For a brand-new database with no existing schema:

```bash
npx prisma migrate deploy
```

That will apply both migrations in order.

---

## Staging Smoke Test

After staging deploy, verify:

1. `/inventory-forecaster` loads.
2. Running a forecast succeeds.
3. Sales coverage dates populate.
4. Warnings appear clearly if marketplace history is partial.
5. `Save Run` creates a forecast run record.
6. `Create Order` creates an internal supplier order only.
7. Editing supplier order status and ETA works.
8. `Export Excel` downloads a workbook.
9. Scheduler tick still succeeds and returns `inventorySnapshots`.

---

## Local Verification Already Completed

The following checks already pass in the current codebase:

- `npm run typecheck`
- `npm test`
- `npm run build`

---

## Remaining Human Step

The remaining action that still needs a person is the actual database rollout on the target environment.

That is the one step not done automatically here because it changes the live database state.
