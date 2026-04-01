import { DollarSign, TrendingDown, TrendingUp, Target } from "lucide-react";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { cn } from "@/lib/utils";
import { PLATFORM_COLORS } from "@/lib/grid-types";
import { getProfitCenterData } from "@/lib/services/ops-insights";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function SummaryCard(props: {
  label: string;
  value: string;
  hint: string;
  tone?: "green" | "amber" | "red" | "sky";
}) {
  const tone = props.tone ?? "green";
  const toneClasses =
    tone === "red"
      ? "border-red-500/25 bg-[radial-gradient(circle_at_top_left,rgba(239,68,68,0.12),transparent_60%)] text-red-300"
      : tone === "amber"
        ? "border-amber-500/25 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.12),transparent_60%)] text-amber-300"
        : tone === "sky"
          ? "border-sky-500/25 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_60%)] text-sky-300"
          : "border-emerald-500/25 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.12),transparent_60%)] text-emerald-300";

  return (
    <div className={cn("rounded-xl border bg-card p-4 shadow-sm", toneClasses)}>
      <p className="text-xs uppercase tracking-[0.18em] text-white/55">{props.label}</p>
      <p className="mt-2 text-3xl font-semibold">{props.value}</p>
      <p className="mt-3 text-sm text-white/65">{props.hint}</p>
    </div>
  );
}

