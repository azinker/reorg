"use client";

import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import { cn } from "@/lib/utils";

interface CurrencyInputProps {
  initialCents: number;
  onValue: (cents: number) => void;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onBlur?: () => void;
}

export interface CurrencyInputHandle {
  focus: () => void;
  getValue: () => number;
}

export const CurrencyInput = forwardRef<CurrencyInputHandle, CurrencyInputProps>(
  function CurrencyInput({ initialCents, onValue, className, autoFocus, onKeyDown, onBlur }, ref) {
    const [cents, setCents] = useState(initialCents);
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
      getValue: () => cents,
    }));

    useEffect(() => {
      if (autoFocus) inputRef.current?.focus();
    }, [autoFocus]);

    useEffect(() => {
      onValue(cents);
    }, [cents, onValue]);

    function formatted(c: number): string {
      const dollars = (c / 100).toFixed(2);
      return dollars;
    }

    function hasSelection(): boolean {
      const el = inputRef.current;
      if (!el) return false;
      return el.selectionStart !== el.selectionEnd;
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (hasSelection()) {
          setCents(0);
        } else {
          setCents((prev) => Math.floor(prev / 10));
        }
        return;
      }

      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        return;
      }

      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        if (hasSelection()) {
          setCents(parseInt(e.key, 10));
        } else {
          const digit = parseInt(e.key, 10);
          setCents((prev) => {
            const next = prev * 10 + digit;
            if (next > 99999999) return prev;
            return next;
          });
        }
        return;
      }

      onKeyDown?.(e);
    }

    return (
      <div className={cn("flex items-center gap-1", className)}>
        <span className="text-xs text-muted-foreground">$</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          value={formatted(cents)}
          onChange={() => {}}
          onKeyDown={handleKeyDown}
          onBlur={onBlur}
          className="w-20 rounded border border-ring bg-background px-1.5 py-0.5 text-xs tabular-nums text-foreground outline-none caret-transparent cursor-text select-all"
          placeholder="0.00"
        />
      </div>
    );
  }
);
