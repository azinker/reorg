"use client";

import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Pencil, Check, X } from "lucide-react";
import { CurrencyInput, type CurrencyInputHandle } from "./currency-input";

interface EditableCurrencyCellProps {
  value: number | null;
  rowId: string;
  field: string;
  onSave?: (rowId: string, field: string, value: number | null) => void;
}

export function EditableCurrencyCell({ value, rowId, field, onSave }: EditableCurrencyCellProps) {
  const [editing, setEditing] = useState(false);
  const [draftCents, setDraftCents] = useState(0);
  const inputRef = useRef<CurrencyInputHandle>(null);

  function startEdit() {
    setDraftCents(value != null ? Math.round(value * 100) : 0);
    setEditing(true);
  }

  function save() {
    const dollars = draftCents / 100;
    onSave?.(rowId, field, dollars);
    setEditing(false);
  }

  function cancel() {
    setEditing(false);
  }

  const handleValue = useCallback((c: number) => setDraftCents(c), []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") save();
    else if (e.key === "Escape") cancel();
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <CurrencyInput
          ref={inputRef}
          initialCents={draftCents}
          onValue={handleValue}
          autoFocus
          onKeyDown={handleKeyDown}
        />
        <button onClick={save} className="rounded p-0.5 text-emerald-400 hover:text-emerald-300 cursor-pointer">
          <Check className="h-3 w-3" />
        </button>
        <button onClick={cancel} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer">
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="group/edit flex items-center gap-1">
      <span className={cn(
        "text-xs tabular-nums",
        value == null ? "text-amber-500 italic" : "text-foreground"
      )}>
        {value != null ? `$${value.toFixed(2)}` : "—"}
      </span>
      <button
        onClick={startEdit}
        className="shrink-0 rounded p-0.5 text-muted-foreground/65 transition-colors group-hover/edit:text-foreground hover:!text-foreground dark:text-transparent dark:group-hover/edit:text-muted-foreground/70 cursor-pointer"
        title="Edit"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}