export default async function ProfitCenterPage() {
  const data = await getProfitCenterData();

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-border bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_45%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.9))] p-6 shadow-sm">
        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
          <DollarSign className="h-3.5 w-3.5" />
          Profit Center
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          See where your catalog pricing is healthy, tight, or actively losing money.
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Profit Center is based on current listing economics, not historical sales revenue. It uses the live sale price,
          supplier cost, supplier shipping, outbound shipping cost, fee rate, and ad rate already powering the dashboard.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Listings Analyzed"
          value={data.analyzedListingCount.toLocaleString()}
          hint="Store-level listing economics with both a live price and computed profit."
          tone="sky"
        />
        <SummaryCard
          label="Average Profit"
          value={formatCurrency(data.averageProfit)}
          hint={`Average margin ${formatPercent(data.averageMarginPercent)} across analyzed listings.`}
          tone="green"
        />
        <SummaryCard
          label="Negative Listings"
          value={data.negativeListingCount.toLocaleString()}
          hint="Listings currently priced below full estimated cost."
          tone="red"
        />
        <SummaryCard
          label="Profit Leakage"
          value={formatCurrency(data.totalProfitLeakage)}
          hint="Sum of the per-listing negative profit amounts across current losers."
          tone="amber"
        />
        <SummaryCard
          label="Low Margin Watchlist"
          value={data.lowMarginListingCount.toLocaleString()}
          hint="Listings between 0% and 10% margin."
          tone="amber"
        />
        <SummaryCard
          label="Healthy Margin Listings"
          value={data.highMarginListingCount.toLocaleString()}
          hint="Listings at 25% margin or higher."
          tone="green"
        />
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Marketplace Summary
        </h2>
        <div className="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {data.platformSummaries.map((platform) => (
            <div key={platform.platform} className="rounded-xl border border-border bg-background/60 p-4">
              <div className="inline-flex items-center gap-2">
                <PlatformIcon platform={platform.platform} size={18} />
                <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", PLATFORM_COLORS[platform.platform])}>
                  {platform.label}
                </span>
              </div>
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Listings</span>
                  <span className="font-medium text-foreground">{platform.listingCount.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Avg profit</span>
                  <span className="font-medium text-emerald-300">{formatCurrency(platform.averageProfit)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Avg margin</span>
                  <span className="font-medium text-sky-300">{formatPercent(platform.averageMarginPercent)}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Negative</span>
                  <span className="font-medium text-red-300">{platform.negativeCount.toLocaleString()}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Low margin</span>
                  <span className="font-medium text-amber-300">{platform.lowMarginCount.toLocaleString()}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <TrendingUp className="h-4 w-4 text-emerald-300" />
            Top Winners
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="pb-3 pr-4">SKU / Title</th>
                  <th className="pb-3 pr-4">Store</th>
                  <th className="pb-3 pr-4">Price</th>
                  <th className="pb-3 pr-4">Profit</th>
                  <th className="pb-3">Margin</th>
                </tr>
              </thead>
              <tbody>
                {data.topWinners.map((entry) => (
                  <tr key={`${entry.rowId}-${entry.platform}-${entry.sku}-winner`} className="border-t border-border/70">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-foreground">{entry.sku}</div>
                      <div className="text-xs text-muted-foreground">{entry.title}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="inline-flex items-center gap-2">
                        <PlatformIcon platform={entry.platform} size={16} />
                        <span className={cn("rounded-full border px-2 py-0.5 text-xs", PLATFORM_COLORS[entry.platform])}>
                          {entry.platform}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-foreground">{formatCurrency(entry.salePrice)}</td>
                    <td className="py-3 pr-4 text-emerald-300">{formatCurrency(entry.profit)}</td>
                    <td className="py-3 text-sky-300">{formatPercent(entry.marginPercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            <TrendingDown className="h-4 w-4 text-red-300" />
            Biggest Losers
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="pb-3 pr-4">SKU / Title</th>
                  <th className="pb-3 pr-4">Store</th>
                  <th className="pb-3 pr-4">Price</th>
                  <th className="pb-3 pr-4">Profit</th>
                  <th className="pb-3">Margin</th>
                </tr>
              </thead>
              <tbody>
                {data.biggestLosers.map((entry) => (
                  <tr key={`${entry.rowId}-${entry.platform}-${entry.sku}-loser`} className="border-t border-border/70">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-foreground">{entry.sku}</div>
                      <div className="text-xs text-muted-foreground">{entry.title}</div>
                    </td>
                    <td className="py-3 pr-4">
                      <div className="inline-flex items-center gap-2">
                        <PlatformIcon platform={entry.platform} size={16} />
                        <span className={cn("rounded-full border px-2 py-0.5 text-xs", PLATFORM_COLORS[entry.platform])}>
                          {entry.platform}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-foreground">{formatCurrency(entry.salePrice)}</td>
                    <td className="py-3 pr-4 text-red-300">{formatCurrency(entry.profit)}</td>
                    <td className="py-3 text-amber-300">{formatPercent(entry.marginPercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          <Target className="h-4 w-4 text-amber-300" />
          Low Margin Watchlist
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          These listings are still above zero profit, but they are close enough to the line that a shipping change,
          fee increase, or small price cut could turn them negative.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <tr>
                <th className="pb-3 pr-4">SKU / Title</th>
                <th className="pb-3 pr-4">Store</th>
                <th className="pb-3 pr-4">Price</th>
                <th className="pb-3 pr-4">Profit</th>
                <th className="pb-3 pr-4">Margin</th>
                <th className="pb-3">Ad Rate</th>
              </tr>
            </thead>
            <tbody>
              {data.watchlist.map((entry) => (
                <tr key={`${entry.rowId}-${entry.platform}-${entry.sku}-watch`} className="border-t border-border/70">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-foreground">{entry.sku}</div>
                    <div className="text-xs text-muted-foreground">{entry.title}</div>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="inline-flex items-center gap-2">
                      <PlatformIcon platform={entry.platform} size={16} />
                      <span className={cn("rounded-full border px-2 py-0.5 text-xs", PLATFORM_COLORS[entry.platform])}>
                        {entry.platform}
                      </span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-foreground">{formatCurrency(entry.salePrice)}</td>
                  <td className="py-3 pr-4 text-amber-300">{formatCurrency(entry.profit)}</td>
                  <td className="py-3 pr-4 text-amber-200">{formatPercent(entry.marginPercent)}</td>
                  <td className="py-3 text-muted-foreground">
                    {entry.adRatePercent == null ? "N/A" : formatPercent(entry.adRatePercent)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
