"use client";

import { useState, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useTheme } from "@/components/providers/theme-provider";
import { useSettings } from "@/lib/use-settings";
import { useDashboardConnection } from "@/contexts/dashboard-connection-context";
import { PlatformIcon } from "@/components/grid/platform-icon";
import type { Density } from "@/lib/settings-store";
import type { Platform } from "@/lib/grid-types";
import { PLATFORM_SHORT } from "@/lib/grid-types";
import { cn } from "@/lib/utils";
import { dispatchToggleDashboardTour } from "@/lib/onboarding-events";
import {
  Moon,
  Sun,
  Monitor,
  Rows3,
  Rows4,
  AlignJustify,
  Menu,
  LogOut,
  ShieldCheck,
  AlertTriangle,
  Sparkles,
} from "lucide-react";

const PLATFORM_ORDER: Platform[] = ["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"];

const DENSITY_OPTIONS: { value: Density; icon: typeof Rows3; label: string }[] = [
  { value: "compact", icon: Rows4, label: "Compact" },
  { value: "comfortable", icon: Rows3, label: "Comfortable" },
  { value: "spacious", icon: AlignJustify, label: "Spacious" },
];

interface TopBarProps {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  } | null;
  onOpenSidebar: () => void;
}

export function TopBar({ user, onOpenSidebar }: TopBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { settings, update } = useSettings();
  const { connectionInfo } = useDashboardConnection();
  const [mounted, setMounted] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [automationHealth, setAutomationHealth] = useState<{
    status: "healthy" | "delayed" | "attention";
    delayedCount: number;
    attentionCount: number;
    headline: string;
    detail: string;
    recommendedAction: string;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active = true;

    async function loadAutomationHealth() {
      try {
        const response = await fetch("/api/scheduler/status", { cache: "no-store" });
        if (!response.ok) return;
        const json = await response.json();
        if (!active) return;
        setAutomationHealth(json.data?.healthSummary ?? null);
      } catch {
        if (active) setAutomationHealth(null);
      }
    }

    void loadAutomationHealth();
    const timer = window.setInterval(() => {
      void loadAutomationHealth();
    }, 120_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const density = mounted ? settings.density : "comfortable";
  const themeValue = mounted ? theme : "system";

  const isConnected = connectionInfo?.source === "db";
  const isNotConnected = connectionInfo?.source === "mock";
  const summary = connectionInfo?.summary ?? null;
  const hasTooltip = isConnected && summary != null;
  const attentionCount =
    (automationHealth?.attentionCount ?? 0) + (automationHealth?.delayedCount ?? 0);

  const titleText =
    connectionInfo == null
      ? "Marketplace Operations"
      : isConnected
        ? "Marketplace Operations - Connected to Database"
        : "Marketplace Operations - Not Connected";

  return (
    <header className="flex h-14 min-w-0 items-center justify-between gap-2 overflow-x-auto overflow-y-hidden border-b border-border bg-card px-4 sm:px-6">
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        <button
          onClick={onOpenSidebar}
          className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground lg:hidden cursor-pointer"
          title="Open navigation"
        >
          <Menu className="h-4 w-4" />
        </button>
        <div
          data-tour="dashboard-connection"
          className="relative inline-block"
          onMouseEnter={() => hasTooltip && setTooltipOpen(true)}
          onMouseLeave={() => setTooltipOpen(false)}
          onFocus={() => hasTooltip && setTooltipOpen(true)}
          onBlur={() => setTooltipOpen(false)}
          role={hasTooltip ? "button" : undefined}
          tabIndex={hasTooltip ? 0 : undefined}
        >
          <span
            className={cn(
              "text-sm font-medium",
              connectionInfo == null && "text-muted-foreground",
              isConnected && "text-emerald-500",
              isNotConnected && "text-amber-500",
              hasTooltip && "cursor-help"
            )}
          >
            {titleText}
          </span>
          {tooltipOpen && hasTooltip && summary && (
            <div
              className="absolute left-0 top-full z-50 mt-1 w-[320px] rounded-lg border border-border bg-popover p-3 text-left text-popover-foreground shadow-xl"
              role="tooltip"
            >
              <p className="text-xs text-muted-foreground leading-snug">
                {summary.actualProducts} actual products loaded from {summary.masterGroups} TPP master SKU groups
                {summary.variationParents > 0
                  ? ` (${summary.standaloneRows} single-SKU rows + ${summary.childRows} child SKUs inside ${summary.variationParents} parent containers)`
                  : ""}
                .
              </p>
              <p className="mt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Related listings
              </p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5">
                {PLATFORM_ORDER.map((platform) => {
                  const count = summary.listingCounts.get(platform)?.size ?? 0;
                  if (count === 0) return null;
                  const label = PLATFORM_SHORT[platform];
                  return (
                    <li
                      key={platform}
                      className="flex items-center gap-1.5 text-xs font-medium text-foreground"
                    >
                      <PlatformIcon platform={platform} className="h-3.5 w-3.5 shrink-0" />
                      <span>{label}</span>
                      <span className="text-muted-foreground">{count}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-shrink-0 flex-nowrap items-center justify-end gap-2 sm:gap-3">
        {automationHealth && automationHealth.status !== "healthy" && (
          <div
            className={cn(
              "hidden items-center gap-2 rounded-lg border px-3 py-1.5 text-xs sm:flex",
              automationHealth.status === "attention"
                ? "border-red-500/30 bg-red-500/10 text-red-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-300",
            )}
            title={`${automationHealth.detail} Next step: ${automationHealth.recommendedAction}`}
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <div className="truncate font-semibold">
                {attentionCount} store{attentionCount === 1 ? "" : "s"} need attention
              </div>
              <div className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {automationHealth.headline}
              </div>
            </div>
          </div>
        )}
        {user && (
          <div className="hidden items-center gap-2 rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-1.5 text-xs text-orange-200 sm:flex">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[#C43E3E]" />
            <div className="min-w-0">
              <div className="truncate font-semibold text-foreground">{user.name}</div>
              <div className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {user.role} | {user.email}
              </div>
            </div>
          </div>
        )}
        {/* Density Toggle - use stable value until mounted to avoid hydration mismatch */}
        <div className="flex items-center gap-1.5">
          <span className="hidden text-[11px] font-medium text-muted-foreground sm:block">Density</span>
          <div className="flex items-center rounded-md border border-border bg-background p-0.5">
            {DENSITY_OPTIONS.map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                onClick={() => update({ density: value })}
                className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
                  density === value
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
                title={label}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
        </div>

        {/* Theme Toggle */}
        <div className="flex items-center rounded-md border border-border bg-background p-0.5">
          <button
            onClick={() => setTheme("light")}
            className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
              themeValue === "light"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Light mode"
          >
            <Sun className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setTheme("dark")}
            className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
              themeValue === "dark"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="Dark mode"
          >
            <Moon className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setTheme("system")}
            className={`rounded-sm p-1.5 transition-colors cursor-pointer ${
              themeValue === "system"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            title="System theme"
          >
            <Monitor className="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            if (pathname === "/dashboard") {
              dispatchToggleDashboardTour();
            } else {
              router.push("/dashboard?tour=manual");
            }
          }}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md border border-primary/35 bg-primary/10 px-2.5 text-primary transition-colors hover:bg-primary/20 cursor-pointer"
          title="Dashboard tour — walk through search, filters, and the grid"
          aria-label="Dashboard tour"
        >
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
          <span className="max-w-[4.5rem] truncate text-xs font-semibold sm:max-w-none">Tour</span>
        </button>

        {user && (
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
            title="Log out"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Log out</span>
          </button>
        )}
      </div>
    </header>
  );
}
