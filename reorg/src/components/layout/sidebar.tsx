"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Boxes,
  ClipboardList,
  DollarSign,
  ChartNoAxesCombined,
  RefreshCw,
  Plug,
  Gauge,
  AlertTriangle,
  Shield,
  Unlink,
  Upload,
  Weight,
  Database,
  Puzzle,
  Settings,
  Users,
  Globe,
  ChevronLeft,
  ChevronRight,
  X,
  PackageCheck,
  Wallet,
  MessageSquareText,
  LifeBuoy,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  NAV_PAGES,
  resolveAllowedPageKeys,
  type NavPage,
  type PageKey,
} from "@/lib/nav-pages";

/**
 * Sidebar icons live here (client-side) — the nav-pages registry stays
 * server-safe by only exporting icon names. Every key in NavPage["icon"]
 * MUST appear here or TypeScript will complain.
 */
const ICON_COMPONENTS: Record<NavPage["icon"], React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  Shield,
  Boxes,
  ClipboardList,
  ChartNoAxesCombined,
  DollarSign,
  Wallet,
  RefreshCw,
  PackageCheck,
  MessageSquareText,
  LifeBuoy,
  Plug,
  Gauge,
  Globe,
  AlertTriangle,
  Unlink,
  Upload,
  Weight,
  Database,
  Puzzle,
  Users,
  Settings,
};

interface SidebarProps {
  mobile?: boolean;
  onNavigate?: () => void;
  /** Used for admin-only fallback when allowedPageKeys isn't provided. */
  userRole?: string | null;
  /**
   * Page keys this user can see, computed server-side using
   * `resolveAllowedPageKeys`. NULL means "use the legacy default" (operator
   * sees everything except admin-only pages).
   */
  allowedPageKeys?: string[] | null;
}

