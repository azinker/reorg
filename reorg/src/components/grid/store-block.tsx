"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check, Pencil, X, Upload, Undo2, DollarSign } from "lucide-react";
import { CurrencyInput, type CurrencyInputHandle } from "@/components/grid/cells/currency-input";
import {
  PLATFORM_SHORT,
  PLATFORM_COLORS,
  type Platform,
  type StoreValue,
} from "@/lib/grid-types";
import { PlatformIcon } from "@/components/grid/platform-icon";

interface StoreBlockProps {
  item: StoreValue;
  format?: "currency" | "percent" | "text" | "link";
  showStaged?: boolean;
  showItemId?: boolean;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      onClick={handleCopy}
      className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground cursor-pointer"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}

function isNegative(val: number | string | null | undefined): boolean {
  if (val == null) return false;
  return Number(val) < 0;
}

export function StoreBlock({ item, format = "text", showStaged = true, showItemId = false }: StoreBlockProps) {
  const label = PLATFORM_SHORT[item.platform];
  const colorClass = PLATFORM_COLORS[item.platform];
  const hasStaged = showStaged && item.stagedValue != null && item.stagedValue !== item.value;

  function fmt(val: number | string | null): string {
    if (val == null) return "N/A";
    if (format === "currency") return `$${Number(val).toFixed(2)}`;
    if (format === "percent") return `${(Number(val) * 100).toFixed(1)}%`;
    return String(val);
  }

  const displayVal = hasStaged ? fmt(item.stagedValue!) : fmt(item.value);
  const valNeg = isNegative(hasStaged ? item.stagedValue : item.value);
  const shortItemId = showItemId ? item.listingId.slice(-6) : null;

  return (
    <div
      className={cn(
        "flex w-full items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs",
        colorClass,
        hasStaged && "ring-1 ring-[var(--staged)]"
      )}
    >
      <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
      <div className="shrink-0 flex flex-col items-start">
        <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">
          {label}
        </span>
        {shortItemId && (
          <span className="text-[8px] font-mono text-muted-foreground/60 leading-none mt-0.5" title={`Item ID: ${item.listingId}`}>
            #{shortItemId}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {hasStaged ? (
          <>
            <span className={cn("flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.stagedValue) ? "text-red-400" : "text-emerald-400")}>
              {fmt(item.stagedValue!)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-[var(--staged)] px-1 py-px text-[9px] font-bold text-[var(--staged-foreground)]">
                STAGED
              </span>
            </span>
            <span className={cn("mt-1 flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.value) ? "text-red-400" : "text-emerald-400")}>
              {fmt(item.value)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">
                LIVE
              </span>
            </span>
          </>
        ) : (
          <span className={cn("font-medium leading-tight", valNeg ? "text-red-400" : "text-emerald-400")}>{fmt(item.value)}</span>
        )}
      </div>
      <CopyButton text={displayVal} />
    </div>
  );
}

interface StoreBlockGroupProps {
  items: StoreValue[];
  format?: "currency" | "percent" | "text" | "link";
  showStaged?: boolean;
}

export function StoreBlockGroup({ items, format = "text", showStaged = true }: StoreBlockGroupProps) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const platformCounts = new Map<string, number>();
  for (const item of items) {
    platformCounts.set(item.platform, (platformCounts.get(item.platform) ?? 0) + 1);
  }
  const hasDuplicatePlatforms = [...platformCounts.values()].some((c) => c > 1);

  return (
    <div className="flex w-full flex-col gap-1">
      {items.map((item, i) => (
        <StoreBlock
          key={`${item.platform}-${item.listingId}-${i}`}
          item={item}
          format={format}
          showStaged={showStaged}
          showItemId={hasDuplicatePlatforms && (platformCounts.get(item.platform) ?? 0) > 1}
        />
      ))}
    </div>
  );
}

/* ──────────────── Editable Sale Price Store Block ──────────────── */

interface EditableStoreBlockProps {
  item: StoreValue;
  rowId: string;
  onSave: (rowId: string, platform: string, listingId: string, newPrice: number, mode: "stage" | "push") => void;
  onPush: (rowId: string, platform: string, listingId: string) => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
  showItemId?: boolean;
}

function EditableStoreBlock({ item, rowId, onSave, onPush, onDiscard, showItemId = false }: EditableStoreBlockProps) {
  const label = PLATFORM_SHORT[item.platform];
  const colorClass = PLATFORM_COLORS[item.platform];
  const hasStaged = item.stagedValue != null && item.stagedValue !== item.value;

  const [editing, setEditing] = useState(false);
  const [draftCents, setDraftCents] = useState(0);
  const [showActions, setShowActions] = useState(false);
  const inputRef = useRef<CurrencyInputHandle>(null);

  function fmt(val: number | string | null): string {
    if (val == null) return "N/A";
    return `$${Number(val).toFixed(2)}`;
  }

  function startEdit() {
    const current = hasStaged ? Number(item.stagedValue) : Number(item.value);
    setDraftCents(current ? Math.round(current * 100) : 0);
    setEditing(true);
    setShowActions(false);
  }

  function cancelEdit() {
    setEditing(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") cancelEdit();
    if (e.key === "Enter") setShowActions(true);
  }

  const handleValue = useCallback((c: number) => setDraftCents(c), []);

  function confirmStage() {
    const num = draftCents / 100;
    if (num < 0) return;
    onSave(rowId, item.platform, item.listingId, num, "stage");
    setEditing(false);
    setShowActions(false);
  }

  function confirmPush() {
    const num = draftCents / 100;
    if (num < 0) return;
    onSave(rowId, item.platform, item.listingId, num, "push");
    setEditing(false);
    setShowActions(false);
  }

  const displayVal = hasStaged ? fmt(item.stagedValue!) : fmt(item.value);
  const shortItemId = showItemId ? item.listingId.slice(-6) : null;

  if (editing) {
    return (
      <div className={cn("w-full rounded border px-2.5 py-1.5 text-xs", colorClass, "ring-1 ring-ring")}>
        <div className="flex items-center gap-1 mb-1">
          <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
          <div className="shrink-0 flex flex-col items-start">
            <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
            {shortItemId && <span className="text-[8px] font-mono text-muted-foreground/60 leading-none mt-0.5" title={`Item ID: ${item.listingId}`}>#{shortItemId}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <CurrencyInput
            ref={inputRef}
            initialCents={draftCents}
            onValue={handleValue}
            autoFocus
            onKeyDown={handleKeyDown}
          />
          {!showActions ? (
            <>
              <button onClick={() => setShowActions(true)} className="rounded p-0.5 text-emerald-400 hover:text-emerald-300 cursor-pointer" title="Confirm">
                <Check className="h-3 w-3" />
              </button>
              <button onClick={cancelEdit} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" title="Cancel">
                <X className="h-3 w-3" />
              </button>
            </>
          ) : (
            <div className="flex items-center gap-1 ml-1">
              <button
                onClick={confirmStage}
                className="flex items-center gap-0.5 rounded bg-[var(--staged)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
                title="Stage value to test profit before pushing"
              >
                Stage
              </button>
              <button
                onClick={confirmPush}
                className="flex items-center gap-0.5 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-600 cursor-pointer"
                title="Review the guarded live push flow for this value"
              >
                Review Push
              </button>
              <button onClick={cancelEdit} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" title="Cancel">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/edit flex w-full items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs",
        colorClass,
        hasStaged && "ring-1 ring-[var(--staged)]"
      )}
    >
      <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
      <div className="shrink-0 flex flex-col items-start">
        <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
        {shortItemId && <span className="text-[8px] font-mono text-muted-foreground/60 leading-none mt-0.5" title={`Item ID: ${item.listingId}`}>#{shortItemId}</span>}
      </div>
      <div className="min-w-0 flex-1">
        {hasStaged ? (
          <>
            <span className={cn("flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.stagedValue) ? "text-red-400" : "text-emerald-400")}>
              {fmt(item.stagedValue!)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-[var(--staged)] px-1 py-px text-[9px] font-bold text-[var(--staged-foreground)]">
                STAGED
              </span>
            </span>
            <span className={cn("mt-1 flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.value) ? "text-red-400" : "text-emerald-400")}>
              {fmt(item.value)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">
                LIVE
              </span>
            </span>
            <div className="mt-1 flex items-center gap-1">
              <button
                onClick={() => onPush(rowId, item.platform, item.listingId)}
                className="flex items-center gap-0.5 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-600 cursor-pointer"
                title="Review the guarded live push flow for this staged price"
              >
                <Upload className="h-2.5 w-2.5" />
                Review Push
              </button>
              <button
                onClick={() => onDiscard(rowId, item.platform, item.listingId)}
                className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground cursor-pointer"
                title="Discard staged price and revert to live"
              >
                <Undo2 className="h-2.5 w-2.5" />
                Discard
              </button>
            </div>
          </>
        ) : (
          <span className={cn("font-medium leading-tight", isNegative(item.value) ? "text-red-400" : "text-emerald-400")}>{fmt(item.value)}</span>
        )}
      </div>
      <button
        onClick={startEdit}
        className="shrink-0 rounded p-0.5 text-muted-foreground/0 transition-all group-hover/edit:text-muted-foreground/60 hover:!text-foreground cursor-pointer"
        title="Edit price"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <CopyButton text={displayVal} />
    </div>
  );
}

interface EditableStoreBlockGroupProps {
  items: StoreValue[];
  rowId: string;
  onSave: (rowId: string, platform: string, listingId: string, newPrice: number, mode: "stage" | "push") => void;
  onPush: (rowId: string, platform: string, listingId: string) => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
}

export function EditableStoreBlockGroup({ items, rowId, onSave, onPush, onDiscard }: EditableStoreBlockGroupProps) {
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkCents, setBulkCents] = useState(0);
  const [bulkShowActions, setBulkShowActions] = useState(false);
  const [bulkSourceLabel, setBulkSourceLabel] = useState<string | null>(null);
  const bulkRef = useRef<CurrencyInputHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleBulkValue = useCallback((c: number) => {
    setBulkCents(c);
    setBulkSourceLabel(null);
  }, []);

  function closeBulk() {
    setBulkOpen(false);
    setBulkShowActions(false);
    setBulkSourceLabel(null);
  }

  useEffect(() => {
    if (!bulkOpen) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) closeBulk();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeBulk();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [bulkOpen]);

  function applyBulk(mode: "stage" | "push") {
    const price = bulkCents / 100;
    if (price <= 0) return;
    for (const item of items) {
      onSave(rowId, item.platform, item.listingId, price, mode);
    }
    closeBulk();
  }

  function selectStorePill(item: StoreValue) {
    const price = item.stagedValue != null && item.stagedValue !== item.value
      ? Number(item.stagedValue)
      : Number(item.value);
    const cents = Math.round(price * 100);
    setBulkCents(cents);
    setBulkSourceLabel(PLATFORM_SHORT[item.platform]);
    setBulkShowActions(true);
  }

  const platformCounts = new Map<string, number>();
  for (const it of items) {
    platformCounts.set(it.platform, (platformCounts.get(it.platform) ?? 0) + 1);
  }
  const hasDuplicatePlatforms = [...platformCounts.values()].some((c) => c > 1);

  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-1">
      {items.length > 1 && !bulkOpen && (
        <button
          onClick={() => { setBulkCents(0); setBulkShowActions(false); setBulkSourceLabel(null); setBulkOpen(true); }}
          className="flex w-fit items-center gap-1 rounded-md border border-dashed border-muted-foreground/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground cursor-pointer"
          title="Set same price for all stores"
        >
          <DollarSign className="h-2.5 w-2.5" />
          Set All Stores
        </button>
      )}
      {bulkOpen && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold uppercase text-muted-foreground">Set price for all {items.length} stores</span>
            <button onClick={closeBulk} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" title="Close">
              <X className="h-3 w-3" />
            </button>
          </div>

          {/* Store price pills — copy a store's price to all */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            <span className="text-[9px] text-muted-foreground/70 self-center mr-0.5">Copy from:</span>
            {items.map((item) => {
              const label = PLATFORM_SHORT[item.platform];
              const colorClass = PLATFORM_COLORS[item.platform];
              const price = item.stagedValue != null && item.stagedValue !== item.value
                ? Number(item.stagedValue)
                : Number(item.value);
              const isSelected = bulkSourceLabel === label && bulkCents === Math.round(price * 100);
              return (
                <button
                  key={`pill-${item.platform}-${item.listingId}`}
                  onClick={() => selectStorePill(item)}
                  className={cn(
                    "flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold transition-all cursor-pointer",
                    colorClass,
                    isSelected
                      ? "ring-2 ring-primary shadow-sm"
                      : "hover:ring-1 hover:ring-primary/40"
                  )}
                  title={`Use ${label}'s price ($${price.toFixed(2)}) for all stores`}
                >
                  <PlatformIcon platform={item.platform} className="h-3 w-3 shrink-0" />
                  <span className="font-extrabold uppercase">{label}</span>
                  <span className="text-emerald-400 tabular-nums">${price.toFixed(2)}</span>
                </button>
              );
            })}
          </div>

          {/* Divider */}
          <div className="mt-2 mb-1.5 flex items-center gap-2">
            <div className="h-px flex-1 bg-muted-foreground/15" />
            <span className="text-[9px] text-muted-foreground/50 uppercase">or enter custom</span>
            <div className="h-px flex-1 bg-muted-foreground/15" />
          </div>

          {/* Custom price input */}
          <div className="flex items-center gap-1">
            <CurrencyInput
              ref={bulkRef}
              initialCents={bulkCents}
              onValue={handleBulkValue}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && bulkCents > 0) setBulkShowActions(true);
                if (e.key === "Escape") closeBulk();
              }}
            />
            {!bulkShowActions ? (
              <button
                onClick={() => { if (bulkCents > 0) setBulkShowActions(true); }}
                className={cn(
                  "rounded p-0.5 cursor-pointer",
                  bulkCents > 0 ? "text-emerald-400 hover:text-emerald-300" : "text-muted-foreground/30 cursor-not-allowed"
                )}
                title="Confirm"
                disabled={bulkCents <= 0}
              >
                <Check className="h-3 w-3" />
              </button>
            ) : null}
          </div>

          {/* Stage / Push actions */}
          {bulkShowActions && bulkCents > 0 && (
            <div className="mt-2 flex items-center gap-1.5 border-t border-muted-foreground/10 pt-2">
              <span className="text-[10px] text-muted-foreground tabular-nums font-medium mr-auto">
                ${(bulkCents / 100).toFixed(2)} → all stores
              </span>
              <button
                onClick={() => applyBulk("stage")}
                className="flex items-center gap-0.5 rounded bg-[var(--staged)] px-2 py-1 text-[10px] font-bold text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
                title="Stage this price for all stores"
              >
                Stage All
              </button>
              <button
                onClick={() => applyBulk("push")}
                className="flex items-center gap-0.5 rounded bg-emerald-500 px-2 py-1 text-[10px] font-bold text-white hover:bg-emerald-600 cursor-pointer"
                title="Review the guarded live push flow for all selected stores"
              >
                Review Push
              </button>
            </div>
          )}
        </div>
      )}
      {items.map((item, i) => (
        <EditableStoreBlock
          key={`${item.platform}-${item.listingId}-${i}`}
          item={item}
          rowId={rowId}
          onSave={onSave}
          onPush={onPush}
          onDiscard={onDiscard}
          showItemId={hasDuplicatePlatforms && (platformCounts.get(item.platform) ?? 0) > 1}
        />
      ))}
    </div>
  );
}

/* ──────────────── Editable Ad Rate Store Block ──────────────── */

const NON_AD_RATE_PLATFORMS: string[] = ["SHOPIFY", "BIGCOMMERCE"];

interface EditableAdRateBlockProps {
  item: StoreValue;
  rowId: string;
  onSave: (rowId: string, platform: string, listingId: string, newRate: number, mode: "stage" | "push") => void;
  onPush: (rowId: string, platform: string, listingId: string) => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
  showItemId?: boolean;
}

function EditableAdRateBlock({ item, rowId, onSave, onPush, onDiscard, showItemId = false }: EditableAdRateBlockProps) {
  const label = PLATFORM_SHORT[item.platform];
  const colorClass = PLATFORM_COLORS[item.platform];
  const isNonAdPlatform = NON_AD_RATE_PLATFORMS.includes(item.platform);
  const hasStaged = item.stagedValue != null && item.stagedValue !== item.value;
  const shortItemId = showItemId ? item.listingId.slice(-6) : null;

  const [editing, setEditing] = useState(false);
  const [draftPercent, setDraftPercent] = useState("");
  const [showActions, setShowActions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function fmtPercent(val: number | string | null): string {
    if (val == null) return "N/A";
    return `${(Number(val) * 100).toFixed(1)}%`;
  }

  function normalizePercentInput(raw: string) {
    const cleaned = raw.replace(/[^\d.]/g, "");
    if (!cleaned) return "";

    const match = cleaned.match(/^(\d{0,3})(?:\.(\d{0,1})?)?/);
    if (!match) return "";

    const whole = match[1] ?? "";
    const decimal = match[2];
    if (decimal != null) return `${whole}.${decimal}`;
    return whole;
  }

  function startEdit() {
    if (isNonAdPlatform) return;
    const current = hasStaged ? Number(item.stagedValue) : (item.value != null ? Number(item.value) : 0);
    setDraftPercent((current * 100).toFixed(1));
    setEditing(true);
    setShowActions(false);
  }

  function cancelEdit() {
    setEditing(false);
    setShowActions(false);
  }

  function handleSave(mode: "stage" | "push") {
    const parsed = parseFloat(draftPercent);
    if (isNaN(parsed) || parsed < 0) { cancelEdit(); return; }
    const normalizedPercent = Math.round(parsed * 10) / 10;
    const rate = normalizedPercent / 100;
    onSave(rowId, item.platform, item.listingId, rate, mode);
    setEditing(false);
    setShowActions(false);
  }

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  if (isNonAdPlatform) {
    return (
      <div className={cn("flex w-full items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs opacity-50", colorClass)}>
        <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
        <span className="w-10 shrink-0 text-[10px] font-extrabold uppercase text-foreground">{label}</span>
        <span className="text-muted-foreground font-medium">N/A</span>
      </div>
    );
  }

  if (editing) {
    return (
      <div className={cn("w-full min-w-0 rounded border px-2.5 py-1.5 text-xs", colorClass, "ring-1 ring-ring")}>
        <div className="flex items-center gap-1 mb-1">
          <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
          <div className="shrink-0 flex flex-col items-start">
            <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
            {shortItemId && <span className="text-[8px] font-mono text-muted-foreground/60 leading-none mt-0.5">#{shortItemId}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={draftPercent}
            onChange={(e) => setDraftPercent(normalizePercentInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") setShowActions(true);
              if (e.key === "Escape") cancelEdit();
            }}
            className="w-14 shrink-0 rounded border bg-background px-1.5 py-0.5 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <span className="shrink-0 text-[10px] text-muted-foreground">%</span>
          {!showActions ? (
            <>
              <button onClick={() => setShowActions(true)} className="shrink-0 rounded p-0.5 text-emerald-400 hover:text-emerald-300 cursor-pointer" title="Confirm">
                <Check className="h-3 w-3" />
              </button>
              <button onClick={cancelEdit} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" title="Cancel">
                <X className="h-3 w-3" />
              </button>
            </>
          ) : (
            <div className="flex shrink-0 items-center gap-1">
              <button
                onClick={() => handleSave("stage")}
                className="rounded bg-[var(--staged)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
                title="Stage ad rate to review before pushing"
              >
                Stage
              </button>
              <button
                onClick={() => handleSave("push")}
                className="rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-600 cursor-pointer"
                title="Review the guarded live push flow for this ad rate"
              >
                Review Push
              </button>
              <button onClick={cancelEdit} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" title="Cancel">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/edit flex w-full items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs",
        colorClass,
        hasStaged && "ring-1 ring-[var(--staged)]"
      )}
    >
      <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
      <div className="shrink-0 flex flex-col items-start">
        <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
        {shortItemId && <span className="text-[8px] font-mono text-muted-foreground/60 leading-none mt-0.5" title={`Item ID: ${item.listingId}`}>#{shortItemId}</span>}
      </div>
      <div className="min-w-0 flex-1">
        {hasStaged ? (
          <>
            <span className="flex items-center gap-1 font-semibold leading-tight whitespace-nowrap text-emerald-400">
              {fmtPercent(item.stagedValue!)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-[var(--staged)] px-1 py-px text-[9px] font-bold text-[var(--staged-foreground)]">STAGED</span>
            </span>
            <span className="mt-1 flex items-center gap-1 font-semibold leading-tight whitespace-nowrap text-emerald-400">
              {fmtPercent(item.value)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">LIVE</span>
            </span>
            <div className="mt-1 flex items-center gap-1">
              <button
                onClick={() => onPush(rowId, item.platform, item.listingId)}
                className="flex items-center gap-0.5 rounded bg-emerald-500 px-1.5 py-0.5 text-[10px] font-bold text-white hover:bg-emerald-600 cursor-pointer"
                title="Review the guarded live push flow for this staged ad rate"
              >
                <Upload className="h-2.5 w-2.5" />
                Review Push
              </button>
              <button
                onClick={() => onDiscard(rowId, item.platform, item.listingId)}
                className="flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground cursor-pointer"
                title="Discard staged ad rate and revert to live"
              >
                <Undo2 className="h-2.5 w-2.5" />
                Discard
              </button>
            </div>
          </>
        ) : (
          <span className="font-medium leading-tight text-emerald-400">{fmtPercent(item.value)}</span>
        )}
      </div>
      <button
        onClick={startEdit}
        className="shrink-0 rounded p-0.5 text-muted-foreground/0 transition-all group-hover/edit:text-muted-foreground/60 hover:!text-foreground cursor-pointer"
        title="Edit ad rate"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}

interface EditableAdRateBlockGroupProps {
  items: StoreValue[];
  rowId: string;
  onSave: (rowId: string, platform: string, listingId: string, newRate: number, mode: "stage" | "push") => void;
  onPush: (rowId: string, platform: string, listingId: string) => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
}

export function EditableAdRateBlockGroup({ items, rowId, onSave, onPush, onDiscard }: EditableAdRateBlockGroupProps) {
  if (items.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const platformCounts = new Map<string, number>();
  for (const it of items) {
    platformCounts.set(it.platform, (platformCounts.get(it.platform) ?? 0) + 1);
  }
  const hasDuplicatePlatforms = [...platformCounts.values()].some((c) => c > 1);

  return (
    <div className="flex min-w-0 w-full flex-col gap-1">
      {items.map((item, i) => (
        <EditableAdRateBlock
          key={`${item.platform}-${item.listingId}-${i}`}
          item={item}
          rowId={rowId}
          onSave={onSave}
          onPush={onPush}
          onDiscard={onDiscard}
          showItemId={hasDuplicatePlatforms && (platformCounts.get(item.platform) ?? 0) > 1}
        />
      ))}
    </div>
  );
}
