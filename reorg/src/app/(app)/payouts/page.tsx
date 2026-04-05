"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Wallet,
  TrendingUp,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { PayoutEntry, PayoutsSummary } from "@/lib/services/payouts";

function formatMoney(amount: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

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

const PLATFORM_COLORS: Record<string, string> = {
  TPP_EBAY: "border-[#E53238]/30 bg-[radial-gradient(circle_at_top_left,rgba(229,50,56,0.10),transparent_55%)]",
  TT_EBAY: "border-[#E53238]/20 bg-[radial-gradient(circle_at_top_left,rgba(229,50,56,0.07),transparent_55%)]",
  SHOPIFY: "border-emerald-500/30 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.10),transparent_55%)]",
  AMAZON: "border-amber-500/30 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.10),transparent_55%)]",
  BIGCOMMERCE: "border-sky-500/30 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.10),transparent_55%)]",
};

const PLATFORM_ACCENT: Record<string, string> = {
  TPP_EBAY: "text-[#E53238]",
  TT_EBAY: "text-[#E53238]",
  SHOPIFY: "text-emerald-400",
  AMAZON: "text-amber-400",
  BIGCOMMERCE: "text-sky-400",
};

function PayoutsTable({ payouts }: { payouts: PayoutEntry[] }) {
  if (payouts.length === 0) {
    return <p className="px-4 py-4 text-sm text-muted-foreground">No payouts returned.</p>;
  }
  const showGross = payouts.some((p) => p.grossAmount != null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2 font-medium">Date (ET)</th>
            {showGross && <th className="px-4 py-2 font-medium">Gross</th>}
            <th className="px-4 py-2 font-medium">Net</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Type</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p.id} className="border-b border-border/60 last:border-0">
              <td className="px-4 py-2 text-foreground">{formatDate(p.date)}</td>
              {showGross && (
                <td className="px-4 py-2 text-muted-foreground">
                  {p.grossAmount != null ? formatMoney(p.grossAmount, p.currency) : "—"}
                </td>
              )}
              <td className="px-4 py-2 font-medium text-foreground">
                {formatMoney(p.netAmount, p.currency)}
              </td>
              <td className={cn("px-4 py-2 font-medium", STATUS_COLOR[p.status] ?? "text-foreground")}>
                {p.status}
              </td>
              <td className="px-4 py-2 text-muted-foreground">{p.type ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlatformCard({ p }: { p: PayoutsSummary["platforms"][number] }) {
  const borderBg = PLATFORM_COLORS[p.platform] ?? "border-border bg-card";
  const accent = PLATFORM_ACCENT[p.platform] ?? "text-foreground";
  const isStripeNotConfigured =
    p.platform === "BIGCOMMERCE" && p.fetchError?.includes("STRIPE_SECRET_KEY");

  return (
    <div className={cn("rounded-2xl border p-0 shadow-sm overflow-hidden", borderBg)}>
      <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
        <div>
          <p className={cn("text-xs font-semibold uppercase tracking-[0.18em]", accent)}>
            {p.label}
          </p>
          {p.latestNet != null ? (
            <p className="mt-1 text-2xl font-semibold text-foreground">
              {formatMoney(p.latestNet, p.latestCurrency)}
              <span className="ml-2 text-xs font-normal text-muted-foreground">latest payout</span>
            </p>
          ) : (
            <p className="mt-1 text-2xl font-semibold text-muted-foreground">—</p>
          )}
        </div>
        {p.adminUrl && (
          <a
            href={p.adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 shrink-0"
          >
            {p.adminUrlLabel ?? "Open"}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {isStripeNotConfigured ? (
        <div className="mx-5 mb-5 rounded-lg border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-sm text-sky-200/70">
          Stripe API key not configured yet. Add <code className="rounded bg-sky-500/10 px-1 py-0.5 text-xs text-sky-300">STRIPE_SECRET_KEY</code> to your environment variables once you have access, and live payout data will appear here automatically.
        </div>
      ) : p.fetchError ? (
        <div className="mx-5 mb-5 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {p.fetchError}
        </div>
      ) : (
        <div className="border-t border-border/50">
          <PayoutsTable payouts={p.payouts} />
        </div>
      )}
    </div>
  );
}

export default function PayoutsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [data, setData] = useState<PayoutsSummary | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (forbidden) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-medium">Admins only</p>
        <p className="max-w-md text-sm text-muted-foreground">Payouts shows financial data. Ask an admin if you need access.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-4 md:p-6">

      {/* Header */}
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
            Latest payout data from every marketplace. eBay and Amazon are fetched live. Shopify Balance requires opening admin. BigCommerce uses Stripe.
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

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {data && (
        <>
          {/* Hero banner */}
          <div className="rounded-2xl border border-emerald-500/30 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_50%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.92))] p-6 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
                  <TrendingUp className="h-3.5 w-3.5" />
                  Combined latest payouts
                </div>
                <p className="mt-3 text-4xl font-bold tracking-tight text-foreground">
                  {formatMoney(data.heroTotal, "USD")}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sum of most recent payout from each connected marketplace (USD). eBay and Amazon are live. Shopify Balance not available via API.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                {data.platforms
                  .filter((p) => p.latestNet != null)
                  .map((p) => (
                    <div key={p.platform} className="rounded-lg border border-border bg-card/60 px-3 py-2 text-sm">
                      <p className="text-xs text-muted-foreground">{p.label}</p>
                      <p className="font-semibold text-foreground">
                        {formatMoney(p.latestNet!, p.latestCurrency)}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Per-platform cards */}
          <div className="grid gap-5">
            {data.platforms.map((p) => (
              <PlatformCard key={p.platform} p={p} />
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Last fetched: {new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" }).format(new Date(data.fetchedAt))} ET
          </p>
        </>
      )}
    </div>
  );
}
