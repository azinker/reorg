"use client";

import { useState, useEffect } from "react";
import { DataGrid } from "@/components/grid/data-grid";
import type { GridRow } from "@/lib/grid-types";
import { MOCK_ROWS } from "@/lib/mock-data";
import { Loader2 } from "lucide-react";

export default function DashboardPage() {
  const [rows, setRows] = useState<GridRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"db" | "mock" | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/grid");
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const json = await res.json();
        const dbRows: GridRow[] = json.data?.rows ?? [];
        if (dbRows.length > 0) {
          setRows(dbRows);
          setSource("db");
        } else {
          setRows(MOCK_ROWS);
          setSource("mock");
        }
      } catch (err) {
        console.error("Failed to load grid data from API, falling back to mock:", err);
        setRows(MOCK_ROWS);
        setSource("mock");
        setError(String(err));
      }
    }
    load();
  }, []);

  if (!rows) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Loading grid data...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      {source === "mock" && (
        <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-1.5">
          <span className="text-xs text-amber-400">
            {error
              ? "Database connection failed — showing mock data."
              : "No products in database yet — showing mock data. Run seed to populate."}
          </span>
        </div>
      )}
      {source === "db" && (
        <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/5 px-4 py-1.5">
          <span className="text-xs text-emerald-400">
            Connected to database — {rows.length} products loaded.
          </span>
        </div>
      )}
      <DataGrid rows={rows} />
    </div>
  );
}
