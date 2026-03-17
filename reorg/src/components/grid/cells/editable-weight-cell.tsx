"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Pencil, Check, X } from "lucide-react";

interface EditableWeightCellProps {
  value: string | null;
  rowId: string;
  onSave: (rowId: string, weight: string) => void;
}

export function EditableWeightCell({ value, rowId, onSave }: EditableWeightCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [unit, setUnit] = useState<"oz" | "LBS">("oz");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setEditing(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [editing]);

  function startEdit() {
    if (value) {
      const upper = value.trim().toUpperCase();
      if (upper.endsWith("LBS")) {
        setDraft(upper.replace("LBS", ""));
        setUnit("LBS");
      } else {
        setDraft(upper.replace("OZ", ""));
        setUnit("oz");
      }
    } else {
      setDraft("");
      setUnit("oz");
    }
    setEditing(true);
  }

  function save() {
    const num = parseFloat(draft.trim());
    if (isNaN(num) || num <= 0) return;
    const formatted = unit === "LBS" ? `${num}LBS` : `${num}`;
    onSave(rowId, formatted);
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    else if (e.key === "Escape") setEditing(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="group/edit flex items-center gap-1">
        {value ? (
          <span className="scalable-text">{fmtWeight(value)}</span>
        ) : (
          <span className="text-[11px] text-amber-500 italic">Missing</span>
        )}
        <button
          onClick={startEdit}
          className="shrink-0 rounded p-0.5 text-muted-foreground/0 transition-all group-hover/edit:text-muted-foreground/40 hover:!text-foreground cursor-pointer"
          title="Edit weight"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>

      {editing && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 z-50 mt-1 rounded-lg border border-border bg-card p-2.5 shadow-xl whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="number"
              step="any"
              min="0"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-14 rounded border border-ring bg-background px-1.5 py-1 text-xs tabular-nums text-foreground outline-none"
              placeholder="0"
            />
            <div className="flex rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setUnit("oz")}
                className={cn(
                  "px-2 py-1 text-[11px] font-bold transition-colors cursor-pointer",
                  unit === "oz"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground"
                )}
              >
                oz
              </button>
              <button
                type="button"
                onClick={() => setUnit("LBS")}
                className={cn(
                  "px-2 py-1 text-[11px] font-bold transition-colors cursor-pointer",
                  unit === "LBS"
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted-foreground hover:text-foreground"
                )}
              >
                LBS
              </button>
            </div>
            <button onClick={save} className="rounded p-1 text-emerald-400 hover:text-emerald-300 cursor-pointer" title="Save">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setEditing(false)} className="rounded p-1 text-muted-foreground hover:text-foreground cursor-pointer" title="Cancel">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtWeight(w: string): string {
  const trimmed = w.trim().toUpperCase();
  if (trimmed.endsWith("LBS")) return trimmed;
  const num = parseFloat(trimmed);
  if (!isNaN(num)) return `${num}oz`;
  return trimmed;
}
