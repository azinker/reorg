"use client";

import { useState } from "react";
import { Weight, Save, Check, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { useShippingRates } from "@/lib/use-shipping-rates";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

export default function ShippingRatesPage() {
  const { rates, updateRates } = useShippingRates();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  function getDraft(weight: string, cost: number | null): string {
    if (weight in drafts) return drafts[weight];
    return cost != null ? cost.toFixed(2) : "";
  }

  function handleCostChange(weight: string, value: string) {
    setDrafts((prev) => ({ ...prev, [weight]: value }));
  }

  function handleSave() {
    const updated = rates.map((r) => {
      const draft = drafts[r.weight];
      if (draft === undefined) return r;
      const parsed = parseFloat(draft.trim().replace(/^\$/, ""));
      return { ...r, cost: draft.trim() === "" ? null : isNaN(parsed) ? r.cost : parsed };
    });
    updateRates(updated);
    setDrafts({});
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  const hasChanges = Object.keys(drafts).length > 0;
  const filledCount = rates.filter((r) => r.cost != null).length;

  return (
    <div className="p-6">
      <div className="mb-6" data-tour="shipping-header">
        <div className="flex items-center gap-2">
          <Weight className="h-7 w-7 shrink-0 text-muted-foreground" aria-hidden />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Shipping Rate Table
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Weight-to-cost lookup table for outbound shipping cost calculations.
          Changes here automatically update shipping costs in the catalog.
        </p>
      </div>

      <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="text-sm text-muted-foreground">
          <p>
            Weight values in the catalog map to these tiers:{" "}
            <code className="rounded bg-muted px-1 font-mono text-foreground">5</code> = 5oz,{" "}
            <code className="rounded bg-muted px-1 font-mono text-foreground">2LBS</code> = 2LBS (32oz).
            If a product weight falls between tiers, the next higher tier&apos;s rate is used.
          </p>
          <p className="mt-1 font-medium text-foreground/70">
            {filledCount} of {rates.length} tiers configured
          </p>
        </div>
      </div>

      <div className="mb-6 overflow-hidden rounded-lg border border-border bg-card" data-tour="shipping-table">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[400px]">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">Weight</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">Normalized (oz)</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">Shipping Cost ($)</th>
              </tr>
            </thead>
            <tbody>
              {rates.map((row) => (
                <tr
                  key={row.weight}
                  className="border-b border-border last:border-b-0 transition-colors hover:bg-muted/20"
                >
                  <td className="px-4 py-2.5 text-sm font-medium text-foreground">{row.weight}</td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">{row.normalizedOz} oz</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-muted-foreground">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={getDraft(row.weight, row.cost)}
                        onChange={(e) => handleCostChange(row.weight, e.target.value)}
                        className={cn(
                          "w-full max-w-[120px] rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground",
                          "placeholder:text-muted-foreground",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        )}
                        aria-label={`Cost for ${row.weight}`}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-3" data-tour="shipping-save">
        <button
          type="button"
          onClick={handleSave}
          disabled={!hasChanges}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            hasChanges
              ? "cursor-pointer bg-primary text-primary-foreground hover:bg-primary/90"
              : "cursor-not-allowed bg-muted text-muted-foreground"
          )}
        >
          <Save className="h-4 w-4" aria-hidden />
          Save Changes
        </button>

        {saved && (
          <span className="flex items-center gap-1 text-sm font-medium text-emerald-500 animate-in fade-in">
            <Check className="h-4 w-4" />
            Saved — catalog shipping costs updated
          </span>
        )}
      </div>
      <PageTour page="shippingRates" steps={PAGE_TOUR_STEPS.shippingRates} ready />
    </div>
  );
}
