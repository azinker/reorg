"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "@/components/providers/theme-provider";
import { useSettings } from "@/lib/use-settings";
import { clearAllLocalTours, setLocalTourSeen } from "@/lib/onboarding-local";
import { ONBOARDING_PAGES } from "@/lib/onboarding-pages";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";
import type { Density, RowHeight, SortColumn } from "@/lib/settings-store";
import type { SyncProfile } from "@/lib/sync-types";
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
  RefreshCw,
  Clock,
  Loader2,
  Check,
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

const INTERVAL_OPTIONS = [
  { value: 60, label: "Every 1 hour" },
  { value: 120, label: "Every 2 hours" },
  { value: 180, label: "Every 3 hours" },
  { value: 240, label: "Every 4 hours" },
  { value: 360, label: "Every 6 hours" },
  { value: 480, label: "Every 8 hours" },
  { value: 720, label: "Every 12 hours" },
  { value: 1440, label: "Every 24 hours" },
];

const OVERNIGHT_INTERVAL_OPTIONS = [
  { value: 0, label: "Off — no overnight syncs" },
  ...INTERVAL_OPTIONS,
];

const FULL_SYNC_INTERVAL_OPTIONS = [
  { value: 12, label: "Every 12 hours" },
  { value: 24, label: "Every 24 hours" },
  { value: 48, label: "Every 48 hours" },
  { value: 72, label: "Every 3 days" },
  { value: 168, label: "Every 7 days" },
];

const STORE_META: Record<string, { name: string; acronym: string; logo: string }> = {
  TPP_EBAY: { name: "The Perfect Part", acronym: "TPP", logo: "/logos/ebay.svg" },
  TT_EBAY: { name: "Telitetech", acronym: "TT", logo: "/logos/ebay.svg" },
  BIGCOMMERCE: { name: "BigCommerce", acronym: "BC", logo: "/logos/bigcommerce.svg" },
  SHOPIFY: { name: "Shopify", acronym: "SHPFY", logo: "/logos/shopify.svg" },
};

type IntegrationScheduleData = {
  platform: string;
  label: string;
  enabled: boolean;
  connected: boolean;
  syncProfile: SyncProfile;
};

