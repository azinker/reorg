/**
 * Single source of truth for the application's top-level pages.
 *
 * The sidebar and the user-permissions editor both consume this registry so
 * they can never drift apart: if you add a new page here, it shows up in the
 * sidebar AND in the per-user "Pages this user can see" editor automatically.
 *
 * Permission semantics
 * --------------------
 *  - role === "ADMIN"        → can see everything (this list is ignored).
 *  - pagePermissions === null → legacy / unset → user sees the operator default
 *                              (everything except admin-only items).
 *  - pagePermissions === []  → user sees only the always-allowed pages
 *                              (Dashboard, Settings, Users-as-self).
 *  - pagePermissions = [...] → user sees only the listed pages, plus the
 *                              always-allowed pages.
 *
 * Always-allowed pages are listed below with `alwaysAllow: true`. Those are
 * the bare minimum every user needs to be able to log in, see something, and
 * manage their own profile.
 */

export type PageKey =
  | "dashboard"
  | "catalog-health"
  | "inventory-forecaster"
  | "tasks"
  | "revenue"
  | "profit-center"
  | "payouts"
  | "sync"
  | "ship-orders"
  | "auto-responder"
  | "help-desk"
  | "integrations"
  | "engine-room"
  | "public-network-transfer"
  | "errors"
  | "unmatched"
  | "import"
  | "shipping-rates"
  | "backups"
  | "chrome-extension"
  | "users"
  | "settings";

export interface NavPage {
  key: PageKey;
  /** Path the link points at. Always rooted at "/". */
  href: string;
  /** Human label shown in the sidebar and the editor. */
  label: string;
  /** lucide-react icon name (looked up by sidebar). Kept as a string so this
   *  module is server-safe (no React imports). */
  icon:
    | "LayoutDashboard"
    | "Shield"
    | "Boxes"
    | "ClipboardList"
    | "ChartNoAxesCombined"
    | "DollarSign"
    | "Wallet"
    | "RefreshCw"
    | "PackageCheck"
    | "MessageSquareText"
    | "LifeBuoy"
    | "Plug"
    | "Gauge"
    | "Globe"
    | "AlertTriangle"
    | "Unlink"
    | "Upload"
    | "Weight"
    | "Database"
    | "Puzzle"
    | "Users"
    | "Settings";
  /** Hidden from non-admins regardless of pagePermissions. */
  adminOnly?: boolean;
  /** Always visible to every signed-in user. Cannot be revoked. */
  alwaysAllow?: boolean;
  /** Short tooltip describing what the page does (used in the editor). */
  description: string;
}

