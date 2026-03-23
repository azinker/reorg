"use client";

import { useState, useRef, useEffect } from "react";
import { Search, X, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GridRow } from "@/lib/grid-types";

interface StickySearchProps {
  rows: GridRow[];
  onResultSelect: (rowId: string) => void;
  visible: boolean;
  onToggleVisibility: () => void;
}

interface SearchResult {
  rowId: string;
  sku: string;
  title: string;
  matchField: string;
  matchValue: string;
}

export function StickySearch({
  rows,
  onResultSelect,
  visible,
  onToggleVisibility,
}: StickySearchProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  function flattenRows(rows: GridRow[]): GridRow[] {
    const flat: GridRow[] = [];
    const seenChildIds = new Set<string>();
    for (const row of rows) {
      if (!row.isParent) {
        flat.push(row);
      }
      if (row.childRows) {
        for (const child of row.childRows) {
          if (seenChildIds.has(child.id)) continue;
          seenChildIds.add(child.id);
          flat.push(child);
        }
      }
    }
    return flat;
  }

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setShowResults(false);
      return;
    }

    const q = query.toLowerCase().trim();
    const allRows = flattenRows(rows);
    const matches: SearchResult[] = [];

    for (const row of allRows) {
      if (matches.length >= 15) break;

      if (row.sku.toLowerCase().includes(q)) {
        matches.push({ rowId: row.id, sku: row.sku, title: row.title, matchField: "SKU", matchValue: row.sku });
        continue;
      }

      if (row.title.toLowerCase().includes(q)) {
        matches.push({ rowId: row.id, sku: row.sku, title: row.title, matchField: "Title", matchValue: row.title });
        continue;
      }

      if (row.upc && row.upc.includes(q)) {
        matches.push({ rowId: row.id, sku: row.sku, title: row.title, matchField: "UPC", matchValue: row.upc });
        continue;
      }

      const itemMatch = row.itemNumbers.find((item) =>
        String(item.value).toLowerCase().includes(q)
      );
      if (itemMatch) {
        matches.push({
          rowId: row.id,
          sku: row.sku,
          title: row.title,
          matchField: "Item ID",
          matchValue: String(itemMatch.value),
        });
      }
    }

    setResults(matches);
    setShowResults(matches.length > 0);
    setSelectedIndex(-1);
  }, [query, rows]);

  function handleSelect(rowId: string) {
    onResultSelect(rowId);
    setShowResults(false);
    setQuery("");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      handleSelect(results[selectedIndex].rowId);
    } else if (e.key === "Escape") {
      setShowResults(false);
    }
  }

  if (!visible) {
    return (
      <div className="flex items-center justify-end px-4 py-2">
        <button
          onClick={onToggleVisibility}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          title="Show search bar"
        >
          <Eye className="h-3.5 w-3.5" />
          Show Search
        </button>
      </div>
    );
  }

  return (
    <div className="sticky top-0 z-40 border-b border-border bg-card/95 px-4 py-3 backdrop-blur-sm">
      <div className="relative flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => results.length > 0 && setShowResults(true)}
            placeholder="Search by SKU, title, UPC, or item ID..."
            className="w-full rounded-lg border border-input bg-background py-2 pl-10 pr-10 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring"
          />
          {query && (
            <button
              onClick={() => { setQuery(""); setResults([]); setShowResults(false); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <button
          onClick={onToggleVisibility}
          className="flex items-center gap-1 rounded-md px-2.5 py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
          title="Hide search bar"
        >
          <EyeOff className="h-3.5 w-3.5" />
        </button>
      </div>

      {showResults && (
        <div
          ref={resultsRef}
          className="absolute left-4 right-4 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover shadow-xl"
        >
          {results.map((result, i) => (
            <button
              key={`${result.rowId}:${result.matchField}:${i}`}
              onClick={() => handleSelect(result.rowId)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors cursor-pointer",
                i === selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground hover:bg-accent/50"
              )}
            >
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {result.matchField}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{result.title}</div>
                <div className="truncate text-xs text-muted-foreground">
                  SKU: {result.sku}
                  {result.matchField !== "SKU" && result.matchField !== "Title" && (
                    <> | {result.matchField}: {result.matchValue}</>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
