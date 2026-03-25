# Dry-Run Plan

Every live marketplace push in reorG is preceded by a dry-run. This document explains what the dry-run does, how to read the results, and when to approve a live push.

---

## What Is a Dry-Run?

A dry-run is a full rehearsal of a push that never touches any marketplace. It calculates exactly what would happen — which listings would change, on which stores, with what values — and returns a complete report before you decide whether to proceed.

**A dry-run:**
- Shows every planned change (store, listing ID, field, old value, new value)
- Evaluates batch safety (size limits, warnings)
- Checks backup readiness (is Cloudflare R2 configured? is a pre-push backup required?)
- Shows post-push refresh availability (do you have enough eBay API calls to refresh the listings after the push?)
- Never writes to eBay, BigCommerce, or Shopify — even if write locks are off

---

## How to Run a Dry-Run

### From the Dashboard

1. Open the dashboard grid.
2. Select a row (or multiple rows) and click **Push Staged Values**.
3. The system automatically runs the dry-run first.
4. Review the dry-run report (see "Reading the Report" below).
5. Confirm the live push only if everything looks correct.

### From Engine Room — Push Queue

1. Go to **Engine Room** → **Push Queue**.
2. Filter the staged changes you want to push (by platform, search term, etc.).
3. Select changes and click **Push Selected** (or equivalent action).
4. A dry-run executes first before any live action.

---

## Reading the Dry-Run Report

### Go-Live Checklist

The dry-run report includes a Go-Live Checklist with these items:

| Item | Meaning |
|------|---------|
| **Write Safety** | Global and per-store write locks are checked. If any are ON for the affected stores, the push is blocked. |
| **Batch Size** | Number of listings and changes compared to the safe batch limits. Green = within recommended, Yellow = warning, Red = blocked. |
| **Pre-Push Backup** | For pushes above a certain size, a backup is required. Shows whether backup storage (R2) is configured and ready. |
| **Confirmation** | Dry-run only — you haven't confirmed the live push yet. Changes to "completed" when you confirm. |
| **Post-Push Refresh** | Checks whether the post-push targeted refresh (re-pulling pushed listings from eBay to confirm live values) has enough API headroom to run. |

### Batch Safety Limits

| Threshold | Listings | Changes | Effect |
|-----------|----------|---------|--------|
| Recommended (green) | ≤ 500 | ≤ 2,000 | Push proceeds with no warning |
| Warning (yellow) | 501–2,000 | 2,001–10,000 | Push can proceed, but splitting recommended |
| Hard cap (red) | > 2,000 | > 10,000 | Push is blocked — split into smaller batches first |

### What to Look For

- **All green** → safe to confirm the live push.
- **Yellow on batch size** → you can still push, but consider splitting for safety.
- **Red on anything** → do not confirm a live push until you resolve the issue shown.
- **"Pre-push backup required"** → the system needs to take an automatic backup before proceeding. If backup storage isn't configured, configure R2 first (see `docs/backup-recovery.md`).
- **Post-push refresh warning** → the push will still succeed, but the live values may not auto-refresh in the grid afterward. You can run a targeted sync manually.

---

## Batch Splitting Strategy

When you have thousands of staged changes (e.g. after a large import), you must split them into batches of ≤ 500 listings each.

**Recommended approach:**

1. Filter by platform first — push eBay TPP, then eBay TT, then BigCommerce, then Shopify separately.
2. Within each platform, push price changes first, then UPC changes, or by SKU group.
3. After each batch: review the push result, watch for partial failures, then proceed to the next batch.
4. Take a manual backup between large batches if you want an extra safety point.

---

## eBay-Specific Dry-Run Notes

- eBay pushes use the **ReviseFixedPriceItem** API call, which counts against your daily call quota.
- The dry-run checks your current quota (from the last sync snapshot) and tells you how many calls are available and how many this push will consume.
- If the dry-run shows insufficient eBay quota, wait for the daily reset (midnight Pacific time) before proceeding.
- During an eBay cooldown (quota exhausted), the push will be blocked for eBay stores. BigCommerce and Shopify pushes are unaffected and can proceed normally.

---

## After the Live Push

1. Review the push result page — look for partial failures.
2. Failed changes remain staged and can be retried.
3. Successful changes are automatically marked as "pushed" and cleared from the staged queue.
4. The post-push targeted refresh automatically re-pulls the affected listings from eBay to confirm live values updated correctly. Watch the Engine Room / Push Jobs panel for completion.
5. If the post-push refresh was deferred (eBay quota low), run a manual targeted sync from the Sync page.

---

## Safety Guarantees

- A dry-run can never cause data loss.
- A dry-run can never modify any marketplace listing.
- A dry-run can never delete any staged change.
- You must explicitly confirm the live push — the system never auto-advances from dry-run to live.

See `docs/write-safety-checklist.md` for the full write safety specification.