export const NAV_PAGES: NavPage[] = [
  {
    key: "dashboard",
    href: "/dashboard",
    label: "Dashboard",
    icon: "LayoutDashboard",
    alwaysAllow: true,
    description: "Home page after login. Always visible.",
  },
  {
    key: "catalog-health",
    href: "/catalog-health",
    label: "Catalog Health",
    icon: "Shield",
    description: "Listing scrubber — flags missing UPCs, weights, costs, etc.",
  },
  {
    key: "inventory-forecaster",
    href: "/inventory-forecaster",
    label: "Inventory Forecaster",
    icon: "Boxes",
    description: "Demand planning, low-stock alerts, supplier order suggestions.",
  },
  {
    key: "tasks",
    href: "/tasks",
    label: "Tasks",
    icon: "ClipboardList",
    description: "Internal task board (assignable to-dos for the team).",
  },
  {
    key: "revenue",
    href: "/revenue",
    label: "Revenue",
    icon: "ChartNoAxesCombined",
    description: "Sales totals across all marketplaces.",
  },
  {
    key: "profit-center",
    href: "/profit-center",
    label: "Profit Center",
    icon: "DollarSign",
    description: "Per-listing profit with cost / fee / shipping breakdown.",
  },
  {
    key: "payouts",
    href: "/payouts",
    label: "Payouts",
    icon: "Wallet",
    adminOnly: true,
    description: "eBay / BC / Shopify payout reconciliation. Admin only.",
  },
  {
    key: "sync",
    href: "/sync",
    label: "Sync",
    icon: "RefreshCw",
    description: "Pull-only marketplace sync controls and status.",
  },
  {
    key: "ship-orders",
    href: "/ship-orders",
    label: "Ship Orders",
    icon: "PackageCheck",
    description: "Order fulfillment queue.",
  },
  {
    key: "auto-responder",
    href: "/auto-responder",
    label: "Auto Responder",
    icon: "MessageSquareText",
    description: "Buyer-message auto-reply rules.",
  },
  {
    key: "help-desk",
    href: "/help-desk",
    label: "Help Desk",
    icon: "LifeBuoy",
    description:
      "Buyer-message inbox with tickets, threads, and reply composer.",
  },
  {
    key: "integrations",
    href: "/integrations",
    label: "Integrations",
    icon: "Plug",
    description: "Marketplace connections, tokens, write locks.",
  },
  {
    key: "engine-room",
    href: "/engine-room",
    label: "Engine Room",
    icon: "Gauge",
    description: "Ops control center — logs, push queue, audit trail.",
  },
  {
    key: "public-network-transfer",
    href: "/public-network-transfer",
    label: "Public Network Transfer",
    icon: "Globe",
    adminOnly: true,
    description: "Cross-store inventory transfer console. Admin only.",
  },
  {
    key: "errors",
    href: "/errors",
    label: "Errors",
    icon: "AlertTriangle",
    description: "Friendly error summaries and technical details.",
  },
  {
    key: "unmatched",
    href: "/unmatched",
    label: "Unmatched Listings",
    icon: "Unlink",
    description: "External listings without a matching master-store SKU.",
  },
  {
    key: "import",
    href: "/import",
    label: "Import",
    icon: "Upload",
    description: "Spreadsheet import wizard.",
  },
  {
    key: "shipping-rates",
    href: "/shipping-rates",
    label: "Shipping Rates",
    icon: "Weight",
    description: "Per-weight shipping cost table used by profit calculations.",
  },
  {
    key: "backups",
    href: "/backups",
    label: "Backups",
    icon: "Database",
    description: "Backup downloads and history. v1 is export-only.",
  },
  {
    key: "chrome-extension",
    href: "/chrome-extension",
    label: "Chrome Extension",
    icon: "Puzzle",
    description: "reorG browser extension downloads + setup.",
  },
  {
    key: "users",
    href: "/users",
    label: "Users",
    icon: "Users",
    alwaysAllow: true,
    description:
      "User profile (always visible — non-admins see only their own row).",
  },
  {
    key: "settings",
    href: "/settings",
    label: "Settings",
    icon: "Settings",
    alwaysAllow: true,
    description: "App preferences (theme, density, timezone). Always visible.",
  },
];

/** Quick lookup table: page key → page record. */
export const NAV_PAGES_BY_KEY: Record<PageKey, NavPage> = NAV_PAGES.reduce(
  (acc, p) => {
    acc[p.key] = p;
    return acc;
  },
  {} as Record<PageKey, NavPage>,
);

/** Pages every user always sees (cannot be revoked by an admin). */
export const ALWAYS_ALLOWED_PAGE_KEYS: PageKey[] = NAV_PAGES.filter(
  (p) => p.alwaysAllow,
).map((p) => p.key);

/** Pages that are admin-only (never shown to operators). */
export const ADMIN_ONLY_PAGE_KEYS: PageKey[] = NAV_PAGES.filter(
  (p) => p.adminOnly,
).map((p) => p.key);

/**
 * Resolve which pages a user can see, given their role + stored permissions.
 *
 *   - Admins: everything.
 *   - Operators with null permissions: everything except adminOnly pages
 *     (this is the legacy default — preserves current behavior for users
 *     created before the permissions feature shipped).
 *   - Operators with an array: only the listed pages, plus alwaysAllow pages,
 *     minus adminOnly pages (defensive — operators can never be granted
 *     adminOnly access through this mechanism).
 */
export function resolveAllowedPageKeys(input: {
  role: string;
  pagePermissions: string[] | null | undefined;
}): Set<PageKey> {
  if (input.role === "ADMIN") {
    return new Set(NAV_PAGES.map((p) => p.key));
  }

  if (input.pagePermissions == null) {
    return new Set(
      NAV_PAGES.filter((p) => !p.adminOnly).map((p) => p.key),
    );
  }

  const granted = new Set<PageKey>();
  for (const key of ALWAYS_ALLOWED_PAGE_KEYS) granted.add(key);
  for (const raw of input.pagePermissions) {
    const page = NAV_PAGES_BY_KEY[raw as PageKey];
    if (page && !page.adminOnly) granted.add(page.key);
  }
  return granted;
}

/** True if the given page key is a known nav page. */
export function isPageKey(value: unknown): value is PageKey {
  return typeof value === "string" && value in NAV_PAGES_BY_KEY;
}
