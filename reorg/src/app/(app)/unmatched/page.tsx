"use client";

import { useState } from "react";
import { Unlink, Filter, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const STORE_OPTIONS = [
  { value: "all", label: "All" },
  { value: "tt", label: "TT" },
  { value: "bc", label: "BC" },
  { value: "shpfy", label: "SHPFY" },
] as const;

export default function UnmatchedPage() {
  const [selectedStore, setSelectedStore] = useState<string>("all");

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Unlink
            className="h-7 w-7 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            Unmatched External Listings
          </h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          External listings with no matching master-store SKU
        </p>
      </div>

      {/* Filter row */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <Filter
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <label htmlFor="store-filter" className="text-sm font-medium text-foreground">
            Store
          </label>
          <select
            id="store-filter"
            value={selectedStore}
            onChange={(e) => setSelectedStore(e.target.value)}
            className={cn(
              "cursor-pointer rounded-md border border-input bg-background px-3 py-1.5 text-sm text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            )}
            aria-label="Filter by store"
          >
            {STORE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-1 items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 max-w-xs">
          <Search
            className="h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            placeholder="Search unmatched listings..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            aria-label="Search unmatched listings"
          />
        </div>
      </div>

      {/* Empty state */}
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 py-16 px-6">
        <Unlink
          className="mb-4 h-12 w-12 shrink-0 text-muted-foreground/50"
          aria-hidden
        />
        <h2 className="mb-2 text-base font-medium text-foreground">
          No unmatched listings found
        </h2>
        <p className="max-w-md text-center text-sm text-muted-foreground">
          After syncing external stores, listings without a matching master-store
          SKU will appear here.
        </p>
      </div>
    </div>
  );
}
