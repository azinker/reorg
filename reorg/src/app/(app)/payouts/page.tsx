"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PayoutEntry, PayoutsSummary } from "@/lib/services/payouts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMoney(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Returns YYYY-MM-DD in ET for any ISO string */
function toETDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function formatDisplayDate(yyyyMmDd: string) {
  try {
    const [y, m, d] = yyyyMmDd.split("-").map(Number);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(y, m - 1, d));
  } catch {
    return yyyyMmDd;
  }
}

function formatDateCell(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Last N calendar days in ET, newest last */
function lastNDays(n: number): string[] {
  const now = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (n - 1 - i));
    return toETDate(d.toISOString());
  });
}

function todayET(): string {
  return toETDate(new Date().toISOString());
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  PAID: "text-emerald-400",
  SUCCEEDED: "text-emerald-400",
  CLOSED: "text-emerald-400",
  SUCCESSFUL: "text-emerald-400",
  IN_TRANSIT: "text-sky-400",
  RETRYABLE_FAILURE: "text-amber-400",
  SCHEDULED: "text-amber-400",
  PENDING: "text-amber-400",
  FAILED: "text-red-400",
  TERMINAL_FAILURE: "text-red-400",
  CANCELED: "text-muted-foreground",
};

const PLATFORM_BORDER: Record<string, string> = {
  TPP_EBAY: "border-[#E53238]/30",
  TT_EBAY:  "border-[#E53238]/20",
  SHOPIFY:  "border-emerald-500/30",
  AMAZON:   "border-amber-500/30",
  BIGCOMMERCE: "border-sky-500/30",
};

const PLATFORM_GLOW: Record<string, string> = {
  TPP_EBAY: "bg-[radial-gradient(circle_at_top_left,rgba(229,50,56,0.08),transparent_55%)]",
  TT_EBAY:  "bg-[radial-gradient(circle_at_top_left,rgba(229,50,56,0.05),transparent_55%)]",
  SHOPIFY:  "bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.08),transparent_55%)]",
  AMAZON:   "bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.08),transparent_55%)]",
  BIGCOMMERCE: "bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.08),transparent_55%)]",
};

const PLATFORM_ACCENT: Record<string, string> = {
  TPP_EBAY: "text-[#E53238]",
  TT_EBAY:  "text-[#E53238]",
  SHOPIFY:  "text-emerald-400",
  AMAZON:   "text-amber-400",
  BIGCOMMERCE: "text-sky-400",
};

