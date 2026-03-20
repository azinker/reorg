"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "@/components/providers/theme-provider";
import { useSettings } from "@/lib/use-settings";
import { setLocalDashboardTourSeen } from "@/lib/onboarding-local";
import type { Density, RowHeight, SortColumn } from "@/lib/settings-store";
import { cn } from "@/lib/utils";
import {
  Sun,
  Moon,
  Monitor,
  Lock,
  Unlock,
  AlertTriangle,
  Shield,
  Crown,
  Sparkles,
} from "lucide-react";

const TIMEZONES = [
  { value: "America/New_York", label: "Eastern (America/New_York)" },
  { value: "America/Chicago", label: "Central (America/Chicago)" },
  { value: "America/Denver", label: "Mountain (America/Denver)" },
  { value: "America/Los_Angeles", label: "Pacific (America/Los_Angeles)" },
  { value: "America/Phoenix", label: "Arizona (America/Phoenix)" },
];

function ToggleSwitch({
  checked,
  onCheckedChange,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        checked ? "bg-primary" : "bg-input",
        className
      )}
    >
      <span
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { settings, update } = useSettings();

  async function replayDashboardTour() {
    setLocalDashboardTourSeen(false);
    try {
      await fetch("/api/onboarding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", page: "dashboard" }),
      });
    } catch {
      /* offline / unauthenticated — local flag still cleared */
    }
    router.push("/dashboard?tour=replay");
  }

  return (
    <div className="p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Application preferences, display options, and safety controls.
          All changes are saved automatically.
        </p>
      </div>

      <div className="space-y-8">
        {/* SECTION 1: Display */}
        <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold">
            <Monitor className="h-5 w-5 text-muted-foreground" />
            Display
          </h2>
          <div className="space-y-6">
            {/* Theme */}
            <div>
              <label className="mb-2 block text-sm font-medium">Theme</label>
              <div className="flex gap-2">
                {([
                  { value: "light", icon: Sun, label: "Light" },
                  { value: "dark", icon: Moon, label: "Dark" },
                  { value: "system", icon: Monitor, label: "System" },
                ] as const).map(({ value, icon: Icon, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setTheme(value)}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                      theme === value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Density */}
            <div>
              <label className="mb-2 block text-sm font-medium">Density</label>
              <div className="flex gap-2">
                {(["compact", "comfortable", "spacious"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => update({ density: d })}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors cursor-pointer",
                      settings.density === d
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>

            {/* Timezone */}
            <div>
              <label htmlFor="timezone-select" className="mb-2 block text-sm font-medium">
                Timezone
              </label>
              <select
                id="timezone-select"
                value={settings.timezone}
                onChange={(e) => update({ timezone: e.target.value })}
                className="h-9 w-full max-w-xs cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.label}</option>
                ))}
              </select>
            </div>

            {/* Frozen Columns */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Freeze key columns during horizontal scroll</p>
                <p className="text-xs text-muted-foreground">
                  Keeps UPC, Item IDs, SKU, and Title visible while scrolling
                </p>
              </div>
              <ToggleSwitch
                checked={settings.frozenColumns}
                onCheckedChange={(v) => update({ frozenColumns: v })}
              />
            </div>

            {/* Search Bar */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Show sticky search bar on dashboard</p>
                <p className="text-xs text-muted-foreground">
                  Search bar remains visible at the top of the data grid
                </p>
              </div>
              <ToggleSwitch
                checked={settings.searchBar}
                onCheckedChange={(v) => update({ searchBar: v })}
              />
            </div>

            {/* Row Text Size */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label htmlFor="row-text-size" className="text-sm font-medium">Row Text Size</label>
                <span
                  className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-xs font-medium tabular-nums"
                  style={{ fontSize: `${settings.rowTextSize}px` }}
                >
                  {settings.rowTextSize}px
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">10</span>
                <input
                  id="row-text-size"
                  type="range"
                  min={10}
                  max={18}
                  step={1}
                  value={settings.rowTextSize}
                  onChange={(e) => update({ rowTextSize: Number(e.target.value) })}
                  className="h-2 w-full max-w-xs cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-md"
                />
                <span className="text-xs text-muted-foreground">18</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Adjusts the font size of text in grid rows
              </p>
            </div>

            {/* Row Height */}
            <div>
              <label className="mb-2 block text-sm font-medium">Row Height</label>
              <div className="flex gap-2">
                {(["compact", "default", "expanded"] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => update({ rowHeight: h })}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors cursor-pointer",
                      settings.rowHeight === h
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {h}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Controls vertical padding in grid rows
              </p>
            </div>

            {/* Show Alternate Titles */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Show Alternate Titles</p>
                <p className="text-xs text-muted-foreground">
                  Display warnings when duplicate item IDs have different titles
                </p>
              </div>
              <ToggleSwitch
                checked={settings.showAlternateTitles}
                onCheckedChange={(v) => update({ showAlternateTitles: v })}
              />
            </div>

            {/* Default Sort */}
            <div>
              <label htmlFor="default-sort" className="mb-2 block text-sm font-medium">
                Default Sort
              </label>
              <select
                id="default-sort"
                value={settings.defaultSort}
                onChange={(e) => update({ defaultSort: e.target.value as SortColumn })}
                className="h-9 w-full max-w-xs cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="title">Title</option>
                <option value="sku">SKU</option>
                <option value="inventory">Inventory</option>
                <option value="upc">UPC</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Column used to sort the data grid by default
              </p>
            </div>

            {/* Auto-expand Variations */}
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Auto-expand Variations</p>
                <p className="text-xs text-muted-foreground">
                  Automatically expand variation parent rows to show children
                </p>
              </div>
              <ToggleSwitch
                checked={settings.autoExpandVariations}
                onCheckedChange={(v) => update({ autoExpandVariations: v })}
              />
            </div>
          </div>
        </section>

        {/* SECTION 2: Safety Controls */}
        <section
          className={cn(
            "rounded-lg border p-6 shadow-sm",
            settings.globalWriteLock
              ? "border-amber-500/60 bg-amber-500/5 dark:bg-amber-500/10"
              : "border-border bg-card"
          )}
        >
          <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold">
            <Shield className="h-5 w-5 text-muted-foreground" />
            Safety Controls
          </h2>
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {settings.globalWriteLock ? (
                    <Lock className="h-5 w-5 text-amber-500" />
                  ) : (
                    <Unlock className="h-5 w-5 text-muted-foreground" />
                  )}
                  <span className="font-medium">Global Write Lock</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  When enabled, all marketplace writes are blocked across all integrations. This overrides per-integration locks: if global lock is ON, no integration can write.
                </p>
              </div>
              <ToggleSwitch
                checked={settings.globalWriteLock}
                onCheckedChange={(v) => update({ globalWriteLock: v })}
                className={cn(settings.globalWriteLock && "!bg-amber-500 hover:!bg-amber-600")}
              />
            </div>
            <div className="flex items-start justify-between gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {settings.livePushEnabled ? (
                    <Unlock className="h-5 w-5 text-red-400" />
                  ) : (
                    <Lock className="h-5 w-5 text-muted-foreground" />
                  )}
                  <span className="font-medium">Live Push Enabled</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  When enabled, confirmed push actions are allowed to send marketplace writes.
                  Dry runs still work with this off. Keep this off unless you are intentionally
                  testing or running live pushes.
                </p>
              </div>
              <ToggleSwitch
                checked={settings.livePushEnabled}
                onCheckedChange={(v) => update({ livePushEnabled: v })}
                className={cn(settings.livePushEnabled && "!bg-red-500 hover:!bg-red-600")}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Environment:</span>
              <span className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs font-medium">
                Local Development
              </span>
            </div>
          </div>
        </section>

        {/* Guided tour */}
        <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            Guided tour
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            New users get a one-time walkthrough of the Dashboard (search, filters, grid, and
            connection status). You can open it anytime from the <strong>Tour</strong> button
            (sparkles icon) in the top bar. After you finish or exit, it won&apos;t auto-start
            again unless you reset it here.
          </p>
          <button
            type="button"
            onClick={() => void replayDashboardTour()}
            className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
          >
            <Sparkles className="h-4 w-4" />
            Replay Dashboard tour
          </button>
        </section>

        {/* SECTION 3: Master Store (Danger Zone) */}
        <section className="rounded-lg border-2 border-destructive/50 bg-destructive/5 p-6 dark:bg-destructive/10">
          <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold text-destructive">
            <AlertTriangle className="h-5 w-5" />
            Master Store (Danger Zone)
          </h2>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Crown className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm font-medium">Current master store:</span>
              <span className="text-sm font-semibold">TPP eBay (The Perfect Part)</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Changing the master store is a major operation. It will rebuild all row identity and
              matching logic.
            </p>
            <button
              type="button"
              disabled
              className="inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-destructive bg-destructive/20 px-4 py-2 text-sm font-medium text-destructive opacity-60"
            >
              <AlertTriangle className="h-4 w-4" />
              Change Master Store
            </button>
            <p className="text-xs text-muted-foreground italic">
              Requires typing &apos;I agree&apos; and double confirmation
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
