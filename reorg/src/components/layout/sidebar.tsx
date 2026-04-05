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
} from "lucide-react";
import { useEffect, useState } from "react";
import { usePageVisibility } from "@/lib/use-page-visibility";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/catalog-health", label: "Catalog Health", icon: Shield },
  { href: "/inventory-forecaster", label: "Inventory Forecaster", icon: Boxes },
  { href: "/tasks", label: "Tasks", icon: ClipboardList },
  { href: "/revenue", label: "Revenue", icon: ChartNoAxesCombined },
  { href: "/profit-center", label: "Profit Center", icon: DollarSign },
  { href: "/payouts", label: "Payouts", icon: Wallet },
  { href: "/sync", label: "Sync", icon: RefreshCw },
  { href: "/ship-orders", label: "Ship Orders", icon: PackageCheck },
  { href: "/integrations", label: "Integrations", icon: Plug },
  { href: "/engine-room", label: "Engine Room", icon: Gauge },
  { href: "/public-network-transfer", label: "Public Network Transfer", icon: Globe },
  { href: "/errors", label: "Errors", icon: AlertTriangle },
  { href: "/unmatched", label: "Unmatched Listings", icon: Unlink },
  { href: "/import", label: "Import", icon: Upload },
  { href: "/shipping-rates", label: "Shipping Rates", icon: Weight },
  { href: "/backups", label: "Backups", icon: Database },
  { href: "/chrome-extension", label: "Chrome Extension", icon: Puzzle },
  { href: "/users", label: "Users", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

interface SidebarProps {
  mobile?: boolean;
  onNavigate?: () => void;
  /** When set, admin-only nav items are hidden for non-admins. */
  userRole?: string | null;
}

export function Sidebar({ mobile = false, onNavigate, userRole }: SidebarProps) {
  const pathname = usePathname();
  const isPageVisible = usePageVisibility();
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

  useEffect(() => {
    let active = true;

    async function loadHealth() {
      try {
        const response = await fetch("/api/scheduler/status", { cache: "no-store" });
        if (!response.ok) return;
        const json = await response.json();
        if (!active) return;
        setHealthSummary(json.data?.healthSummary ?? null);
      } catch {
        if (active) setHealthSummary(null);
      }
    }

    void loadHealth();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadHealth();
    }, 300_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!isPageVisible) return;
    void (async () => {
      try {
        const response = await fetch("/api/scheduler/status", { cache: "no-store" });
        if (!response.ok) return;
        const json = await response.json();
        setHealthSummary(json.data?.healthSummary ?? null);
      } catch {
        setHealthSummary(null);
      }
    })();
  }, [isPageVisible]);

  const attentionCount =
    (healthSummary?.attentionCount ?? 0) + (healthSummary?.delayedCount ?? 0);
  const cooldownCount = healthSummary?.cooldownCount ?? 0;
  const syncIssueCount = attentionCount + cooldownCount;

  return (
    <aside
      className={cn(
        "flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-200",
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
          {navItems
            .filter(
              (item) =>
                (item.href !== "/public-network-transfer" && item.href !== "/payouts") ||
                userRole !== "OPERATOR",
            )
            .map((item) => {
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href));
            const Icon = item.icon;

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
