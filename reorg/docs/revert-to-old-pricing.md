# Revert to Old Pricing

Use this when you want to **undo the +$1.60 pricing test** on eBay TPP and TT and put sale prices back exactly where they were before that test.

## What to say

Tell the agent any of these:

- **Revert to old pricing**
- **Revert the $1.60 pricing test**
- **Undo the pricing test bump**

The agent will inspect the revert manifest, summarize what will change, and ask you to confirm before any live eBay writes.

## What gets reverted (only what actually changed)

The undo list lives in:

`reorg/reports/pricing-test-bump-160-manifest.json`

Each manifest entry is **one eBay listing write** that succeeded during the test. Revert pushes that listing’s stored **`oldPrice`** back to eBay and updates the reorG catalog to match.

| Included | Not included |
|----------|----------------|
| Listings in the manifest with `appliedAt` set and no `revertedAt` | **154 skipped SKUs** — never sent to eBay (no manifest row) |
| Per listing, per store (TPP and TT separately) | **12 failed API writes** — eBay rejected them; price was never changed |
| Variation listings (uses stored item ID + variation SKU) | BigCommerce, Shopify, or any non-eBay store |

**Important:** Revert is **per listing**, not one price per SKU. If the same SKU had nine active eBay listings at nine different prices before the test, each listing goes back to its own original price.

After the June 2026 full run, the manifest held **2,703** successful listing writes (2,701 from the full batch plus 2 from the earlier `GA96_WDN_DGT` test). That number drops as entries are reverted (`revertedAt` is set).

## What the agent does

1. Confirm prod database (`little-fire` guard).
2. Read the manifest and count entries still waiting to revert (`revertedAt` is null).
3. Report:
   - listing count to revert
   - unique SKU count
   - TPP vs TT split
   - manifest path
4. Ask for explicit confirmation: **OKAY PROCEED**
5. Run the live revert (see command below).
6. Summarize: reverted count, failures (if any), report paths, and a short table of SKU / store / restored price for successful rows.

## Live revert command (agent only — do not run casually)

```powershell
cd reorg
$env:ENABLE_LIVE_EBAY_PRICE_MUTATIONS = "true"
npx dotenv-cli -e .env.prod -- npx tsx scripts/_batch-pricing-test-bump-160.ts --revert --confirmed-batch --report=reports/pricing-test-bump-160-revert-<date>.json
```

Reports written:

- `reorg/reports/pricing-test-bump-160-revert-<date>.json`
- `reorg/reports/pricing-test-bump-160-revert-<date>.xlsx`

The manifest is updated in place: successful rows get `revertedAt`, and fully reverted SKUs are removed from `completedSkus`.

## Safety

- Same write-safety chain as any marketplace push (write locks, prod guard, confirmation).
- **No dry-run mode for revert** — the agent must show the manifest preview and wait for **OKAY PROCEED** before running.
- Running revert twice is safe: entries already reverted are skipped (`revertedAt` set).
- This does **not** delete listings and does **not** touch staged values in the catalog grid — only live `salePrice` on the affected `MarketplaceListing` rows.

## Related files

| File | Purpose |
|------|---------|
| `reorg/scripts/_batch-pricing-test-bump-160.ts` | Bump and revert script |
| `reorg/reports/pricing-test-bump-160-manifest.json` | Source of truth for undo |
| `reorg/reports/pricing-test-bump-160-live-full-2026-06-26.json` | Full bump run report |
| `reorg/reports/pricing-test-bump-160-skipped-skus.json` | 154 SKUs never bumped (no revert needed) |

## Example: `FB236_DSK_CLK`

That SKU was **skipped** during the bump (no active TPP/TT row in the catalog). It is **not** in the manifest. Saying **Revert to old pricing** will **not** change it on eBay — it was never part of the test.