export function Sidebar({
  mobile = false,
  onNavigate,
  userRole,
  allowedPageKeys,
}: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [healthSummary, setHealthSummary] = useState<{
    status: "healthy" | "delayed" | "attention";
    delayedCount: number;
    attentionCount: number;
    cooldownCount: number;
    missingWebhookCount: number;
    headline: string;
    detail: string;
    recommendedAction: string;
    affectedLabels: string[];
  } | null>(null);
  const actuallyCollapsed = mobile ? false : collapsed;

  /**
   * Resolve which nav items to show. We trust `allowedPageKeys` from the
   * server when provided; otherwise we fall back to the same legacy filter
   * used before the per-user permissions feature shipped.
   */
  const visibleItems = useMemo(() => {
    if (allowedPageKeys === undefined) {
      // Legacy fallback (no allowlist available) — preserves prior behavior.
      return NAV_PAGES.filter(
        (item) =>
          (item.key !== "public-network-transfer" && item.key !== "payouts") ||
          userRole !== "OPERATOR",
      );
    }

    const allowed = new Set(
      allowedPageKeys === null
        ? Array.from(
            resolveAllowedPageKeys({
              role: userRole ?? "OPERATOR",
              pagePermissions: null,
            }),
          )
        : (allowedPageKeys as PageKey[]),
    );
    return NAV_PAGES.filter((item) => allowed.has(item.key));
  }, [allowedPageKeys, userRole]);

  /**
   * Load the sync-issues badge counter from the lightweight
   * `/api/scheduler/health-summary` endpoint.
   *
   * Why not `/api/scheduler/status`?
   *   That route returns ~50 KB of data (recentJobs, recentWebhooks,
   *   automationEvents, integrationHealth, the full upcoming plan…) and
   *   takes 15-25 s on cold Vercel instances because it queries 5 000
   *   audit-log rows and hits the live eBay Trading API. The sidebar uses
   *   only `attentionCount`, `delayedCount`, and `cooldownCount`, so we
   *   pull the tiny summary instead — the response is a few hundred bytes
   *   and parses in a single millisecond.
   *
   * The two effects that used to live here (one on mount, one on every
   * `isPageVisible` flip) are coalesced into one. The previous setup
   * fired three simultaneous slow requests on every page mount AND
   * re-fired whenever the user tabbed back to the browser, which was a
   * major source of the help-desk page lag.
   */
  useEffect(() => {
    let active = true;
    const ac = new AbortController();
    let lastLoadedAt = 0;

    async function loadHealth() {
      try {
        const response = await fetch("/api/scheduler/health-summary", {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!response.ok) return;
        const json = await response.json();
        if (!active) return;
        // The new endpoint returns the summary directly under `data`.
        // Tolerate the legacy shape (`data.healthSummary`) too in case an
        // old service worker / CDN cache serves a stale response.
        setHealthSummary(json.data?.healthSummary ?? json.data ?? null);
        lastLoadedAt = Date.now();
      } catch {
        if (active && !ac.signal.aborted) setHealthSummary(null);
      }
    }

    void loadHealth();

    // Light polling — 5 min. We only refetch on visibility change if the
    // cached value is older than 5 min, so tabbing back to the app no
    // longer triggers an immediate refetch storm.
    const FIVE_MIN = 300_000;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadHealth();
    }, FIVE_MIN);

    function onVisibility() {
      if (
        document.visibilityState === "visible" &&
        Date.now() - lastLoadedAt > FIVE_MIN
      ) {
        void loadHealth();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      active = false;
      ac.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const attentionCount =
    (healthSummary?.attentionCount ?? 0) + (healthSummary?.delayedCount ?? 0);
  const cooldownCount = healthSummary?.cooldownCount ?? 0;
  const syncIssueCount = attentionCount + cooldownCount;

  return (
    <aside
      className={cn(
        "flex h-full flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200",
        actuallyCollapsed ? "w-16" : "w-60"
      )}
    >
      {/* Brand Area */}
      <div className={cn(
        "flex border-b border-sidebar-border",
        actuallyCollapsed ? "items-center justify-center px-2 py-3" : "items-start justify-between px-4 py-4"
      )}>
        {!actuallyCollapsed ? (
          <div className="flex flex-col">
            <span className="text-2xl tracking-tight text-foreground">
              <span className="font-light">reor</span>
              <span className="font-bold" style={{ color: "#C43E3E" }}>G</span>
            </span>
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              by The Perfect Part
            </span>
          </div>
        ) : (
          <span className="text-lg text-foreground">
            <span className="font-light">r</span>
            <span className="font-bold" style={{ color: "#C43E3E" }}>G</span>
          </span>
        )}
        {mobile && (
          <button
            onClick={onNavigate}
            className="ml-2 flex h-8 w-8 items-center justify-center rounded-md border border-sidebar-border bg-background text-muted-foreground hover:text-foreground cursor-pointer"
            title="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {/* Nav Items */}
      <nav className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-1">
          {visibleItems.map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            const Icon = ICON_COMPONENTS[item.icon];

            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                  )}
                  title={actuallyCollapsed ? item.label : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0 text-[#C43E3E]" />
                  {!actuallyCollapsed && <span>{item.label}</span>}
                  {!actuallyCollapsed &&
                    item.href === "/sync" &&
                    syncIssueCount > 0 && (
                      <span
                        className={cn(
                          "ml-auto inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                          attentionCount > 0
                            ? healthSummary?.status === "attention"
                              ? "bg-red-500/15 text-red-300"
                              : "bg-amber-500/15 text-amber-300"
                            : "bg-amber-500/15 text-amber-300",
                        )}
                      >
                        {syncIssueCount}
                      </span>
                    )}
                  {actuallyCollapsed &&
                    item.href === "/sync" &&
                    syncIssueCount > 0 && (
                      <span
                        className={cn(
                          "ml-auto h-2 w-2 rounded-full",
                          attentionCount > 0
                            ? healthSummary?.status === "attention"
                              ? "bg-red-400"
                              : "bg-amber-400"
                            : "bg-amber-400",
                        )}
                      />
                    )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Collapse Toggle */}
      {!mobile && (
        <div className="border-t border-sidebar-border p-2">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex w-full items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground cursor-pointer"
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <ChevronLeft className="h-4 w-4" />
            )}
          </button>
        </div>
      )}
    </aside>
  );
}
