import Link from "next/link";
import { AlertTriangle, ArrowRight, Image, Package, Truck, Weight } from "lucide-react";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { cn } from "@/lib/utils";
import { PLATFORM_COLORS } from "@/lib/grid-types";
import { getCatalogHealthData } from "@/lib/services/ops-insights";

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function SummaryCard(props: {
  label: string;
  value: number;
  tone?: "red" | "amber" | "sky";
  hint?: string;
}) {
  const tone = props.tone ?? "amber";
  const toneClasses =
    tone === "red"
      ? "border-red-500/25 bg-[radial-gradient(circle_at_top_left,rgba(239,68,68,0.12),transparent_60%)] text-red-300"
      : tone === "sky"
        ? "border-sky-500/25 bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_60%)] text-sky-300"
        : "border-amber-500/25 bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.12),transparent_60%)] text-amber-300";

  return (
    <div className={cn("rounded-xl border bg-card p-4 shadow-sm", toneClasses)}>
      <p className="text-xs uppercase tracking-[0.18em] text-white/55">{props.label}</p>
      <p className="mt-2 text-3xl font-semibold">{formatNumber(props.value)}</p>
      {props.hint ? <p className="mt-3 text-sm text-white/65">{props.hint}</p> : null}
    </div>
  );
}

export default async function CatalogHealthPage() {
  const data = await getCatalogHealthData();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-[radial-gradient(circle_at_top_left,rgba(245,158,11,0.14),transparent_45%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.9))] p-6 shadow-sm md:flex-row md:items-end md:justify-between">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-200">
            <AlertTriangle className="h-3.5 w-3.5" />
            Catalog Health
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Clean up the rows that distort pricing, profit, and sync confidence.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This page surfaces the catalog issues most likely to block clean operations: missing internal inputs,
            missing images or UPCs, title mismatches, and unmatched marketplace listings.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Link
            href="/dashboard"
            className="inline-flex cursor-pointer items-center justify-between rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-foreground hover:bg-muted/50"
          >
            <span>Open Dashboard</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/unmatched"
            className="inline-flex cursor-pointer items-center justify-between rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-foreground hover:bg-muted/50"
          >
            <span>Review Unmatched</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/import"
            className="inline-flex cursor-pointer items-center justify-between rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-foreground hover:bg-muted/50"
          >
            <span>Import Missing Data</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/shipping-rates"
            className="inline-flex cursor-pointer items-center justify-between rounded-xl border border-border bg-background/70 px-4 py-3 text-sm text-foreground hover:bg-muted/50"
          >
            <span>Check Shipping Rates</span>
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Catalog Rows Reviewed" value={data.totalCatalogRows} tone="sky" hint="Standalone SKUs plus variation children." />
        <SummaryCard label="Missing Supplier Cost" value={data.missingSupplierCostCount} tone="red" hint="Profit is unreliable until cost of goods is filled in." />
        <SummaryCard label="Missing Shipping Rate" value={data.missingShippingRateCount} tone="red" hint="Weight exists, but no outbound shipping cost could be calculated." />
        <SummaryCard label="Unmatched Listings" value={data.unmatchedCount} tone="amber" hint="Marketplace listings that still are not attached to a master SKU." />
        <SummaryCard label="Missing UPC" value={data.missingUpcCount} hint="Useful for marketplace consistency and future workflows." />
        <SummaryCard label="Missing Weight" value={data.missingWeightCount} hint="Blocks outbound shipping cost from calculating correctly." />
        <SummaryCard label="Missing Supplier Shipping" value={data.missingSupplierShippingCount} hint="Profit stays incomplete until inbound supplier shipping is known." />
        <SummaryCard label="Title Mismatches" value={data.titleMismatchCount} tone="sky" hint="Rows where alternate listing titles were detected." />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Issue Breakdown
          </h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {data.issueSummaries.length > 0 ? (
              data.issueSummaries.map((issue) => (
                <div
                  key={issue.key}
                  className="inline-flex items-center gap-2 rounded-full border border-border bg-background px-3 py-1.5 text-sm text-foreground"
                >
                  <span className="font-medium">{issue.label}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {formatNumber(issue.count)}
                  </span>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                No catalog health issues were found in the current data snapshot.
              </div>
            )}
          </div>

          <div className="mt-6 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Weight className="h-4 w-4 text-amber-300" />
                Profit Input Gaps
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {formatNumber(data.missingWeightCount + data.missingSupplierCostCount + data.missingSupplierShippingCount + data.missingShippingRateCount)}{" "}
                rows are missing at least one shipping or cost input that affects margin accuracy.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-background/60 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Image className="h-4 w-4 text-sky-300" />
                Merchandising Gaps
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {formatNumber(data.missingImageCount + data.missingUpcCount + data.titleMismatchCount)} rows need image,
                UPC, or title cleanup to keep catalog data consistent across stores.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Unmatched by Marketplace
          </h2>
          <div className="mt-4 space-y-3">
            {data.unmatchedByPlatform.length > 0 ? (
              data.unmatchedByPlatform.map((entry) => (
                <div key={entry.platform} className="flex items-center justify-between rounded-xl border border-border bg-background/60 px-4 py-3">
                  <div className="inline-flex items-center gap-3">
                    <PlatformIcon platform={entry.platform} size={18} />
                    <div>
                      <p className="font-medium text-foreground">{entry.label}</p>
                      <p className="text-xs text-muted-foreground">Listings waiting to be linked</p>
                    </div>
                  </div>
                  <span className={cn("rounded-full border px-2.5 py-1 text-sm font-semibold", PLATFORM_COLORS[entry.platform])}>
                    {formatNumber(entry.count)}
                  </span>
                </div>
              ))
            ) : (
              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                No unmatched listings are waiting right now.
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Most Urgent Rows
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Ranked by the issues most likely to skew profit, shipping, or listing quality.
            </p>
          </div>
          <Link href="/dashboard" className="inline-flex cursor-pointer items-center gap-2 text-sm text-primary hover:underline">
            Open full grid
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
              <tr>
                <th className="pb-3 pr-4">SKU / Title</th>
                <th className="pb-3 pr-4">Issues</th>
                <th className="pb-3 pr-4">Store Links</th>
                <th className="pb-3">Priority</th>
              </tr>
            </thead>
            <tbody>
              {data.attentionRows.map((row) => (
                <tr key={row.id} className="border-t border-border/70 align-top">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-foreground">{row.sku}</div>
                    <div className="text-xs text-muted-foreground">{row.title}</div>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex flex-wrap gap-2">
                      {row.issueLabels.map((label) => (
                        <span key={`${row.id}-${label}`} className="rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs text-red-200">
                          {label}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-muted-foreground">
                    <div className="inline-flex items-center gap-2">
                      <Package className="h-4 w-4 text-sky-300" />
                      {formatNumber(row.platformCount)} linked listings
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-200">
                      <Truck className="h-3.5 w-3.5" />
                      Score {row.issueScore}
                    </div>
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
