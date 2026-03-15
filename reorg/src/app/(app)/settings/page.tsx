"use client";

import { useState } from "react";
import { useTheme } from "@/components/providers/theme-provider";
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
} from "lucide-react";

type Density = "compact" | "comfortable" | "spacious";

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
  const { theme, setTheme } = useTheme();
  const [density, setDensity] = useState<Density>("comfortable");
  const [timezone, setTimezone] = useState("America/New_York");
  const [frozenColumns, setFrozenColumns] = useState(true);
  const [searchBar, setSearchBar] = useState(true);
  const [globalWriteLock, setGlobalWriteLock] = useState(false);

  return (
    <div className="p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Application preferences, display options, and safety controls
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
                <button
                  type="button"
                  onClick={() => setTheme("light")}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                    theme === "light"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Sun className="h-4 w-4" />
                  Light
                </button>
                <button
                  type="button"
                  onClick={() => setTheme("dark")}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                    theme === "dark"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Moon className="h-4 w-4" />
                  Dark
                </button>
                <button
                  type="button"
                  onClick={() => setTheme("system")}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
                    theme === "system"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  )}
                >
                  <Monitor className="h-4 w-4" />
                  System
                </button>
              </div>
            </div>

            {/* Density */}
            <div>
              <label className="mb-2 block text-sm font-medium">Density</label>
              <div className="flex gap-2">
                {(["compact", "comfortable", "spacious"] as const).map(
                  (d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDensity(d)}
                      className={cn(
                        "rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors cursor-pointer",
                        density === d
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      {d}
                    </button>
                  )
                )}
              </div>
            </div>

            {/* Timezone */}
            <div>
              <label
                htmlFor="timezone-select"
                className="mb-2 block text-sm font-medium"
              >
                Timezone
              </label>
              <select
                id="timezone-select"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="h-9 w-full max-w-xs cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
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
                checked={frozenColumns}
                onCheckedChange={setFrozenColumns}
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
              <ToggleSwitch checked={searchBar} onCheckedChange={setSearchBar} />
            </div>
          </div>
        </section>

        {/* SECTION 2: Safety Controls */}
        <section
          className={cn(
            "rounded-lg border p-6 shadow-sm",
            globalWriteLock
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
                  {globalWriteLock ? (
                    <Lock className="h-5 w-5 text-amber-500" />
                  ) : (
                    <Unlock className="h-5 w-5 text-muted-foreground" />
                  )}
                  <span className="font-medium">Global Write Lock</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  When enabled, all marketplace writes are blocked across all integrations
                </p>
              </div>
              <ToggleSwitch
                checked={globalWriteLock}
                onCheckedChange={setGlobalWriteLock}
                className={cn(
                  globalWriteLock && "!bg-amber-500 hover:!bg-amber-600"
                )}
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
