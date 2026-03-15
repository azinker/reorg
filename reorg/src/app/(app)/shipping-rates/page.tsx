"use client";

import { useState } from "react";
import { Weight, Save, Info } from "lucide-react";
import { cn } from "@/lib/utils";

const initialRows: { weight: string; normalizedOz: number; cost: string }[] = [
  ...Array.from({ length: 16 }, (_, i) => ({
    weight: `${i + 1}`,
    normalizedOz: i + 1,
    cost: "",
  })),
  ...Array.from({ length: 9 }, (_, i) => ({
    weight: `${i + 2}LBS`,
    normalizedOz: (i + 2) * 16,
    cost: "",
  })),
];

export default function ShippingRatesPage() {
  const [rows, setRows] = useState(initialRows);

  const handleCostChange = (index: number, value: string) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], cost: value };
      return next;
    });
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Weight
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Shipping Rate Table
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Weight-to-cost lookup table for internal shipping cost calculations
        </p>
      </div>

      {/* Info text */}
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          Weight values in the dashboard map to these keys: entering{" "}
          <code className="rounded bg-muted px-1 font-mono text-foreground">
            5
          </code>{" "}
          maps to 5oz, entering{" "}
          <code className="rounded bg-muted px-1 font-mono text-foreground">
            2LBS
          </code>{" "}
          maps to 2LBS.
        </p>
      </div>

      {/* Editable table */}
      <div className="mb-6 overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[400px]">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Weight
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Normalized (oz)
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium text-foreground">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={row.weight}
                  className="border-b border-border last:border-b-0 transition-colors hover:bg-muted/20"
                >
                  <td className="px-4 py-2.5 text-sm font-medium text-foreground">
                    {row.weight}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-muted-foreground">
                    {row.normalizedOz} oz
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={row.cost}
                      onChange={(e) => handleCostChange(index, e.target.value)}
                      className={cn(
                        "w-full max-w-[120px] rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground",
                        "placeholder:text-muted-foreground",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      )}
                      aria-label={`Cost for ${row.weight}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <button
        type="button"
        className={cn(
          "inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground",
          "transition-colors hover:bg-primary/90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        )}
        aria-label="Save shipping rate changes"
      >
        <Save className="h-4 w-4" aria-hidden />
        Save Changes
      </button>
    </div>
  );
}