function formatInterval(minutes: number) {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

function formatHour(hour: number) {
  if (hour === 0 || hour === 24) return "12:00 AM";
  if (hour === 12) return "12:00 PM";
  return hour < 12 ? `${hour}:00 AM` : `${hour - 12}:00 PM`;
}

function SyncScheduleSection() {
  const [integrations, setIntegrations] = useState<IntegrationScheduleData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch("/api/integrations");
      const json = await res.json();
      const items = (json.data ?? json) as IntegrationScheduleData[];
      setIntegrations(
        items.filter((i) => STORE_META[i.platform] && i.platform !== "AMAZON")
      );
    } catch {
      /* will show empty state */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchIntegrations(); }, [fetchIntegrations]);

  async function updateProfile(
    platform: string,
    patch: Partial<SyncProfile>,
  ) {
    setSaving((prev) => ({ ...prev, [platform]: true }));
    setSaved((prev) => ({ ...prev, [platform]: false }));
    try {
      await fetch(`/api/integrations/${platform}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { syncProfile: patch } }),
      });
      setIntegrations((prev) =>
        prev.map((i) =>
          i.platform === platform
            ? { ...i, syncProfile: { ...i.syncProfile, ...patch } }
            : i
        )
      );
      setSaved((prev) => ({ ...prev, [platform]: true }));
      setTimeout(() => setSaved((prev) => ({ ...prev, [platform]: false })), 2000);
    } catch {
      /* error state could be added */
    } finally {
      setSaving((prev) => ({ ...prev, [platform]: false }));
    }
  }

  if (loading) {
    return (
      <section className="rounded-lg border border-border bg-card p-6 shadow-sm">
        <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold">
          <RefreshCw className="h-5 w-5 text-muted-foreground" />
          Automatic Sync Schedule
        </h2>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading integration schedules...
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-6 shadow-sm" data-tour="settings-sync-schedule">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
        <RefreshCw className="h-5 w-5 text-muted-foreground" />
        Automatic Sync Schedule
      </h2>
      <p className="mb-5 text-sm text-muted-foreground">
        Control how often reorG automatically pulls data from each marketplace.
        These are <strong>pull-only</strong> operations — sync never writes to any marketplace.
      </p>

      {/* Explanation cards */}
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4 dark:bg-blue-500/10">
          <div className="mb-2 flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-blue-500" />
            <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">Normal Sync (Incremental)</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Pulls only listings that <strong>changed since the last sync</strong>.
            Fast and lightweight — usually takes seconds.
          </p>
          <p className="mt-2 text-xs text-muted-foreground italic">
            Example: A buyer purchases an item on eBay at 2:00 PM. At the next normal sync,
            reorG picks up the updated quantity — without re-downloading your entire catalog.
          </p>
        </div>
        <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4 dark:bg-purple-500/10">
          <div className="mb-2 flex items-center gap-2">
            <Clock className="h-4 w-4 text-purple-500" />
            <span className="text-sm font-semibold text-purple-600 dark:text-purple-400">Full Sync (Reconcile)</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Re-downloads <strong>every listing</strong> from the marketplace and compares it
            against what reorG has stored. Catches anything a normal sync might miss.
          </p>
          <p className="mt-2 text-xs text-muted-foreground italic">
            Example: You bulk-edited 200 titles directly on eBay. A full sync picks up all 200
            changes at once, even if the incremental API missed some.
          </p>
        </div>
      </div>

      {/* Per-integration schedule cards */}
      <div className="space-y-4">
        {integrations.map((integration) => {
          const meta = STORE_META[integration.platform];
          if (!meta) return null;
          const profile = integration.syncProfile;
          const isSaving = saving[integration.platform];
          const isSaved = saved[integration.platform];

          return (
            <div
              key={integration.platform}
              className={cn(
                "rounded-lg border p-4 transition-colors",
                integration.connected
                  ? "border-border bg-background/50"
                  : "border-border/50 bg-muted/30 opacity-60"
              )}
            >
              {/* Store header */}
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={meta.logo} alt={meta.name} className="h-6 w-6" />
                  <div>
                    <span className="text-sm font-semibold">{meta.name}</span>
                    <span className="ml-2 inline-flex items-center rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                      {meta.acronym}
                    </span>
                  </div>
                  {!integration.connected && (
                    <span className="text-xs text-muted-foreground">(not connected)</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  {isSaved && <Check className="h-3.5 w-3.5 text-green-500" />}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">Auto sync</span>
                    <ToggleSwitch
                      checked={profile.autoSyncEnabled}
                      onCheckedChange={(v) =>
                        void updateProfile(integration.platform, { autoSyncEnabled: v })
                      }
                    />
                  </div>
                </div>
              </div>

              {profile.autoSyncEnabled && (
                <div className="space-y-4">
                  {/* Row 1: Active Hours — explain first since it governs the other two */}
                  <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                    <label className="mb-1 block text-xs font-semibold">
                      Active Hours
                    </label>
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      Defines your business hours. The <strong>Normal Sync</strong> frequency below
                      only applies during this window. Outside these hours, the <strong>Overnight</strong> frequency
                      is used instead. Full Sync runs anytime it&apos;s due, regardless of this window.
                    </p>
                    <div className="flex items-center gap-1.5">
                      <select
                        value={profile.dayStartHour}
                        onChange={(e) =>
                          void updateProfile(integration.platform, {
                            dayStartHour: Number(e.target.value),
                          })
                        }
                        className="h-8 w-full max-w-[130px] cursor-pointer rounded-md border border-input bg-background px-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {Array.from({ length: 24 }, (_, i) => (
                          <option key={i} value={i}>{formatHour(i)}</option>
                        ))}
                      </select>
                      <span className="shrink-0 text-xs text-muted-foreground">to</span>
                      <select
                        value={profile.dayEndHour}
                        onChange={(e) =>
                          void updateProfile(integration.platform, {
                            dayEndHour: Number(e.target.value),
                          })
                        }
                        className="h-8 w-full max-w-[130px] cursor-pointer rounded-md border border-input bg-background px-1.5 text-xs ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                          <option key={h} value={h}>{formatHour(h)}</option>
                        ))}
                      </select>
                      <span className="text-[10px] text-muted-foreground">(your timezone)</span>
                    </div>
                  </div>

                  {/* Row 2: Three intervals side by side */}
                  <div className="grid gap-4 sm:grid-cols-3">
                    {/* Normal sync interval */}
                    <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-3 dark:bg-blue-500/10">
                      <label className="mb-1 block text-xs font-semibold">
                        Normal Sync Frequency
                      </label>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        How often an incremental sync runs <strong>during active hours</strong> ({formatHour(profile.dayStartHour)} – {formatHour(profile.dayEndHour)}).
                        Only pulls listings that changed since the last sync.
                      </p>
                      <select
                        value={profile.dayIntervalMinutes}
                        onChange={(e) =>
                          void updateProfile(integration.platform, {
                            dayIntervalMinutes: Number(e.target.value),
                          })
                        }
                        className="h-8 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {INTERVAL_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Overnight interval */}
                    <div className="rounded-md border border-indigo-500/20 bg-indigo-500/5 p-3 dark:bg-indigo-500/10">
                      <label className="mb-1 block text-xs font-semibold">
                        Overnight Sync Frequency
                      </label>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        How often a <strong>normal (incremental) sync</strong> runs <strong>outside active hours</strong> ({formatHour(profile.dayEndHour)} – {formatHour(profile.dayStartHour)}).
                        Set to &quot;Off&quot; to stop all normal syncs overnight — only Full Sync will still run if it&apos;s due.
                      </p>
                      <select
                        value={profile.overnightIntervalMinutes}
                        onChange={(e) =>
                          void updateProfile(integration.platform, {
                            overnightIntervalMinutes: Number(e.target.value),
                          })
                        }
                        className="h-8 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {OVERNIGHT_INTERVAL_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>

                    {/* Full sync interval */}
                    <div className="rounded-md border border-purple-500/20 bg-purple-500/5 p-3 dark:bg-purple-500/10">
                      <label className="mb-1 block text-xs font-semibold">
                        Full Sync Frequency
                      </label>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        How often a <strong>complete re-download</strong> of all listings runs.
                        Runs anytime it&apos;s due — day or night. Catches anything normal sync missed.
                      </p>
                      <select
                        value={profile.fullReconcileIntervalHours}
                        onChange={(e) =>
                          void updateProfile(integration.platform, {
                            fullReconcileIntervalHours: Number(e.target.value),
                          })
                        }
                        className="h-8 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      >
                        {FULL_SYNC_INTERVAL_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Summary line */}
              {profile.autoSyncEnabled && (
                <div className="mt-3 flex items-start gap-1.5 rounded-md bg-muted/50 px-3 py-2">
                  <Clock className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="text-[11px] leading-relaxed text-muted-foreground">
                    <strong>{formatHour(profile.dayStartHour)} – {formatHour(profile.dayEndHour)}:</strong> Normal sync every <strong>{formatInterval(profile.dayIntervalMinutes)}</strong>.
                    {" "}<strong>{formatHour(profile.dayEndHour)} – {formatHour(profile.dayStartHour)}:</strong>{" "}
                    {profile.overnightIntervalMinutes === 0
                      ? <><strong>No overnight syncs</strong> (only Full Sync runs if due).</>
                      : <>Normal sync every <strong>{formatInterval(profile.overnightIntervalMinutes)}</strong>.</>
                    }
                    {" "}Full sync every <strong>{profile.fullReconcileIntervalHours}h</strong> (anytime).
                  </span>
                </div>
              )}

              {!profile.autoSyncEnabled && (
                <p className="text-xs text-muted-foreground italic">
                  Automatic sync is off — you&apos;ll need to run syncs manually from the Sync page.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { settings, update } = useSettings();

  async function replayCatalogTour() {
    setLocalTourSeen("catalog", false);
    try {
      await fetch("/api/onboarding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset", page: "catalog" }),
      });
    } catch {
      /* offline / unauthenticated — local flag still cleared */
    }
    router.push("/catalog?tour=manual");
  }

  async function resetAllTours() {
    clearAllLocalTours();
    for (const page of ONBOARDING_PAGES) {
      setLocalTourSeen(page, false);
    }
    try {
      await fetch("/api/onboarding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_all" }),
      });
    } catch {
      /* local fallback done */
    }
  }

  return (
    <div className="p-6">
      <div className="mb-8" data-tour="settings-header">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Application preferences, display options, and safety controls.
          All changes are saved automatically.
        </p>
      </div>

      <div className="space-y-8">
        {/* SECTION 1: Display */}
        <section className="rounded-lg border border-border bg-card p-6 shadow-sm" data-tour="settings-display">
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
                <p className="text-sm font-medium">Show sticky search bar on catalog</p>
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
          data-tour="settings-safety"
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
            <div className="h-px bg-border" />
            <div className="flex items-start justify-between gap-6">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  {settings.helpdeskSafeMode ? (
                    <Lock className="h-5 w-5 text-amber-500" />
                  ) : (
                    <Unlock className="h-5 w-5 text-muted-foreground" />
                  )}
                  <span className="font-medium">Help Desk Safe Mode</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  When ON, all Help Desk outbound actions are blocked: no eBay replies, no email
                  sends, and no read/unread sync between eBay and Help Desk. Incoming sync
                  (pulling messages) still works. Also manageable from{" "}
                  <a href="/help-desk/global-settings" className="text-primary hover:underline">
                    Help Desk → Global Settings
                  </a>.
                </p>
              </div>
              <ToggleSwitch
                checked={settings.helpdeskSafeMode}
                onCheckedChange={(v) => update({ helpdeskSafeMode: v })}
                className={cn(settings.helpdeskSafeMode && "!bg-amber-500 hover:!bg-amber-600")}
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

        {/* SECTION 3: Automatic Sync Schedule */}
        <SyncScheduleSection />

        {/* Guided tour */}
        <section className="rounded-lg border border-border bg-card p-6 shadow-sm" data-tour="settings-tour">
          <h2 className="mb-5 flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="h-5 w-5 text-muted-foreground" />
            Guided tour
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            New users get a one-time walkthrough of the Catalog (search, filters, grid, and
            connection status). You can open it anytime from the <strong>Tour</strong> button
            (sparkles icon) in the top bar. After you finish or exit, it won&apos;t auto-start
            again unless you reset it here.
          </p>
          <button
            type="button"
            onClick={() => void replayCatalogTour()}
            className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20 cursor-pointer"
          >
            <Sparkles className="h-4 w-4" />
            Replay Catalog tour
          </button>
          <button
            type="button"
            onClick={() => void resetAllTours()}
            className="ml-2 inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          >
            Reset all page tours
          </button>
        </section>

        {/* SECTION 5: Master Store (Danger Zone) */}
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
      <PageTour page="settings" steps={PAGE_TOUR_STEPS.settings} ready />
    </div>
  );
}
