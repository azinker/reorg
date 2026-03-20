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
    { id: "header", target: "sync-header", title: "Sync center", body: "This page controls pull syncs from each marketplace and shows health/history.\n\nExample: Run an incremental sync before morning order checks." },
    { id: "stores", target: "sync-stores", title: "Store cards", body: "Each store card shows connection state, last sync, and quick actions.\n\nExample: If one store is stale, run sync only for that integration." },
    { id: "jobs", target: "sync-jobs", title: "Recent sync jobs", body: "Inspect recent job outcomes, item counts, and errors.\n\nExample: Open failed job details to see which SKUs could not update." },
  ],
  integrations: [
    { id: "header", target: "integrations-header", title: "Integrations", body: "Connect and manage TPP, TT, BigCommerce, and Shopify credentials.\n\nExample: Reconnect Shopify after rotating API keys." },
    { id: "cards", target: "integrations-cards", title: "Store integration cards", body: "Each card includes connection test, enabled state, and write lock.\n\nExample: Lock writes on one store while troubleshooting." },
    { id: "write-lock", target: "integrations-global-lock", title: "Global vs per-store lock", body: "Global lock blocks all writes; card lock blocks only one integration.\n\nExample: Keep global lock off, lock just BigCommerce during maintenance." },
  ],
  engineRoom: [
    { id: "header", target: "engine-header", title: "Engine Room", body: "Operational telemetry for sync jobs, push jobs, automation, and raw events." },
    { id: "tabs", target: "engine-tabs", title: "Tabs", body: "Switch between Sync Jobs, Push Queue/Jobs, Change Log, and Raw Events.\n\nExample: Check Push Jobs after a bulk price update." },
    { id: "table", target: "engine-table", title: "Deep diagnostics", body: "Rows expose status, durations, failures, and retry data.\n\nExample: Verify if a job failed from auth, validation, or rate limits." },
  ],
  errors: [
    { id: "header", target: "errors-header", title: "Errors page", body: "Consolidated operational issues by severity and category." },
    { id: "filters", target: "errors-filters", title: "Error filters", body: "Filter by severity, store, cause, and time range to isolate incidents.\n\nExample: Show Critical + Last 24h to triage immediately." },
    { id: "list", target: "errors-list", title: "Error cards", body: "Each card includes summary, technical detail, recommended next action, and optional quick link." },
  ],
  unmatched: [
    { id: "header", target: "unmatched-header", title: "Unmatched Listings", body: "Marketplace listings that could not be linked to a master SKU." },
    { id: "filters", target: "unmatched-filters", title: "Store/search filters", body: "Filter by store and search by title, SKU, or item ID to process quickly." },
    { id: "actions", target: "unmatched-list", title: "Link or ignore", body: "Link listing to existing SKU or ignore when appropriate.\n\nExample: Link a new Shopify listing to an existing master SKU to restore profit calculations." },
  ],
  import: [
    { id: "header", target: "import-header", title: "Import workflow", body: "Use this step-by-step flow for template download, upload, validation, and apply." },
    { id: "steps", target: "import-steps", title: "Step progress", body: "Follow each step in order to prevent malformed imports.\n\nExample: Always preview first to catch invalid UPC/cost values." },
    { id: "result", target: "import-result", title: "Results", body: "After confirm, review created/updated counts and row-level errors for cleanup." },
  ],
  shippingRates: [
    { id: "header", target: "shipping-header", title: "Shipping rate table", body: "Weight-tier costs used in profit and shipping calculations." },
    { id: "table", target: "shipping-table", title: "Edit tiers", body: "Update costs by weight tier; blank means not configured.\n\nExample: Carrier increase on 2LBS tier? Update here once and dashboard math updates." },
    { id: "save", target: "shipping-save", title: "Save changes", body: "Save commits table edits for future calculations across the app." },
  ],
  backups: [
    { id: "header", target: "backups-header", title: "Backups", body: "Disaster-recovery backups: automated and manual runs." },
    { id: "actions", target: "backups-actions", title: "Run backup now", body: "Create a fresh backup before high-risk operations.\n\nExample: Run one before a large import or push batch." },
    { id: "list", target: "backups-list", title: "Backup history", body: "Review status, size, expiry, and download JSON/XLSX snapshots." },
  ],
  setup: [
    { id: "header", target: "setup-header", title: "Setup checklist", body: "Track onboarding completion across integrations, import, shipping, and safety controls." },
    { id: "steps", target: "setup-steps", title: "Checklist steps", body: "Each step shows Not Started, In Progress, Complete, or Needs Attention." },
    { id: "priority", target: "setup-priority", title: "What to fix next", body: "Use attention markers to prioritize blockers first.\n\nExample: Resolve missing credentials before enabling scheduler." },
  ],
  users: [
    { id: "header", target: "users-header", title: "Users & roles", body: "Manage profile, create users, assign roles, and review access activity." },
    { id: "profile", target: "users-profile", title: "My profile", body: "Update your display name/password used for sign-in." },
    { id: "manage", target: "users-manage", title: "User management", body: "Admins can add operators/admins and view access logs.\n\nExample: Create an operator account for warehouse pricing updates." },
  ],
  settings: [
    { id: "header", target: "settings-header", title: "Settings", body: "Central place for display preferences and safety controls." },
    { id: "display", target: "settings-display", title: "Display settings", body: "Tune theme, density, row sizing, and defaults to match your workflow." },
    { id: "safety", target: "settings-safety", title: "Safety controls", body: "Global write lock and live push settings protect production operations." },
    { id: "tour", target: "settings-tour", title: "Tour controls", body: "Replay a tour or reset tours so new users see onboarding again." },
  ],
};