const NO_PAYOUT_HINT: Record<string, string> = {
  TPP_EBAY:
    "eBay pays out daily on business days. No deposit was made on this date.",
  TT_EBAY:
    "eBay pays out daily on business days. No deposit was made on this date.",
  SHOPIFY:
    "Shopify Payments deposits daily into your Shopify Balance — an internal wallet that accumulates over time. No deposit was recorded on this date. Your running balance can only be viewed inside Shopify admin (click \"Open Shopify Balance\" above).",
  AMAZON:
    "Amazon settles on a ~14-day cycle. This date falls inside a settlement period; the transfer will appear once that period closes.",
  BIGCOMMERCE:
    "Stripe payout schedules depend on your account settings. No payout was made on this date.",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function PayoutsTable({ payouts }: { payouts: PayoutEntry[] }) {
  const showGross = payouts.some((p) => p.grossAmount != null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 font-medium">Date (ET)</th>
            {showGross && <th className="px-4 py-2 font-medium">Gross</th>}
            <th className="px-4 py-2 font-medium">Net</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Type</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p.id} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
              <td className="px-4 py-2.5 text-foreground">{formatDateCell(p.date)}</td>
              {showGross && (
                <td className="px-4 py-2.5 text-muted-foreground">
                  {p.grossAmount != null ? formatMoney(p.grossAmount, p.currency) : "—"}
                </td>
              )}
              <td className="px-4 py-2.5 font-semibold text-foreground">
                {formatMoney(p.netAmount, p.currency)}
              </td>
              <td className={cn("px-4 py-2.5 font-medium", STATUS_COLOR[p.status] ?? "text-foreground")}>
                {p.status}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{p.type ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type PlatformData = PayoutsSummary["platforms"][number];

function PlatformCard({
  p,
  selectedDate,
}: {
  p: PlatformData;
  selectedDate: string | null;
}) {
  const border = PLATFORM_BORDER[p.platform] ?? "border-border";
  const glow   = PLATFORM_GLOW[p.platform]  ?? "";
  const accent = PLATFORM_ACCENT[p.platform] ?? "text-foreground";
  const isStripeNotConfigured =
    p.platform === "BIGCOMMERCE" && p.fetchError?.includes("STRIPE_SECRET_KEY");

  const filteredPayouts = selectedDate
    ? p.payouts.filter((payout) => toETDate(payout.date) === selectedDate)
    : p.payouts.slice(0, 15);

  const dateTotal = filteredPayouts.reduce((s, payout) => s + payout.netAmount, 0);
  const dateHasPayouts = filteredPayouts.length > 0;

  return (
    <div className={cn("rounded-2xl border overflow-hidden shadow-sm", border, glow)}>
      {/* Card header */}
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-4">
          <div>
            <p className={cn("text-[11px] font-semibold uppercase tracking-[0.18em]", accent)}>
              {p.label}
            </p>
            {!p.fetchError ? (
              <p className="mt-0.5 text-xl font-semibold text-foreground">
                {selectedDate
                  ? dateHasPayouts
                    ? formatMoney(dateTotal, filteredPayouts[0]?.currency ?? "USD")
                    : "—"
                  : p.latestNet != null
                    ? formatMoney(p.latestNet, p.latestCurrency)
                    : "—"}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {selectedDate ? "on this date" : "most recent"}
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-sm text-muted-foreground">—</p>
            )}
          </div>
        </div>

        {p.adminUrl && (
          <a
            href={p.adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60"
          >
            {p.adminUrlLabel ?? "Open"}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* Body */}
      <div className="border-t border-border/40">
        {isStripeNotConfigured ? (
          <div className="px-5 py-4 text-sm text-sky-200/70">
            Stripe API key not yet configured. Add{" "}
            <code className="rounded bg-sky-500/10 px-1 py-0.5 text-xs text-sky-300">
              STRIPE_SECRET_KEY
            </code>{" "}
            to your environment variables and live payout data will appear here.
          </div>
        ) : p.fetchError ? (
          <div className="flex items-start gap-2 px-5 py-4 text-xs text-amber-200">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {p.fetchError}
          </div>
        ) : selectedDate && !dateHasPayouts ? (
          <div className="flex items-start gap-2 px-5 py-4 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            <span>{NO_PAYOUT_HINT[p.platform] ?? "No payout on this date."}</span>
          </div>
        ) : filteredPayouts.length === 0 ? (
          <p className="px-5 py-4 text-sm text-muted-foreground">No payout history available.</p>
        ) : (
          <PayoutsTable payouts={filteredPayouts} />
        )}
      </div>
    </div>
  );
}

// ─── Date strip ───────────────────────────────────────────────────────────────

function DateStrip({
  payoutDateSet,
  selectedDate,
  onSelect,
}: {
  payoutDateSet: Set<string>;
  selectedDate: string | null;
  onSelect: (date: string | null) => void;
}) {
  const days = lastNDays(7);
  const today = todayET();
  const dateInputRef = useRef<HTMLInputElement>(null);

  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      {/* "All" pill */}
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(
          "flex shrink-0 cursor-pointer flex-col items-center rounded-xl border px-3.5 py-2 text-center transition-colors",
          selectedDate === null
            ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
            : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-muted/40 hover:text-foreground",
        )}
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide">All</span>
        <span className="text-sm font-bold">Latest</span>
      </button>

      {days.map((d) => {
        const [y, m, day] = d.split("-").map(Number);
        const jsDate = new Date(y, m - 1, day);
        const dayName = DAY_NAMES[jsDate.getDay()];
        const isToday = d === today;
        const isSelected = d === selectedDate;
        const hasPayout = payoutDateSet.has(d);

        return (
          <button
            key={d}
            type="button"
            onClick={() => onSelect(isSelected ? null : d)}
            className={cn(
              "relative flex shrink-0 cursor-pointer flex-col items-center rounded-xl border px-3.5 py-2 text-center transition-colors",
              isSelected
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
                : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-muted/40 hover:text-foreground",
            )}
          >
            <span className="text-[10px] font-semibold uppercase tracking-wide">
              {isToday ? "Today" : dayName}
            </span>
            <span className="text-sm font-bold">{day}</span>
            {/* Payout dot */}
            <span
              className={cn(
                "mt-1 h-1 w-1 rounded-full",
                hasPayout ? "bg-emerald-400" : "bg-transparent",
              )}
            />
          </button>
        );
      })}

      {/* Earlier: hidden date input triggered by button */}
      <div className="relative shrink-0">
        <button
          type="button"
          onClick={() => dateInputRef.current?.showPicker?.() ?? dateInputRef.current?.click()}
          className={cn(
            "flex cursor-pointer flex-col items-center rounded-xl border px-3.5 py-2 text-center transition-colors",
            selectedDate && !days.includes(selectedDate)
              ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-200"
              : "border-border bg-card text-muted-foreground hover:border-border/80 hover:bg-muted/40 hover:text-foreground",
          )}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide">
            {selectedDate && !days.includes(selectedDate)
              ? formatDisplayDate(selectedDate).replace(/,.*/, "")
              : "Earlier"}
          </span>
        </button>
        <input
          ref={dateInputRef}
          type="date"
          max={today}
          value={selectedDate && !days.includes(selectedDate) ? selectedDate : ""}
          onChange={(e) => { if (e.target.value) onSelect(e.target.value); }}
          className="pointer-events-none absolute inset-0 h-0 w-0 opacity-0"
        />
      </div>

      {/* Clear selection */}
      {selectedDate && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" />
          Clear
        </button>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PayoutsPage() {
  const [loading, setLoading]     = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [data, setData]           = useState<PayoutsSummary | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    setForbidden(false);
    try {
      const res = await fetch("/api/payouts", { cache: "no-store" });
      if (res.status === 403) { setForbidden(true); return; }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(typeof j.error === "string" ? j.error : "Failed to load");
      }
      const json = (await res.json()) as { data: PayoutsSummary };
      setData(json.data);
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Build set of all dates that have any payout across all platforms
  const payoutDateSet = new Set<string>();
  data?.platforms.forEach((p) => {
    p.payouts.forEach((payout) => payoutDateSet.add(toETDate(payout.date)));
  });

  // Hero total for selected date
  const heroTotal = data
    ? selectedDate
      ? data.platforms.reduce((sum, p) => {
          const dayPayouts = p.payouts.filter((payout) => toETDate(payout.date) === selectedDate);
          return sum + dayPayouts.reduce((s, payout) => s + (payout.currency === "USD" ? payout.netAmount : 0), 0);
        }, 0)
      : data.heroTotal
    : 0;

  if (forbidden) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-medium">Admins only</p>
        <p className="max-w-md text-sm text-muted-foreground">
          Payouts shows financial data. Ask an admin if you need access.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 p-4 md:p-6">

      {/* Page header */}
      <div className="flex flex-col gap-2 border-b border-border pb-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
            <Wallet className="h-3.5 w-3.5" />
            Payouts
          </div>
          <h1 className="mt-3 text-xl font-semibold tracking-tight text-foreground md:text-2xl">
            Marketplace Payouts
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Live payout data from every marketplace. Select a date to see what each store paid out that day.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </button>
      </div>

      {fetchError && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {fetchError}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {data && (
        <>
          {/* Hero */}
          <div className="rounded-2xl border border-emerald-500/30 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_50%)] p-5 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
                  <TrendingUp className="h-3.5 w-3.5" />
                  {selectedDate ? `Payouts — ${formatDisplayDate(selectedDate)}` : "Combined latest payouts"}
                </div>
                <p className="mt-2 text-4xl font-bold tracking-tight text-foreground">
                  {formatMoney(heroTotal, "USD")}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedDate
                    ? "Total net payouts across all marketplaces on this date (USD). Shopify Balance is not accessible via API."
                    : "Sum of the most recent payout from each connected marketplace (USD). Shopify Balance is not accessible via API."}
                </p>
              </div>

              {/* Per-platform mini badges */}
              <div className="flex flex-wrap gap-2">
                {data.platforms
                  .filter((p) => !p.fetchError || p.platform === "SHOPIFY")
                  .map((p) => {
                    const dayPayouts = selectedDate
                      ? p.payouts.filter((payout) => toETDate(payout.date) === selectedDate)
                      : null;
                    const amount = dayPayouts
                      ? dayPayouts.reduce((s, payout) => s + payout.netAmount, 0)
                      : p.latestNet;
                    const currency = dayPayouts?.[0]?.currency ?? p.latestCurrency;
                    return (
                      <div
                        key={p.platform}
                        className="rounded-lg border border-border bg-card/50 px-3 py-2"
                      >
                        <p className="text-[10px] text-muted-foreground">{p.label}</p>
                        <p className="text-sm font-semibold text-foreground">
                          {amount != null && (!selectedDate || (dayPayouts?.length ?? 0) > 0)
                            ? formatMoney(amount, currency)
                            : "—"}
                        </p>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>

          {/* Date strip */}
          <DateStrip
            payoutDateSet={payoutDateSet}
            selectedDate={selectedDate}
            onSelect={setSelectedDate}
          />

          {selectedDate && (
            <p className="text-xs text-muted-foreground">
              Showing payouts for{" "}
              <span className="font-medium text-foreground">{formatDisplayDate(selectedDate)}</span>
              {" "}— green dots on the calendar indicate days with at least one recorded payout.
            </p>
          )}

          {/* Platform cards — vertical stack */}
          <div className="flex flex-col gap-4">
            {data.platforms.map((p) => (
              <PlatformCard key={p.platform} p={p} selectedDate={selectedDate} />
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Last fetched:{" "}
            {new Intl.DateTimeFormat("en-US", {
              timeZone: "America/New_York",
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(data.fetchedAt))}{" "}
            ET
          </p>
        </>
      )}
    </div>
  );
}
