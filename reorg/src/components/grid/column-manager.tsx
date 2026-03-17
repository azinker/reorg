"use client";

import { useState } from "react";
import { Columns3, Eye, EyeOff } from "lucide-react";
import type { ColumnConfig } from "@/lib/grid-types";

interface ColumnManagerProps {
  columns: ColumnConfig[];
  onToggle: (columnId: string) => void;
}

export function ColumnManager({ columns, onToggle }: ColumnManagerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
        title="Show/hide columns"
      >
        <Columns3 className="h-3.5 w-3.5" />
        Columns
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-popover p-2 shadow-xl">
            <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Toggle Columns
            </p>
            <div className="max-h-80 space-y-0.5 overflow-y-auto">
              {columns.map((col) => (
                <button
                  key={col.id}
                  onClick={() => onToggle(col.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent cursor-pointer"
                >
                  {col.visible ? (
                    <Eye className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground/40" />
                  )}
                  <span className={col.visible ? "text-foreground" : "text-muted-foreground/60"}>
                    {col.label}
                  </span>
                  {col.frozen && (
                    <span className="ml-auto text-[9px] text-muted-foreground/40">FROZEN</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
