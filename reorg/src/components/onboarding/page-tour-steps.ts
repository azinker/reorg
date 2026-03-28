import type { TourStep } from "@/components/onboarding/tour-overlay";
import type { OnboardingPageKey } from "@/lib/onboarding-pages";

export const PAGE_TOUR_STEPS: Record<OnboardingPageKey, TourStep[]> = {
  /* ================================================================
   * DASHBOARD
   * ================================================================ */
  dashboard: [
    {
      id: "dashboard-1",
      target: null,
      title: "Welcome to the Dashboard",
      body: "This is your main working surface — where you view, price, and manage all your marketplace listings in one place. Think of it as a master spreadsheet that stays synced with eBay, BigCommerce, and Shopify. For example, if you need to update a price on eBay TPP, you'd find the row here, change the price, review it, then push it out.",
    },
    {
      id: "dashboard-2",
      target: "dashboard-connection",
      title: "Connection Status",
      body: "This tells you if reorG is connected to the live database. If it says 'Connected' you're good — the data you see is real. If it shows an issue, stop and fix the connection before making any pricing decisions. Example: if it says 'Connection issue,' your data may be stale and you could accidentally push an old price.",
    },
    {
      id: "dashboard-3",
      target: "dashboard-health-banner",
      title: "Store Health Banner",
      body: "When this colored banner appears, it means one or more stores are behind on their data updates. Yellow means a store is a little late, red means it needs immediate attention. It also gives you a direct link to the Sync or Errors page so you can fix it quickly. Example: 'eBay TPP is running behind — last pull was 45 minutes ago.'",
    },
    {
      id: "dashboard-4",
      target: "dashboard-search",
      title: "Search Bar",
      body: "Type any SKU, title, UPC, or marketplace item ID to jump straight to the row you need. This is the fastest way to find a specific product. Example: type 'BB34' and it instantly filters to your BB34_WIFI_GANG products, or paste an eBay item ID like '204515443944' to land right on that listing.",
    },
    {
      id: "dashboard-5",
      target: "dashboard-filters",
      title: "Filters",
      body: "Narrow down which rows you see by store, stock status, staged changes, or missing data. Use these to focus on one type of work at a time. Example: select 'Staged Only' to see just the rows you've edited but haven't pushed yet, or filter by 'Out of Stock' to see what needs restocking.",
    },
    {
      id: "dashboard-6",
      target: "dashboard-toolbar",
      title: "Toolbar",
      body: "The toolbar holds your bulk operations and view controls. Row count shows how many listings match your current filters, and the tools let you do bulk UPC matching, global price updates, manage staged changes, control visible columns, and export data to Excel.",
    },
    {
      id: "dashboard-7",
      target: "dashboard-global-price",
      title: "Global Price Update",
      body: "Use this button when you want to apply a pricing rule across many rows at once. It's designed for batch pricing campaigns — for example, raising all prices by 10% or setting a minimum price across a category. Changes are staged first so you can review before pushing.",
    },
    {
      id: "dashboard-8",
      target: "dashboard-staged-tools",
      title: "Staged Changes Tools",
      body: "This area helps you manage your in-progress work. You can review failed pushes, see what's still staged (waiting to be sent to marketplaces), and clear staged values if you want to discard them. Example: after a push fails for 3 items, this area shows '3 failed' so you can investigate and retry.",
    },
    {
      id: "dashboard-9",
      target: "dashboard-columns-export",
      title: "Columns & Export",
      body: "Columns lets you show or hide specific data columns to focus on what matters. Export creates an Excel spreadsheet of everything you currently see — great for offline review or sharing with your team. Example: hide the 'Ad Rate' column when you're just doing pricing, or export the full sheet before a bulk update as a backup.",
    },
    {
      id: "dashboard-10",
      target: "dashboard-grid",
      title: "The Data Grid",
      body: "Each row represents one SKU family across all your stores. The left side stays frozen (always visible) showing the product identity. The right side scrolls to show store-specific values like price, quantity, and profit. For variation items (like phone cases with multiple colors), you'll see a parent row you can expand to reveal each variant underneath.",
    },
    {
      id: "dashboard-11",
      target: "dashboard-header-frozen",
      title: "Frozen Identity Columns",
      body: "These columns — product image, UPC, item IDs, SKU, and title — stay locked on the left side no matter how far you scroll right. This way you always know which product you're looking at while editing prices or fees. Example: scroll right to adjust Shopify prices and you can still see the SKU and title on the left.",
    },
    {
      id: "dashboard-12",
      target: "dashboard-header-expand",
      title: "Expand Variations",
      body: "For products that have multiple variants (like sizes or colors), click the expand arrow to see each variant as its own row underneath the parent. The parent row shows the main listing image, and each child row shows its variant-specific photo. Example: a phone case listing with 5 color options expands into 5 child rows, each with its own SKU, price, and stock level.",
    },
    {
      id: "dashboard-13",
      target: "dashboard-header-qty",
      title: "Live Quantity",
      body: "This column shows the current inventory count for each SKU. It pulls directly from your master store (eBay TPP by default). Click the column header to sort by quantity — useful to quickly spot items that are running low or out of stock. Example: sort ascending to see all your 0-stock items at the top.",
    },
    {
      id: "dashboard-14",
      target: "dashboard-header-sale-price",
      title: "Sale Price",
      body: "This is the main column you'll edit for pricing. Each store shows its own block. When you type a new price, it turns into a 'staged change' shown in purple — meaning it's saved in reorG but NOT yet sent to the marketplace. You choose when to push it. Example: change eBay TPP from $29.99 to $34.99, the old price shows small underneath while the new staged price displays prominently.",
    },
    {
      id: "dashboard-15",
      target: "dashboard-header-platform-fees",
      title: "Platform Fees",
      body: "Shows the marketplace fee percentage used in profit calculation. Default is 13.6% for eBay. BigCommerce and Shopify are 0% in this version. You can edit fees per row or in bulk if your rates change. Example: if eBay charges you 13.6% on a $50 item, that's $6.80 in fees.",
    },
    {
      id: "dashboard-16",
      target: "dashboard-header-ad-rate",
      title: "Promoted Ad Rate",
      body: "The advertising cost percentage for promoted listings. This factors into profit calculations alongside platform fees. Example: if your eBay promoted listing rate is 5% on a $50 item, that's an extra $2.50 cost that reduces your profit.",
    },
    {
      id: "dashboard-17",
      target: "dashboard-header-profit",
      title: "Profit",
      body: "The final profit number after all costs: sale price minus supplier cost, shipping, platform fees, and ad rate. Always check this column after changing prices or fees to make sure the row is still profitable. Example: if profit shows $3.20 after a price cut, you know the margin is tight and might want to reconsider.",
    },
  ],

  /* ================================================================
   * INVENTORY FORECASTER
   * ================================================================ */
  inventoryForecaster: [
    {
      id: "inventory-1",
      target: null,
      title: "Welcome to the Inventory Forecaster",
      body: "This tool helps you figure out what to reorder and how much. It looks at your sales history across all stores, compares it to what's currently in stock, and tells you exactly how many units of each SKU to order. For example, if you sell 10 units of BB34 per week and you have 15 in stock with a 5-week shipping time, it knows you need to order more now.",
    },
    {
      id: "inventory-2",
      target: "inventory-forecaster-controls",
      title: "Forecast Controls",
      body: "This is where you configure your forecast before running it. Set your parameters here and hit 'Run Forecast' when ready.",
    },
    {
      id: "inventory-3",
      target: "inventory-forecaster-controls",
      title: "Simple vs Smart Forecast",
      body: "Choose your forecast type at the top. Simple Forecast does straightforward math: (average sold per day × days needed) minus what's on hand. Smart Forecast uses advanced models that account for trends and seasonality, plus adds a safety buffer. Example: Simple might say order 10, Smart might say order 15 because it detected your sales are trending up this month.",
    },
    {
      id: "inventory-4",
      target: "inventory-forecaster-controls",
      title: "Sales Data Source",
      body: "Choose where sales data comes from. 'Live API' pulls directly from your connected stores (eBay, BigCommerce, Shopify). 'Upload Report' lets you upload an Excel sales report — useful if you have historical data or want to use a specific date range. Note: Smart Forecast requires Live API data; it's disabled when using uploads.",
    },
    {
      id: "inventory-5",
      target: "inventory-forecaster-controls",
      title: "Sales History & Timing",
      body: "Sales History sets how far back to look (90, 180, or 365 days). Shipping Time is how long it takes your supplier to deliver. Stock Coverage Goal is how many days of inventory you want after the shipment arrives. Example: with 90-day history, 37 days shipping, and 100 days coverage, the system calculates enough stock to last 137 days from when you order.",
    },
    {
      id: "inventory-6",
      target: "inventory-forecaster-controls",
      title: "Advanced Options",
      body: "'Subtract orders already on the way' deducts any supplier orders you've already placed, so you don't double-order. 'Only show SKUs that need attention' hides items that already have plenty of stock. Example: if you already ordered 50 units of SKU BB34, the forecaster subtracts those 50 from the suggested quantity.",
    },
    {
      id: "inventory-7",
      target: "inventory-forecaster-stats",
      title: "Headline Stats",
      body: "After running a forecast, these three cards give you the big picture at a glance. Reorder SKUs = how many products need restocking. Units Suggested = total units to order across all SKUs. Stockout Warnings = items at risk of running out before the new stock arrives. Example: '23 Reorder SKUs, 450 Units, 5 Stockout Warnings.'",
    },
    {
      id: "inventory-8",
      target: "inventory-forecaster-summary",
      title: "Overview Panel",
      body: "This panel shows where your data came from, how much history was available per store, and any warnings. The Sales Data Coverage section is especially important — it shows exactly how many days of sales data each store provided. If a store shows 'No data' in red, that store's sales aren't being counted and you should investigate.",
    },
    {
      id: "inventory-9",
      target: "inventory-forecaster-results",
      title: "Forecast Results Table",
      body: "Each row is one SKU with a full breakdown: what's in stock, what sold recently, what's needed for shipping time and coverage, any safety buffer, inbound orders, and the final 'Order Qty.' You can override any quantity — just type a new number in the Override column and the Order Qty updates instantly.",
    },
    {
      id: "inventory-10",
      target: "inventory-forecaster-actions",
      title: "Actions: Save, Order & Export",
      body: "Three actions for your forecast results. 'Save Run' stores this forecast for reference. 'Create Order' turns the forecast into a supplier order record inside reorG (it does NOT automatically order from a supplier). 'Export Excel' downloads a detailed workbook with product images, UPC barcodes, and all the math — perfect for sending to your supplier.",
    },
    {
      id: "inventory-11",
      target: "inventory-forecaster-orders",
      title: "Recent Supplier Orders",
      body: "Orders you've created from previous forecasts appear here. You can update the status (Ordered, In Transit, Received), set expected arrival dates, and add notes. Items marked as 'In Transit' are automatically subtracted from future forecasts so you don't reorder the same thing. Example: if you ordered 100 units of BB34 last week, the next forecast shows 100 fewer units needed.",
    },
  ],

  /* ================================================================
   * SYNC
   * ================================================================ */
  sync: [
    {
      id: "sync-1",
      target: "sync-header",
      title: "Welcome to the Sync Page",
      body: "This page pulls the latest data FROM your marketplaces INTO reorG. It's strictly pull-only — nothing you do here will change your actual listings on eBay, BigCommerce, or Shopify. Think of it as hitting 'refresh' to get the newest prices, quantities, and listing details from your stores.",
    },
    {
      id: "sync-2",
      target: "sync-auto-badge",
      title: "Auto-Sync Status",
      body: "This badge tells you whether automatic syncing is turned on. When it shows green with 'Auto-sync on,' reorG is periodically pulling fresh data from all your stores in the background — you don't have to do anything. If it's off, you'd need to manually sync each store. Example: with auto-sync on, eBay data refreshes every few minutes automatically.",
    },
    {
      id: "sync-3",
      target: "sync-actions",
      title: "Sync All Button",
      body: "Click 'Sync All' to trigger a quick sync on every connected store at once. This is useful after outages, when you first log in for the day, or when you want all stores refreshed before running an inventory forecast. Each store uses its preferred sync mode (incremental for fast updates, or full if needed).",
    },
    {
      id: "sync-4",
      target: "sync-stores",
      title: "Store Cards",
      body: "Each card represents one of your connected marketplaces. You can see its connection status (Live/Offline), health status (Healthy/Delayed/Attention), and the key stats for that store. The cards are your control center for managing individual store syncs. Example: eBay TPP's card shows when it last synced, how many items were processed, and when the next auto-pull is scheduled.",
    },
    {
      id: "sync-5",
      target: "sync-store-stats",
      title: "Next Pull & Last Sync",
      body: "Each store card shows two key stats. 'Next Pull' is a countdown to the next automatic sync — so you know when fresh data is coming. 'Last Sync' shows when data was last pulled and how many items were processed. Example: 'Next Pull: 8m' means new data arrives in about 8 minutes. 'Last Sync: 3m ago — 787 items' means 787 listings were refreshed 3 minutes ago.",
    },
    {
      id: "sync-6",
      target: "sync-ebay-quota",
      title: "eBay API Credits",
      body: "eBay limits how many API calls you can make per day (5,000 per method). These progress bars show how many credits you've used today. The bars reset around 3:00 AM EDT each day. Key methods: GetSellerList (used by Sync), GetItem (used by Full Sync for variation items), GetSellerEvents (used for change detection). Example: 'GetItem: 37 / 5,000' means you've used 37 credits today with 4,963 remaining.",
    },
    {
      id: "sync-7",
      target: "sync-store-actions",
      title: "Sync vs Full Sync",
      body: "Each store has two sync options. 'Sync' (incremental) is fast — it only pulls listings that changed since the last update. Use this for routine refreshes. 'Full Sync' re-downloads every listing from scratch — it's slower and uses more API credits, but it's the right choice when data looks out of date or after major store changes. Example: daily routine = use Sync. Seeing missing products or wrong photos = use Full Sync.",
    },
    {
      id: "sync-8",
      target: "sync-live-progress",
      title: "Live Sync Progress",
      body: "When a sync is running, you'll see real-time progress: how many items have been processed, created, and updated, plus the sync speed (items per minute) and elapsed time. The numbers update live as the sync works through your listings. Example: watching it climb from '50 processed' to '200 processed' to '787 processed — Done' gives you confidence the sync is working correctly.",
    },
    {
      id: "sync-9",
      target: "sync-stores",
      title: "Health Alerts & Issues",
      body: "If a store has problems, you'll see yellow or red alerts on its card with specific details and recommended actions. Issues might include listings removed by the marketplace, API quota limits reached, or sync timeouts. You can expand error details to see exactly which listings had problems. Example: 'GetItem failed for 204515443944: This listing was removed for violating policy' — this tells you exactly which listing and why.",
    },
    {
      id: "sync-10",
      target: "sync-stores",
      title: "Tips for Smooth Syncing",
      body: "For daily use, 'Sync' (incremental) is all you need — it's fast and efficient. Save 'Full Sync' for when data seems off or after large catalog changes. Before running the Inventory Forecaster, do a quick 'Sync All' to make sure all your data is fresh. If a sync seems stuck, check the eBay API credits — you might be at the daily limit and need to wait until the 3 AM reset.",
    },
  ],

  /* ================================================================
   * INTEGRATIONS
   * ================================================================ */
  integrations: [
    {
      id: "integrations-1",
      target: "integrations-header",
      title: "Welcome to Integrations",
      body: "This is where you manage your marketplace connections — credentials, API tokens, and write safety controls. Think of it as the wiring panel that connects reorG to eBay, BigCommerce, and Shopify. If a store isn't syncing or pushing correctly, this is the first place to check.",
    },
    {
      id: "integrations-2",
      target: "integrations-header",
      title: "Connection Overview",
      body: "The connection count at the top tells you how many stores are connected. If you have 4 stores set up but only 3 show connected, you know one needs attention. Example: '4 of 4 connected' means everything is wired up and working. '3 of 4 connected' means one store needs its credentials fixed.",
    },
    {
      id: "integrations-3",
      target: "integrations-global-lock",
      title: "Write Locks Explained",
      body: "Write locks prevent reorG from pushing changes to your stores. There are two types: per-store locks (controlled here on each card) and a global lock (controlled in Settings). Per-store locks let you freeze one store while still pushing to others. Example: lock BigCommerce writes while you fix a pricing issue there, but keep eBay writes enabled so you can still push price updates to eBay.",
    },
    {
      id: "integrations-4",
      target: "integrations-cards",
      title: "Store Cards",
      body: "Each card shows one marketplace: its name, platform, connection status, API credentials, and write-lock toggle. Use 'Test Connection' to verify credentials are working. If a token expires, you'll see a warning here with steps to reconnect. Example: if eBay shows 'Token expired,' click the card to refresh your API token.",
    },
    {
      id: "integrations-5",
      target: "integrations-cards",
      title: "Write Safety Controls",
      body: "Each store card has controls for enabling/disabling writes. 'Enabled' means the store is active in reorG. 'Write Lock' prevents any pushes to that specific store. Always double-check write locks before doing bulk price pushes. Example: before a big pricing campaign, unlock the target stores and verify each one shows 'Writes enabled.'",
    },
    {
      id: "integrations-6",
      target: "integrations-cards",
      title: "Master Store",
      body: "One store is marked as the 'Master Store' (eBay TPP by default). This is the source of truth for SKU matching and row identity. All other stores link to the master store via matching SKUs. Changing the master store is a major operation — don't do it casually. Example: a listing on Shopify with SKU 'BB34_WIFI_GANG_1' connects to the eBay TPP listing with the same SKU.",
    },
  ],

  /* ================================================================
   * ENGINE ROOM
   * ================================================================ */
  engineRoom: [
    {
      id: "engine-1",
      target: "engine-header",
      title: "Welcome to Engine Room",
      body: "Engine Room is your behind-the-scenes operations center. It shows what's happening inside reorG: sync jobs, push history, errors, scheduler activity, and audit logs. Come here when you need to understand what happened, when, and why. Example: 'Why did my price push fail yesterday at 3 PM?' — Engine Room has the answer.",
    },
    {
      id: "engine-2",
      target: "engine-summary",
      title: "Summary Cards",
      body: "These cards give you a quick health check at a glance: how many syncs are currently running, whether pushes are queued, recent failure count, overall store health status, and whether the write lock is on. Example: if 'Open Failures' shows 5, you know there are 5 recent issues to investigate.",
    },
    {
      id: "engine-3",
      target: "engine-active-syncs",
      title: "Active Syncs",
      body: "Shows whether any sync jobs are currently running. If you just triggered a sync and this shows '1 active,' that's expected. If it shows active syncs when you haven't triggered anything, auto-sync is doing its job in the background. Example: '0 active' after a busy period means all syncs completed successfully.",
    },
    {
      id: "engine-4",
      target: "engine-recent-errors",
      title: "Queued Pushes & Failures",
      body: "This card shows recent operational failures — even if the dashboard looks healthy right now. A non-zero number here means something went wrong recently and may need attention. Use this as an early warning system. Example: '3 failures in the last hour' suggests a pattern worth investigating, even if the latest sync looks fine.",
    },
    {
      id: "engine-5",
      target: "engine-write-lock",
      title: "Write Lock Status",
      body: "Shows whether the global write lock is ON (no pushes allowed) or OFF (pushes can proceed). Pulls and diagnostics always work regardless of this lock. Before any pricing push, verify this shows the state you expect. Example: if you're trying to push prices but nothing is going through, check here — the write lock might be on.",
    },
    {
      id: "engine-6",
      target: "engine-scheduler",
      title: "Scheduler Health",
      body: "The scheduler runs automatic syncs on a schedule. This card shows whether it's enabled, when it last ran, which stores were checked, and whether any stores are overdue. If a store shows 'Delayed' or 'Needs Attention,' the scheduler is having trouble keeping that store up to date. Example: 'Last tick: 2m ago, 4/4 stores healthy' means everything is running on time.",
    },
    {
      id: "engine-7",
      target: "engine-tabs",
      title: "Detail Tabs",
      body: "Switch between different views of your operational history. 'Sync Jobs' shows inbound pull history. 'Push Jobs' and 'Queue' show outbound marketplace updates. 'Change Log' tracks who edited what. 'Raw Events' has low-level traces for deep debugging. Example: if a price push failed, switch to 'Push Jobs' tab to see the exact error message.",
    },
    {
      id: "engine-8",
      target: "engine-table",
      title: "Detailed Records",
      body: "Each tab shows a table with timestamps, statuses, item counts, and action details. Use this evidence to diagnose issues or verify that operations completed correctly. Example: click a sync job row to see it processed 787 items, created 0 new ones, and updated 512 — confirming the sync worked as expected.",
    },
  ],

  /* ================================================================
   * ERRORS
   * ================================================================ */
  errors: [
    {
      id: "errors-1",
      target: "errors-header",
      title: "Welcome to Errors",
      body: "This page collects and groups all operational issues into plain-language summaries. Instead of reading raw error logs, you get clear descriptions of what went wrong and what to do about it. Example: instead of a cryptic '503 Service Unavailable,' you see 'eBay's reporting service is temporarily down — syncs still work, credits will reappear soon.'",
    },
    {
      id: "errors-2",
      target: "errors-filters",
      title: "Filter Your Errors",
      body: "Narrow errors by category (sync issues, push failures, etc.), severity (critical vs. warning), store, and time range. This keeps you focused on the issue you're investigating. Example: filter to 'eBay TPP' and 'Last 24 hours' to see only recent eBay problems without noise from older resolved issues.",
    },
    {
      id: "errors-3",
      target: "errors-list",
      title: "Grouped Error Cards",
      body: "Errors are grouped by problem type so you can clear one category at a time. Each card shows how many items are affected and when it first appeared. Example: 'Listing policy violations (3 items)' groups all eBay policy removal errors into one card instead of showing 3 separate entries.",
    },
    {
      id: "errors-4",
      target: "errors-list",
      title: "Recommended Actions",
      body: "Each error card includes a recommended next step — whether to go to Sync, Integrations, or Engine Room. Follow the suggestion first before guessing. Example: 'Token expired — go to Integrations to refresh your eBay credentials' takes you directly to the fix.",
    },
    {
      id: "errors-5",
      target: "errors-list",
      title: "Dismissing Errors",
      body: "You can dismiss errors to clear the list, but this only hides the symptom. If the root cause is still there, the error will come back on the next sync or push. Only dismiss after you've actually resolved the issue. Example: dismiss a 'listing removed' error only after you've confirmed the listing was intentionally removed from eBay.",
    },
  ],

  /* ================================================================
   * UNMATCHED
   * ================================================================ */
  unmatched: [
    {
      id: "unmatched-1",
      target: "unmatched-header",
      title: "Welcome to Unmatched Listings",
      body: "These are marketplace listings that reorG couldn't automatically connect to a master SKU. They stay here until you manually link or ignore them — they don't appear on the main dashboard. Example: if BigCommerce has a listing with SKU 'BC-WIDGET-1' but eBay TPP has no matching SKU, it shows up here.",
    },
    {
      id: "unmatched-2",
      target: "unmatched-filters",
      title: "Filter & Search",
      body: "Filter by store or search by SKU/title to work through unmatched listings in organized batches. Example: filter to 'Shopify' to handle all Shopify-specific unmatched listings at once, then switch to 'BigCommerce.'",
    },
    {
      id: "unmatched-3",
      target: "unmatched-list",
      title: "Manual Linking",
      body: "For each unmatched listing, you can type a master SKU to link it. If the SKU exists on the master store, the listing joins that row on the dashboard. If the SKU doesn't exist yet, reorG creates a new row for it. When multiple rows share the same SKU, you'll see a dropdown to pick which row to link to. Example: link BigCommerce SKU 'AB107_12V_2A_A' to the matching eBay TPP SKU and it appears in the correct dashboard row.",
    },
    {
      id: "unmatched-4",
      target: "unmatched-list",
      title: "Ignore vs Link",
      body: "Use 'Ignore' only for test listings, discontinued products, or items you intentionally don't want in reorG. Don't use ignore as a shortcut when the listing actually needs to be matched — that just hides a problem. Example: ignore a 'Test Listing 123' from Shopify that was created for testing, but always link real products.",
    },
    {
      id: "unmatched-5",
      target: "unmatched-list",
      title: "Verify After Linking",
      body: "After you link a listing, it should disappear from this page and appear on the dashboard under the correct SKU family. Go check the dashboard to confirm the row looks right — correct store data, prices, and quantities. Example: after linking, search for the SKU on the dashboard and verify all 4 stores show their data correctly.",
    },
  ],

  /* ================================================================
   * IMPORT
   * ================================================================ */
  import: [
    {
      id: "import-1",
      target: "import-header",
      title: "Welcome to Import",
      body: "Use this page to bulk-update reorG's internal fields (like supplier cost, shipping weight, and other workbook-driven data) from a spreadsheet. This updates data inside reorG only — it never changes anything on your actual marketplaces. Example: upload a spreadsheet with updated supplier costs for 200 SKUs to update them all at once instead of editing one by one.",
    },
    {
      id: "import-2",
      target: "import-steps",
      title: "Follow the Steps",
      body: "The import wizard guides you through a safe sequence: download a template, fill in your data, upload the file, preview what will change, choose how to apply it, confirm, then review the results. Don't skip the preview step — it catches problems before they happen. Example: the preview might show '5 rows with unknown SKUs' so you can fix the file before applying.",
    },
    {
      id: "import-3",
      target: "import-result",
      title: "Preview Before Applying",
      body: "The preview shows exactly what will change: which rows will be updated, what the old and new values are, and any problems like missing SKUs or bad data. Fix issues in your spreadsheet and re-upload rather than trying to correct mistakes after the fact. Example: if the preview shows 'Supplier cost $0.00 for 10 rows,' that's probably a mistake in your file.",
    },
    {
      id: "import-4",
      target: "import-result",
      title: "Fill Blanks vs Overwrite",
      body: "'Fill Blanks' only fills in empty fields — it won't replace data that already exists. This is safer for initial setup or enrichment. 'Overwrite' replaces whatever is stored with your new values — use this when you intentionally have corrected data. Example: use Fill Blanks when adding supplier costs for the first time. Use Overwrite when your supplier raised prices and you need to update all costs.",
    },
    {
      id: "import-5",
      target: "import-result",
      title: "Review Results",
      body: "After the import completes, check the created/updated counts and note any row-level failures. Then go to the dashboard and spot-check a few affected rows to confirm the data looks correct. Example: 'Updated 195 rows, 5 failed (unknown SKU)' — verify those 5 SKUs exist in your store and fix them.",
    },
  ],

  /* ================================================================
   * SHIPPING RATES
   * ================================================================ */
  shippingRates: [
    {
      id: "shipping-1",
      target: "shipping-header",
      title: "Welcome to Shipping Rates",
      body: "These shipping rate tiers directly affect your dashboard's shipping cost and profit calculations. Every row on the dashboard looks up its weight here to determine shipping cost. A wrong rate here silently distorts profit on every product that uses it. Example: if the '2LBS' tier is set to $8.50 but your actual shipping cost is $10.50, every 2lb product shows $2 more profit than it should.",
    },
    {
      id: "shipping-2",
      target: "shipping-table",
      title: "The Rate Table",
      body: "Each row is a weight tier with the shipping cost for that weight. Weight formats: '1' through '16' means ounces, '2LBS' through '10LBS' means pounds. Only update the tiers that changed — don't retype everything. Example: if your carrier raised the 5oz rate from $4.50 to $5.00, just update that one row.",
    },
    {
      id: "shipping-3",
      target: "shipping-save",
      title: "Save & Verify",
      body: "After saving your changes, go to the dashboard and spot-check a few products at different weights (light, medium, heavy) to make sure profit still calculates correctly. Example: check a 3oz item, a 1LBS item, and a 5LBS item to confirm shipping costs look right across the range.",
    },
  ],

  /* ================================================================
   * BACKUPS
   * ================================================================ */
  backups: [
    {
      id: "backups-1",
      target: "backups-header",
      title: "Welcome to Backups",
      body: "Backups save a snapshot of your reorG data at a point in time. They protect you before risky operations like bulk imports or large price pushes. If something goes wrong, you have a record of what everything looked like before the change. Example: before pushing new prices to all 4 stores, a backup captures the current state so you can compare if anything looks off.",
    },
    {
      id: "backups-2",
      target: "backups-actions",
      title: "Create a Backup",
      body: "Click 'Run Backup' to create a manual snapshot right now. Do this before any major operation: bulk price changes, large imports, or store configuration changes. Automatic backups happen on a schedule, but manual backups give you a specific restore point you control. Example: about to update 500 prices? Click 'Run Backup' first so you have a safety net.",
    },
    {
      id: "backups-3",
      target: "backups-list",
      title: "Backup History",
      body: "This list shows all your backups with status, size, coverage, and when they expire. Check that your most recent backup is 'Complete' before proceeding with risky operations. Backups are download-only in this version — you can export them as JSON or Excel for offline review. Example: verify the backup from 10 minutes ago shows 'Complete' and covers all 4 stores before starting a bulk push.",
    },
    {
      id: "backups-4",
      target: "backups-list",
      title: "Download for Review",
      body: "Download backups as JSON (for data recovery) or Excel (for human-readable review). These are useful for auditing what changed, investigating issues, or keeping an offline record. Example: download last week's backup as Excel to compare prices before and after your recent pricing campaign.",
    },
  ],

  /* ================================================================
   * SETUP
   * ================================================================ */
  setup: [
    {
      id: "setup-1",
      target: "setup-header",
      title: "Welcome to Setup",
      body: "This is your go-live readiness checklist. It tracks what's fully configured, what still needs work, and what might block operations. Think of it as a preflight checklist before you start pushing changes to your stores. Example: if the checklist shows 'Integrations: 3 of 4 connected,' you know one store still needs to be set up.",
    },
    {
      id: "setup-2",
      target: "setup-steps",
      title: "Status Indicators",
      body: "Each checklist item has a status: Complete (green), In Progress (yellow), or Needs Attention (red). Work through 'Needs Attention' items first — they may block important features. Example: 'Shipping rates: Needs Attention' means your profit calculations might be wrong until you configure the rate table.",
    },
    {
      id: "setup-3",
      target: "setup-steps",
      title: "Use as a Release Gate",
      body: "Before doing imports, large pushes, or handing off to a team member, scan this checklist. It's the quickest way to catch problems with connectivity, safety settings, or data quality. Example: before your first big price push, make sure every item is green — that means all stores are connected, write locks are configured, and data is flowing.",
    },
    {
      id: "setup-4",
      target: "setup-steps",
      title: "Revisit After Changes",
      body: "This isn't just for initial setup. Come back after major changes — reconnecting a store, updating credentials, changing the master store — to verify everything is still in good shape. Example: after rotating your eBay API token, check this page to confirm the connection still shows 'Complete.'",
    },
  ],

  /* ================================================================
   * USERS
   * ================================================================ */
  users: [
    {
      id: "users-1",
      target: "users-header",
      title: "Welcome to Users",
      body: "This page controls who can access reorG and what level of access they have. Since reorG manages real marketplace operations and pricing, keeping this up to date is important for security and accountability.",
    },
    {
      id: "users-2",
      target: "users-profile",
      title: "Your Profile",
      body: "Update your own name, email, and password here. Keep your credentials current since this account controls real marketplace operations. Example: if you change your email address, update it here so password resets and notifications go to the right place.",
    },
    {
      id: "users-3",
      target: "users-manage",
      title: "Manage Team Access",
      body: "Admins can create new user accounts, assign roles, and review who has access. Each user gets their own login so you can track who made what changes. Example: add a new team member as an Operator so they can view and edit the dashboard but can't change integration settings or write locks.",
    },
    {
      id: "users-4",
      target: "users-manage",
      title: "Audit Trail",
      body: "The user list and recent activity help you answer 'who changed what and when?' during incident review or team handoffs. Example: if a price looks wrong, you can check which user last edited that row and when they did it.",
    },
  ],

  /* ================================================================
   * SETTINGS
   * ================================================================ */
  settings: [
    {
      id: "settings-1",
      target: "settings-header",
      title: "Welcome to Settings",
      body: "Settings has two sections: personal display preferences (affects only your view) and global safety controls (affects the entire app for all users). Be careful with the safety section — changes there impact whether anyone can push to marketplaces.",
    },
    {
      id: "settings-2",
      target: "settings-display",
      title: "Display Preferences",
      body: "Customize how reorG looks for you. Theme switches between dark and light mode. Density controls row spacing. Frozen columns sets which columns stay visible when scrolling. Row text size makes data easier to read. These only change your personal view — they don't affect other users or business data. Example: switch to 'Compact' density to see more rows at once, or increase text size for easier reading.",
    },
    {
      id: "settings-3",
      target: "settings-safety",
      title: "Global Safety Controls",
      body: "The global write lock is the master switch for all marketplace pushes. When ON, no price or data changes can be pushed to any store, regardless of per-store lock settings. Use this as an emergency stop or during maintenance. Example: turn the global lock ON before doing major system updates, then turn it OFF when you're ready to resume normal operations.",
    },
    {
      id: "settings-4",
      target: "settings-tour",
      title: "Tour & Help",
      body: "Replay guided tours for any page to refresh your memory on features. You can also reset tours so they show up again as if you're seeing them for the first time. This is useful after major updates or when onboarding a new team member. Example: click 'Replay Dashboard Tour' to walk through all the dashboard features again with step-by-step explanations.",
    },
    {
      id: "settings-5",
      target: "settings-tour",
      title: "Tours Are Your Documentation",
      body: "The page tours aren't just for onboarding — they're a living reference guide for every feature. Whenever you're unsure how something works, click the 'Tour' button in the top bar on any page to get a walkthrough with examples. Example: forgot how the Inventory Forecaster's Simple vs Smart mode works? Start the tour on that page for a refresher.",
    },
  ],
};
