import type { TourStep } from "@/components/onboarding/tour-overlay";
import type { OnboardingPageKey } from "@/lib/onboarding-pages";

export const PAGE_TOUR_STEPS: Record<OnboardingPageKey, TourStep[]> = {
  dashboard: [
    { id: "welcome", target: null, title: "Dashboard overview", body: "This page is your command center for listings, prices, ad rates, and profit. Use the Tour button anytime to reopen this walkthrough." },
    { id: "connection", target: "dashboard-connection", title: "Connection status", body: "This shows if you are on live database data or fallback/mock mode.\n\nExample: Before changing prices, confirm it says connected so you are editing real listings." },
    { id: "search", target: "dashboard-search", title: "Search", body: "Search by SKU, UPC, title, or listing ID and jump directly to the matching row.\n\nExample: Paste an eBay item ID from a support email to locate it instantly." },
    { id: "filters", target: "dashboard-filters", title: "Filters", body: "Filter by store, stock, staged-only, and missing-data types to focus work.\n\nExample: Filter Missing UPC before a feed submission." },
    { id: "toolbar", target: "dashboard-toolbar", title: "Toolbar actions", body: "Use Global Price Update, clear staged values, review failed pushes, and export.\n\nExample: Apply a pricing rule to many SKUs in one pass." },
    { id: "grid", target: "dashboard-grid", title: "Grid editing", body: "Edit sale price and ad rate per store, stage changes, and push when ready.\n\nExample: Stage a promo price, verify profit, then push live." },
  ],
  sync: [
    { id: "sync-1", target: "sync-header", title: "What this page does", body: "Sync pulls fresh listing/order-related data from each marketplace into reorG. It is pull-only, so it does not change marketplace prices by itself.\n\nExample: Before your morning operations check, run sync to make sure quantities and metadata are current." },
    { id: "sync-2", target: "sync-actions", title: "Global sync actions", body: "Use Sync All for a broad refresh, or let automatic background checks keep stores updated on schedule.\n\nExample: After API outage recovery, press Sync All once to quickly repopulate stale data." },
    { id: "sync-3", target: "sync-actions", title: "Automatic background updates", body: "This section shows scheduler health: last check, running jobs, and next actions. It helps you spot when automation is delayed.\n\nExample: If \"Updating now\" stays high too long, check Engine Room for stuck jobs." },
    { id: "sync-4", target: "sync-jobs", title: "Latest scheduled update per store", body: "Review each store’s most recent scheduled pull result, mode, and item counts. This is your quick proof of periodic health.\n\nExample: TT shows failed last run while Shopify is green, so you focus TT credentials first." },
    { id: "sync-5", target: "sync-stores", title: "Per-store sync cards", body: "Each store card has connection status, last sync details, cooldown/rate-limit context, and a Store-specific \"Sync Now\" button.\n\nExample: Only BigCommerce is stale, so you run sync on BC instead of all stores." },
    { id: "sync-6", target: "sync-stores", title: "Error handling on cards", body: "When a store sync fails, expanded details show row-level errors and recent webhook/schedule context so you can diagnose root cause faster.\n\nExample: Card shows repeated auth errors, so you reconnect token on Integrations before retrying." },
  ],
  integrations: [
    { id: "int-1", target: "integrations-header", title: "Integration control center", body: "This page manages credentials, connectivity, and write permissions per store integration.\n\nExample: You rotate Shopify keys here after app credential renewal." },
    { id: "int-2", target: "integrations-header", title: "Connection coverage", body: "The header progress indicator shows how many stores are connected right now, so onboarding gaps are obvious.\n\nExample: 3 of 4 connected tells you one channel is not yet live." },
    { id: "int-3", target: "integrations-global-lock", title: "Per-store lock vs global lock", body: "The amber note explains scope: per-store lock blocks writes for one store; Global Write Lock in Settings blocks all stores.\n\nExample: Freeze only BigCommerce writes during a catalog migration while eBay keeps running." },
    { id: "int-4", target: "integrations-cards", title: "Card-level actions", body: "Each store card supports Connect/Reconnect, Configure, Test Connection, Enable/Disable, and write lock toggles.\n\nExample: Test TPP before enabling so failed credentials are caught early." },
    { id: "int-5", target: "integrations-cards", title: "Master vs secondary stores", body: "Cards also indicate store role (master context), which helps avoid accidental assumptions when matching or importing data.\n\nExample: If TPP is master, unmatched-linking decisions should align with TPP SKU conventions." },
  ],
  engineRoom: [
    { id: "er-1", target: "engine-header", title: "Engine Room purpose", body: "Engine Room is your diagnostics hub for what happened, when, and why across sync, push, and automation pipelines.\n\nExample: A store looks stale—you check here before touching integrations." },
    { id: "er-2", target: "engine-header", title: "Top summary cards", body: "Summary cards surface active jobs, queue depth, failure counts, and other key KPIs so you can triage fast.\n\nExample: Sudden jump in failures indicates an upstream API incident." },
    { id: "er-3", target: "engine-tabs", title: "Choose the right tab", body: "Tabs split concerns: Sync Jobs for pulls, Push Jobs/Queue for writes, Change Log for edits, and Raw Events for low-level traces.\n\nExample: Price changed unexpectedly? Start in Change Log, then trace related push job." },
    { id: "er-4", target: "engine-table", title: "Read status and timing", body: "In tab panels, review status, started/completed times, duration, and counts. Timing patterns reveal throttling or stuck workloads.\n\nExample: Jobs always fail near 2 minutes -> likely timeout boundary." },
    { id: "er-5", target: "engine-table", title: "Failure diagnosis workflow", body: "Use failure fields (category, summary, recommended action) to route issues to the right fix path quickly.\n\nExample: Auth category -> reconnect credentials; validation category -> correct bad SKU data." },
    { id: "er-6", target: "engine-table", title: "Operational handoff", body: "Engine Room records are ideal for handoff notes because they include IDs and timestamps teammates can verify.\n\nExample: Share push job ID + failure summary with the on-call teammate for immediate follow-up." },
  ],
  errors: [
    { id: "err-1", target: "errors-header", title: "Errors page role", body: "This page condenses many raw failures into readable operational issues so teams can triage faster.\n\nExample: Instead of reading logs, ops can act from clear summaries." },
    { id: "err-2", target: "errors-filters", title: "Use filters first", body: "Start by narrowing severity, cause, store, and time window. Filter-first avoids chasing stale noise.\n\nExample: Critical + Last 24h + TT isolates today’s urgent TT incidents." },
    { id: "err-3", target: "errors-list", title: "Grouped issue queues", body: "Issues are grouped by root cause category (stale pull, dead webhook, sync failure, etc.) for focused remediation.\n\nExample: Clear dead-webhook queue first to restore inbound freshness." },
    { id: "err-4", target: "errors-list", title: "Actionable cards", body: "Each card gives summary, technical context, recommended action, and often a direct destination to resolve it.\n\nExample: Card recommends Integrations page; one click takes you to reconnect." },
    { id: "err-5", target: "errors-list", title: "Dismiss vs resolve", body: "Dismiss hides a card from current view, but true resolution requires fixing root cause in data, credentials, or scheduler behavior.\n\nExample: Dismissing a stale pull without fixing sync simply causes it to return later." },
  ],
  unmatched: [
    { id: "um-1", target: "unmatched-header", title: "Why unmatched exists", body: "These are external marketplace listings that could not be mapped to a master SKU automatically.\n\nExample: New listing uses a different SKU format than master store standards." },
    { id: "um-2", target: "unmatched-filters", title: "Narrow the queue", body: "Use store filter and search to process batches in a controlled order.\n\nExample: Handle TPP unmatched first before moving to Shopify." },
    { id: "um-3", target: "unmatched-list", title: "Manual match flow", body: "Choose Match Manually, enter target SKU, and link listing so pricing/profit/operations can attach to the correct master row.\n\nExample: Link TT listing SKU variant to existing master SKU alias." },
    { id: "um-4", target: "unmatched-list", title: "When to ignore", body: "Ignore is useful for noise/test listings, but ignored items can reappear after future syncs if still unmatched.\n\nExample: Sandbox listing can be ignored to keep queue clean." },
    { id: "um-5", target: "unmatched-list", title: "Quality check", body: "After linking, confirm the listing disappears from unmatched and appears correctly in dashboard row identity.\n\nExample: Profit blocks now show for that listing after successful link." },
  ],
  import: [
    { id: "imp-1", target: "import-header", title: "Import page purpose", body: "Use this page for structured workbook imports into master row data.\n\nExample: Bulk update supplier cost and weight from a vendor spreadsheet." },
    { id: "imp-2", target: "import-steps", title: "Step-by-step guardrails", body: "The progress rail helps prevent skipping key safety checks (preview, mode selection, confirmation).\n\nExample: Catch a wrong column heading before any data is written." },
    { id: "imp-3", target: "import-result", title: "Preview and validation", body: "Preview shows valid vs error rows so you can fix source files before apply.\n\nExample: 20 error rows with missing SKU are fixed in Excel first." },
    { id: "imp-4", target: "import-result", title: "Choose import mode", body: "Fill blanks updates only empty fields; Overwrite replaces existing values. Pick mode intentionally per operation.\n\nExample: Use Fill blanks during onboarding, Overwrite during controlled corrections." },
    { id: "imp-5", target: "import-result", title: "Post-import verification", body: "After run, check created/updated counts and row-level apply errors, then spot-check dashboard output.\n\nExample: Updated 300 rows, 4 errors -> fix those 4 and re-run smaller batch." },
  ],
  shippingRates: [
    { id: "ship-1", target: "shipping-header", title: "Shipping rates impact", body: "These tier costs feed directly into shipping-cost and profit calculations across listings.\n\nExample: Incorrect 2LBS rate can make profit appear too high on heavy SKUs." },
    { id: "ship-2", target: "shipping-header", title: "How tier matching works", body: "Rows map normalized weight tiers (oz/lbs). Items between tiers generally use the next higher bracket.\n\nExample: 21oz item maps to the nearest higher configured tier, not lower." },
    { id: "ship-3", target: "shipping-table", title: "Editing strategy", body: "Update only changed tiers from your carrier table to minimize accidental drift.\n\nExample: Carrier changed 1LB and 2LBS only; edit those two rows." },
    { id: "ship-4", target: "shipping-save", title: "Save and verify", body: "Save writes new rates; then spot-check dashboard profit on representative SKUs.\n\nExample: Confirm heavy item profit decreased after cost increase." },
  ],
  backups: [
    { id: "bak-1", target: "backups-header", title: "Backup strategy", body: "This page tracks recovery snapshots (daily + manual) so risky operations are reversible.\n\nExample: Take manual backup before changing many prices." },
    { id: "bak-2", target: "backups-actions", title: "Manual backup actions", body: "Run standard backup for routine safety or full eBay backup for deeper listing detail capture.\n\nExample: Use full eBay backup before major listing remediation." },
    { id: "bak-3", target: "backups-list", title: "History and retention", body: "Review status, size, expiry, and stores covered to confirm backup quality and retention horizon.\n\nExample: Check expiry before planning a delayed rollback window." },
    { id: "bak-4", target: "backups-list", title: "Download formats", body: "Download JSON/XLSX snapshots for analysis, recovery, or audit evidence.\n\nExample: Send XLSX snapshot to analyst for offline reconciliation." },
  ],
  setup: [
    { id: "set-1", target: "setup-header", title: "Setup checklist goal", body: "This page shows implementation readiness across connectivity, data quality, and operational controls.\n\nExample: New team member can see exactly what remains before go-live." },
    { id: "set-2", target: "setup-steps", title: "Understand statuses", body: "Not Started, In Progress, Complete, and Needs Attention help prioritize work in the right order.\n\nExample: Needs Attention on sync health should be handled before enabling live pushes." },
    { id: "set-3", target: "setup-steps", title: "Use as weekly audit", body: "Run through this checklist weekly to catch regressions in integrations and data quality.\n\nExample: A previously complete store can regress after credential expiry." },
    { id: "set-4", target: "setup-steps", title: "Operational readiness mindset", body: "Treat this as a release gate: if critical steps are not complete, postpone risky operations.\n\nExample: Delay large import until shipping tiers and backup status are both healthy." },
  ],
  users: [
    { id: "usr-1", target: "users-header", title: "Users page purpose", body: "Manage account access, role boundaries, and accountability logs for operations security.\n\nExample: Add temporary operator access during seasonal load." },
    { id: "usr-2", target: "users-profile", title: "My account section", body: "Update your display name and password; keep credentials current for secure access.\n\nExample: Rotate password after personnel or device changes." },
    { id: "usr-3", target: "users-manage", title: "Admin user creation", body: "Admins can create user accounts with role assignment and initial credentials.\n\nExample: Create an Operator for fulfillment team edits only." },
    { id: "usr-4", target: "users-manage", title: "User roster + activity", body: "Review who has access and recent user actions to maintain auditability.\n\nExample: Confirm who changed lock settings during an incident review." },
  ],
  settings: [
    { id: "cfg-1", target: "settings-header", title: "Settings overview", body: "Settings controls visual preferences and high-safety operational switches.\n\nExample: Tune density for analysts, keep safeguards for operators." },
    { id: "cfg-2", target: "settings-display", title: "Display preferences", body: "Theme, density, row text size, and row height control readability and working speed.\n\nExample: Compact mode helps when reviewing many rows quickly." },
    { id: "cfg-3", target: "settings-safety", title: "Safety controls", body: "Global Write Lock and Live Push gates prevent accidental production writes.\n\nExample: Enable global lock before testing scripts in production context." },
    { id: "cfg-4", target: "settings-tour", title: "Tour administration", body: "Replay dashboard tour or reset all tours to re-onboard users after major UX changes.\n\nExample: After a redesign, reset all tours so every user gets updated guidance." },
  ],
};
