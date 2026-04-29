# Automation Health Runbook

This guide explains what reorG means when it says store updates are healthy, delayed, or need attention.

---

## What This Covers

reorG keeps marketplace data current in two ways:

- Scheduled pull-only syncs
- Webhook-triggered early refreshes for Shopify and BigCommerce

The app now checks both and reports whether each store is still updating inside its normal window.

---

## Where To Look

Use these pages first:

- `/sync` for the clearest store-by-store status and next step
- `/engine-room` for recent automation decisions, running jobs, and scheduler health
- `/errors` for stores that need follow-up
- `/catalog` for the top warning banner if something falls behind

---

## Health States

### Healthy

Meaning:

- Completed pulls are happening on time
- Shopify and BigCommerce webhooks are arriving recently enough
- No action is needed

What you should see:

- `Healthy`
- `No action needed`

### Running Behind

Meaning:

- A store is still updating, but it is outside its usual timing window
- Or the store is still refreshing on schedule, but Shopify or BigCommerce webhook activity has gone quiet

What to do:

- Watch the next automatic check
- If the store stays behind, run a manual pull from `/sync`
- If the problem is webhook-related, check the webhook destination, secret, and recent deliveries

### Attention Needed

Meaning:

- A store is stale enough that it should be treated as an active issue
- This usually means a completed pull is overdue or missing

What to do:

- Open `/sync` and run a manual pull
- If it still does not recover, open `/errors`
- Then check integration credentials and recent webhook delivery attempts

---

## Expected Timing By Store

### TPP eBay

- Scheduled incremental pull every 30 minutes during daytime hours
- Overnight cadence is slower
- Dashboard updates after the database changes, without a browser refresh

### TT eBay

- Same pattern as TPP eBay
- Changes usually appear after the next scheduled incremental pull completes

### Shopify

- Webhooks can trigger earlier pull-only refreshes between scheduled runs
- Scheduled full pulls remain the safety net
- If webhook activity is quiet, the scheduled cadence still keeps the store current

### BigCommerce

- Webhooks can trigger earlier pull-only refreshes between scheduled runs
- Scheduled full pulls remain the safety net
- If webhook activity stops, scheduled pulls still protect the store, but updates may feel slower

---

## What "Next Step" Means

The app now shows a `Next step` line anywhere automation health is delayed or needs attention.

Examples:

- `Run a manual pull from Sync so this store records its first completed update.`
- `Watch the next automatic check. If this store stays behind, run a manual pull from Sync.`
- `Check the Shopify webhook destination, signing secret, and recent delivery attempts in Integrations and the Shopify admin.`

Treat that line as the recommended first action.

---

## Webhook Troubleshooting

Use this when Shopify or BigCommerce says webhook activity is quiet or missing.

### Shopify

Check:

- Webhook destination URL in reorG Integrations
- Shopify webhook secret
- Recent delivery attempts in Shopify admin
- Whether scheduled pulls are still succeeding

If scheduled pulls are healthy but webhook notices are missing:

- Data is still protected
- Early refreshes may not happen until the next scheduled pull

### BigCommerce

Check:

- Webhook destination URL in reorG Integrations
- BigCommerce webhook secret
- Recent delivery attempts in BigCommerce
- Whether scheduled pulls are still succeeding

If scheduled pulls are healthy but webhook notices are missing:

- Data is still protected
- Early refreshes may not happen until the next scheduled pull

---

## When To Wait Vs Run Sync Now

Wait if:

- The store says a pull is already running
- The store is due now and the next scheduler tick is about to pick it up
- The issue is only a quiet webhook warning and scheduled pulls are still current

Run Sync Now if:

- The store says `Attention needed`
- A store stays delayed after its next automatic check
- You know you made a marketplace change and need the dashboard updated immediately

---

## If A Store Keeps Falling Behind

Work in this order:

1. Open `/sync` and run a manual pull for that store
2. Open `/errors` and read the latest technical details
3. Confirm integration credentials are still valid
4. Confirm webhook destination and secret match the current production domain
5. Check recent webhook delivery attempts in the marketplace admin
6. Use `/engine-room` to confirm whether scheduler jobs are completing

---

## Good Daily Checks

If you want a fast daily confidence check:

1. Open `/sync`
2. Confirm the top health summary says `Healthy`
3. Confirm no store says `Attention needed`
4. Open `/errors`
5. Confirm there are no current sync or automation issues
