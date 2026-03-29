"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Copy, Check, Pencil, X, Upload, Undo2, DollarSign, Loader2, AlertTriangle } from "lucide-react";
import { CurrencyInput, type CurrencyInputHandle } from "@/components/grid/cells/currency-input";
import {
  PLATFORM_DISPLAY_ORDER,
  PLATFORM_SHORT,
  PLATFORM_COLORS,
  sortStoreValuesForDisplay,
  type Platform,
  type StoreValue,
} from "@/lib/grid-types";
import { PlatformIcon } from "@/components/grid/platform-icon";

interface StoreBlockProps {
  item: StoreValue;
  format?: "currency" | "percent" | "text" | "link";
  showStaged?: boolean;
  showItemId?: boolean;
  compact?: boolean;
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
      className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground dark:text-muted-foreground/45 dark:hover:text-foreground cursor-pointer"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
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

export function StoreBlock({
  item,
  format = "text",
  showStaged = true,
  showItemId = false,
  compact = false,
}: StoreBlockProps) {
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
        "flex w-full items-center rounded border",
        compact ? "gap-1 px-2 py-1 text-[11px]" : "gap-1.5 px-2.5 py-1.5 text-xs",
        colorClass,
        hasStaged && "ring-1 ring-[var(--staged)]"
      )}
    >
      <PlatformIcon platform={item.platform} className={cn("shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
      <div className="shrink-0 flex flex-col items-start">
        <span className={cn("font-extrabold uppercase text-foreground leading-none", compact ? "w-8 text-[9px]" : "w-10 text-[10px]")}>
          {label}
        </span>
        {shortItemId && (
          <span
            className="text-[8px] font-mono text-foreground/85 dark:text-muted-foreground/70 leading-none mt-0.5"
            title={`Item ID: ${item.listingId}`}
          >
            #{shortItemId}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {hasStaged ? (
          <>
            <span className={cn("flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.stagedValue) ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
              {fmt(item.stagedValue!)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-[var(--staged)] px-1 py-px text-[9px] font-bold text-[var(--staged-foreground)]">
                STAGED
              </span>
            </span>
            <span className={cn("mt-1 flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.value) ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
              {fmt(item.value)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">
                LIVE
              </span>
            </span>
          </>
        ) : (
          <span className={cn("font-medium leading-tight", valNeg ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>{fmt(item.value)}</span>
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
  includeMissingPlatforms?: boolean;
  missingLabel?: string;
  missingLabelsByPlatform?: Partial<Record<Platform, string>>;
  /** How to render slots with no listing row (variation parent vs truly missing) */
  missingPlaceholder?: MissingStorePlaceholder;
  compact?: boolean;
}

/** absent = no marketplace listing; defer-to-children = variation parent (data on expanded rows) */
export type MissingStorePlaceholder = "absent" | "defer-to-children";

function MissingStoreBlock({
  platform,
  missingLabel = "Listing not found",
  compact = false,
  placeholder = "absent",
}: {
  platform: Platform;
  missingLabel?: string;
  compact?: boolean;
  placeholder?: MissingStorePlaceholder;
}) {
  const label = PLATFORM_SHORT[platform];
  const colorClass = PLATFORM_COLORS[platform];
  const deferToChildren = placeholder === "defer-to-children";

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center rounded border",
        deferToChildren ? "border-border/50 bg-muted/5 opacity-90" : "opacity-70",
        compact ? "gap-1 px-2 py-1 text-[11px]" : "gap-1.5 px-2.5 py-1.5 text-xs",
        colorClass,
      )}
    >
      <PlatformIcon platform={platform} className={cn("shrink-0", compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
      <div className="shrink-0 flex flex-col items-start">
        <span className={cn("font-extrabold uppercase text-foreground leading-none", compact ? "w-8 text-[9px]" : "w-10 text-[10px]")}>
          {label}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <span
          className={cn(
            "block font-medium leading-snug text-muted-foreground",
            deferToChildren ? "break-words whitespace-normal" : "truncate",
          )}
          title={missingLabel}
        >
          {missingLabel}
        </span>
      </div>
      {!deferToChildren ? (
        <span className="inline-flex shrink-0 items-center rounded-sm bg-muted px-1 py-px text-[9px] font-bold text-muted-foreground">
          MISS
        </span>
      ) : null}
    </div>
  );
}

function buildDisplayEntries(items: StoreValue[], includeMissingPlatforms: boolean) {
  const sorted = sortStoreValuesForDisplay(items);
  if (!includeMissingPlatforms) {
    return sorted.map((item) => ({ kind: "item" as const, item }));
  }

  const entries: Array<
    | { kind: "item"; item: StoreValue }
    | { kind: "missing"; platform: Platform }
  > = [];

  for (const platform of PLATFORM_DISPLAY_ORDER) {
    const matches = sorted.filter((item) => item.platform === platform);
    if (matches.length === 0) {
      entries.push({ kind: "missing", platform });
      continue;
    }
    for (const item of matches) {
      entries.push({ kind: "item", item });
    }
  }

  return entries;
}

export function StoreBlockGroup({
  items,
  format = "text",
  showStaged = true,
  includeMissingPlatforms = false,
  missingLabel = "Listing not found",
  missingLabelsByPlatform,
  missingPlaceholder = "absent",
  compact = false,
}: StoreBlockGroupProps) {
  if (items.length === 0 && !includeMissingPlatforms) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const platformCounts = new Map<string, number>();
  for (const item of items) {
    platformCounts.set(item.platform, (platformCounts.get(item.platform) ?? 0) + 1);
  }
  const hasDuplicatePlatforms = [...platformCounts.values()].some((c) => c > 1);
  const displayEntries = buildDisplayEntries(items, includeMissingPlatforms);

  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      {displayEntries.map((entry, i) =>
        entry.kind === "item" ? (
          <StoreBlock
            key={`${entry.item.platform}-${entry.item.listingId}-${entry.item.variantId ?? ""}-${i}`}
            item={entry.item}
            format={format}
            showStaged={showStaged}
            showItemId={hasDuplicatePlatforms && (platformCounts.get(entry.item.platform) ?? 0) > 1}
            compact={compact}
          />
        ) : (
          <MissingStoreBlock
            key={`missing-${entry.platform}-${i}`}
            platform={entry.platform}
            missingLabel={missingLabelsByPlatform?.[entry.platform] ?? missingLabel}
            compact={compact}
            placeholder={missingPlaceholder}
          />
        ),
      )}
    </div>
  );
}

/* ──────────────── Editable Sale Price Store Block ──────────────── */

interface EditableStoreBlockProps {
  item: StoreValue;
  rowId: string;
  onSave: (rowId: string, platform: string, listingId: string, newPrice: number, mode: "stage" | "push" | "fastPush", identity?: { variantId?: string; marketplaceListingId?: string | null }) => void;
  onPush: (rowId: string, platform: string, listingId: string, mode?: "review" | "fast") => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
  quickPushState?: QuickPushState;
  failedPushState?: FailedPushState;
  showItemId?: boolean;
}

export type QuickPushPhase =
  | "idle"
  | "dry-run"
  | "ready"
  | "pushing"
  | "success"
  | "error"
  | "blocked";

export interface QuickPushState {
  phase: QuickPushPhase;
  detail?: string;
}

export interface FailedPushState {
  summary: string;
  error: string;
}

function EditableStoreBlock({
  item,
  rowId,
  onSave,
  onPush,
  onDiscard,
  quickPushState,
  failedPushState,
  showItemId = false,
}: EditableStoreBlockProps) {
  const label = PLATFORM_SHORT[item.platform];
  const colorClass = PLATFORM_COLORS[item.platform];
  const hasStaged = item.stagedValue != null && item.stagedValue !== item.value;

  const [editing, setEditing] = useState(false);
  const [draftCents, setDraftCents] = useState(0);
  const [showActions, setShowActions] = useState(false);
  const inputRef = useRef<CurrencyInputHandle>(null);
  const effectiveCents = Math.round(Number(hasStaged ? item.stagedValue : item.value) * 100) || 0;
  const liveCents = Math.round(Number(item.value) * 100) || 0;
  const hasDraftChange = draftCents !== effectiveCents;
  const hasMeaningfulLiveChange = draftCents !== liveCents;

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
    if (e.key === "Enter" && hasDraftChange) setShowActions(true);
  }

  const handleValue = useCallback((c: number) => setDraftCents(c), []);

  const storeIdentity = { variantId: item.variantId, marketplaceListingId: item.marketplaceListingId };

  function confirmStage() {
    const num = draftCents / 100;
    if (num < 0 || !hasDraftChange) {
      cancelEdit();
      return;
    }
    onSave(rowId, item.platform, item.listingId, num, "stage", storeIdentity);
    setEditing(false);
    setShowActions(false);
  }

  function confirmPush() {
    const num = draftCents / 100;
    if (num < 0 || !hasDraftChange) {
      cancelEdit();
      return;
    }
    onSave(rowId, item.platform, item.listingId, num, "push", storeIdentity);
    setEditing(false);
    setShowActions(false);
  }

  function confirmFastPush() {
    const num = draftCents / 100;
    if (num < 0 || !hasDraftChange) {
      cancelEdit();
      return;
    }
    onSave(rowId, item.platform, item.listingId, num, "fastPush", storeIdentity);
    setEditing(false);
    setShowActions(false);
  }

  const displayVal = hasStaged ? fmt(item.stagedValue!) : fmt(item.value);
  const shortItemId = showItemId ? item.listingId.slice(-6) : null;
  const quickPhaseRaw = quickPushState?.phase ?? "idle";
  const quickPhase =
    !hasStaged && (quickPhaseRaw === "error" || quickPhaseRaw === "blocked")
      ? "idle"
      : quickPhaseRaw;
  const fastPushBusy = quickPhase === "dry-run" || quickPhase === "pushing";
  const fastPushSucceeded = quickPhase === "success";
  const fastPushRetry = quickPhase === "error" || quickPhase === "blocked";
  const hasFailedStage = hasStaged && Boolean(failedPushState);

  function renderFastPushLabel() {
    if (quickPhase === "dry-run") {
      return (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking
        </>
      );
    }
    if (quickPhase === "pushing") {
      return (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Pushing
        </>
      );
    }
    if (quickPhase === "success") {
      return (
        <>
          <Check className="h-3 w-3" />
          Pushed
        </>
      );
    }
    if (quickPhase === "error" || quickPhase === "blocked") {
      return (
        <>
          <AlertTriangle className="h-3 w-3" />
          Retry
        </>
      );
    }
    return "Fast Push";
  }

  function renderCompactButtonLabel(text: string) {
    const parts = text.split(" ");
    if (parts.length === 1) return <span>{text}</span>;
    return (
      <span className="flex flex-col items-center leading-[1.05]">
        {parts.map((part) => (
          <span key={part}>{part}</span>
        ))}
      </span>
    );
  }

  if (editing) {
    return (
      <div className={cn("w-full rounded border px-2.5 py-1.5 text-xs", colorClass, "ring-1 ring-ring")}>
        <div className="flex items-center gap-1 mb-1">
          <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
          <div className="shrink-0 flex flex-col items-start">
            <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
            {shortItemId && <span className="text-[8px] font-mono text-foreground/85 dark:text-muted-foreground/70 leading-none mt-0.5" title={`Item ID: ${item.listingId}`}>#{shortItemId}</span>}
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
          <button
            onClick={() => {
              if (hasMeaningfulLiveChange) setShowActions(true);
            }}
            disabled={!hasMeaningfulLiveChange}
            className={cn(
              "rounded p-0.5 cursor-pointer",
              hasMeaningfulLiveChange ? "text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300" : "text-muted-foreground/30 cursor-not-allowed",
            )}
            title="Confirm"
          >
            <Check className="h-3 w-3" />
          </button>
          <button onClick={cancelEdit} className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" title="Cancel">
            <X className="h-3 w-3" />
          </button>
        </div>
        {showActions ? (
          <div className="mt-1.5 grid grid-cols-3 gap-1">
            <button
              onClick={confirmStage}
              className="inline-flex min-w-0 items-center justify-center rounded bg-[var(--staged)] px-1.5 py-1.5 text-[9px] font-bold leading-none text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
              title="Stage value to test profit before pushing"
            >
              {renderCompactButtonLabel("Stage")}
            </button>
            <button
              onClick={confirmPush}
              className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
              title="Review the guarded live push flow for this value"
            >
              {renderCompactButtonLabel("Review Push")}
            </button>
            <button
              onClick={confirmFastPush}
              className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
              title="Run the guarded fast push for this one value"
            >
              {renderCompactButtonLabel("Fast Push")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/edit flex w-full min-w-0 items-start gap-1.5 rounded border px-2.5 py-1.5 text-xs",
        colorClass,
        hasStaged && "ring-1 ring-[var(--staged)]"
      )}
    >
      <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
      <div className="shrink-0 flex flex-col items-start">
        <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
        {shortItemId && <span className="text-[8px] font-mono text-foreground/85 dark:text-muted-foreground/70 leading-none mt-0.5" title={`Item ID: ${item.listingId}`}>#{shortItemId}</span>}
      </div>
      <div className="min-w-0 flex-1 self-stretch">
        {hasStaged ? (
          <>
            <span className={cn("flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.stagedValue) ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
              {fmt(item.stagedValue!)}
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-sm px-1 py-px text-[9px] font-bold",
                  hasFailedStage
                    ? "bg-red-500/90 text-white"
                    : "bg-[var(--staged)] text-[var(--staged-foreground)]",
                )}
                title={hasFailedStage ? failedPushState?.error : "Staged value"}
              >
                {hasFailedStage ? "FAILED" : "STAGED"}
              </span>
            </span>
            <span className={cn("mt-1 flex items-center gap-1 font-semibold leading-tight whitespace-nowrap", isNegative(item.value) ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>
              {fmt(item.value)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">
                LIVE
              </span>
            </span>
            {hasFailedStage ? (
              <div className="mt-1 w-full min-w-0 space-y-0.5">
                <p className="break-words text-[9px] font-medium leading-snug text-red-600 dark:text-red-300">
                  {failedPushState?.summary ?? "Fast push failed"}
                </p>
                {failedPushState?.error ? (
                  <p className="break-words text-[8px] leading-snug text-red-600/85 dark:text-red-300/85">{failedPushState.error}</p>
                ) : null}
              </div>
            ) : null}
            {quickPhase !== "idle" ? (
              <div className="mt-1 w-full min-w-0 space-y-1">
                {fastPushRetry ? (
                  <button
                    type="button"
                    onClick={() => onPush(rowId, item.platform, item.listingId, "fast")}
                    className={cn(
                      "inline-flex min-w-[88px] items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                      "bg-amber-500 hover:bg-amber-600 cursor-pointer",
                    )}
                    title={quickPushState?.detail ?? "Retry fast push"}
                  >
                    {renderFastPushLabel()}
                  </button>
                ) : (
                  <div
                    className={cn(
                      "inline-flex min-w-[88px] items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                      fastPushSucceeded ? "bg-emerald-500" : "bg-blue-500",
                    )}
                    title={quickPushState?.detail ?? undefined}
                  >
                    {renderFastPushLabel()}
                  </div>
                )}
                {fastPushRetry && quickPushState?.detail ? (
                  <p className="break-words text-[9px] leading-snug text-red-600/90 dark:text-red-300/90">{quickPushState.detail}</p>
                ) : null}
              </div>
            ) : (
              <div className="mt-1 grid grid-cols-2 gap-1">
                <button
                  onClick={() => onPush(rowId, item.platform, item.listingId, "review")}
                  className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
                  title="Review the guarded live push flow for this staged price"
                >
                  {renderCompactButtonLabel("Review Push")}
                </button>
                <button
                  onClick={() => onPush(rowId, item.platform, item.listingId, "fast")}
                  className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
                  title="Run the guarded fast push for this staged price"
                >
                  {renderCompactButtonLabel("Fast Push")}
                </button>
                <button
                  onClick={() => onDiscard(rowId, item.platform, item.listingId)}
                  className="col-span-2 inline-flex min-w-0 items-center justify-center rounded bg-muted px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Discard staged price and revert to live"
                >
                  {renderCompactButtonLabel("Discard")}
                </button>
              </div>
            )}
          </>
        ) : quickPhase !== "idle" ? (
          <div className="flex w-full min-w-0 flex-col items-stretch gap-1">
            <span className={cn("font-medium leading-tight", isNegative(item.value) ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>{fmt(item.value)}</span>
            {fastPushRetry ? (
              <button
                type="button"
                onClick={() => onPush(rowId, item.platform, item.listingId, "fast")}
                className={cn(
                  "inline-flex min-w-[72px] max-w-full items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                  "bg-amber-500 hover:bg-amber-600 cursor-pointer",
                )}
                title={quickPushState?.detail ?? "Retry fast push"}
              >
                {renderFastPushLabel()}
              </button>
            ) : (
              <div
                className={cn(
                  "inline-flex min-w-[72px] items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                  fastPushSucceeded ? "bg-emerald-500" : "bg-blue-500",
                )}
                title={quickPushState?.detail ?? undefined}
              >
                {renderFastPushLabel()}
              </div>
            )}
            {fastPushRetry && quickPushState?.detail ? (
              <p className="break-words text-[8px] leading-snug text-red-600/90 dark:text-red-300/90">{quickPushState.detail}</p>
            ) : null}
          </div>
        ) : (
          <span className={cn("font-medium leading-tight", isNegative(item.value) ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400")}>{fmt(item.value)}</span>
        )}
      </div>
      <button
        onClick={startEdit}
        className="shrink-0 rounded p-0.5 text-muted-foreground/65 transition-colors group-hover/edit:text-foreground dark:text-transparent dark:group-hover/edit:text-muted-foreground/75 hover:!text-foreground cursor-pointer"
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
  onSave: (rowId: string, platform: string, listingId: string, newPrice: number, mode: "stage" | "push" | "fastPush", identity?: { variantId?: string; marketplaceListingId?: string | null }) => void;
  onBulkSave?: (rowId: string, newPrice: number, mode: "stage" | "push") => void;
  onPush: (rowId: string, platform: string, listingId: string, mode?: "review" | "fast") => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
  quickPushStates?: Record<string, QuickPushState>;
  failedPushStates?: Record<string, FailedPushState | undefined>;
  includeMissingPlatforms?: boolean;
  missingLabel?: string;
  missingPlaceholder?: MissingStorePlaceholder;
}

export function EditableStoreBlockGroup({
  items,
  rowId,
  onSave,
  onBulkSave,
  onPush,
  onDiscard,
  quickPushStates,
  failedPushStates,
  includeMissingPlatforms = false,
  missingLabel = "Listing not found",
  missingPlaceholder = "absent",
}: EditableStoreBlockGroupProps) {
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
    if (onBulkSave) {
      onBulkSave(rowId, price, mode);
      closeBulk();
      return;
    }
    for (const item of items) {
      onSave(rowId, item.platform, item.listingId, price, mode, { variantId: item.variantId, marketplaceListingId: item.marketplaceListingId });
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
  const displayEntries = buildDisplayEntries(items, includeMissingPlatforms);

  if (items.length === 0 && !includeMissingPlatforms) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div ref={containerRef} className="flex w-full min-w-0 flex-col gap-1">
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
                  <span className="text-emerald-700 dark:text-emerald-400 tabular-nums">${price.toFixed(2)}</span>
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
                  bulkCents > 0 ? "text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300" : "text-muted-foreground/30 cursor-not-allowed"
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
      {displayEntries.map((entry, i) =>
        entry.kind === "item" ? (
          <EditableStoreBlock
            key={`${entry.item.platform}-${entry.item.listingId}-${entry.item.variantId ?? ""}-${i}`}
            item={entry.item}
            rowId={rowId}
            onSave={onSave}
            onPush={onPush}
            onDiscard={onDiscard}
            quickPushState={quickPushStates?.[`${rowId}:${entry.item.platform}:${entry.item.listingId}:salePrice`]}
            failedPushState={failedPushStates?.[`${rowId}:${entry.item.platform}:${entry.item.listingId}:salePrice`]}
            showItemId={hasDuplicatePlatforms && (platformCounts.get(entry.item.platform) ?? 0) > 1}
          />
        ) : (
          <MissingStoreBlock
            key={`missing-${entry.platform}-${i}`}
            platform={entry.platform}
            missingLabel={missingLabel}
            placeholder={missingPlaceholder}
          />
        ),
      )}
    </div>
  );
}

/* ──────────────── Editable Ad Rate Store Block ──────────────── */

const NON_AD_RATE_PLATFORMS: string[] = ["SHOPIFY", "BIGCOMMERCE"];

interface EditableAdRateBlockProps {
  item: StoreValue;
  rowId: string;
  onSave: (rowId: string, platform: string, listingId: string, newRate: number, mode: "stage" | "push" | "fastPush", identity?: { variantId?: string; marketplaceListingId?: string | null }) => void;
  onPush: (rowId: string, platform: string, listingId: string, mode?: "review" | "fast") => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
  quickPushState?: QuickPushState;
  failedPushState?: FailedPushState;
  showItemId?: boolean;
}

function EditableAdRateBlock({
  item,
  rowId,
  onSave,
  onPush,
  onDiscard,
  quickPushState,
  failedPushState,
  showItemId = false,
}: EditableAdRateBlockProps) {
  const label = PLATFORM_SHORT[item.platform];
  const colorClass = PLATFORM_COLORS[item.platform];
  const isNonAdPlatform = NON_AD_RATE_PLATFORMS.includes(item.platform);
  const hasStaged = item.stagedValue != null && item.stagedValue !== item.value;
  const shortItemId = showItemId ? item.listingId.slice(-6) : null;

  const [editing, setEditing] = useState(false);
  const [draftPercent, setDraftPercent] = useState("");
  const [showActions, setShowActions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const livePercentValue = Math.round((item.value != null ? Number(item.value) : 0) * 1000) / 10;
  const effectivePercentValue = Math.round((hasStaged ? Number(item.stagedValue) : (item.value != null ? Number(item.value) : 0)) * 1000) / 10;
  const quickPhaseRaw = quickPushState?.phase ?? "idle";
  const quickPhase =
    !hasStaged && (quickPhaseRaw === "error" || quickPhaseRaw === "blocked")
      ? "idle"
      : quickPhaseRaw;
  const fastPushSucceeded = quickPhase === "success";
  const fastPushRetry = quickPhase === "error" || quickPhase === "blocked";
  const hasFailedStage = hasStaged && Boolean(failedPushState);

  function renderFastPushLabel() {
    if (quickPhase === "dry-run") {
      return (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Checking
        </>
      );
    }
    if (quickPhase === "pushing") {
      return (
        <>
          <Loader2 className="h-3 w-3 animate-spin" />
          Pushing
        </>
      );
    }
    if (quickPhase === "success") {
      return (
        <>
          <Check className="h-3 w-3" />
          Pushed
        </>
      );
    }
    if (quickPhase === "error" || quickPhase === "blocked") {
      return (
        <>
          <AlertTriangle className="h-3 w-3" />
          Retry
        </>
      );
    }
    return "Fast Push";
  }

  function renderCompactButtonLabel(text: string) {
    const parts = text.split(" ");
    if (parts.length === 1) return <span>{text}</span>;
    return (
      <span className="flex flex-col items-center leading-[1.05]">
        {parts.map((part) => (
          <span key={part}>{part}</span>
        ))}
      </span>
    );
  }

  function fmtPercent(val: number | string | null): string {
    // null means the rate hasn't been synced yet; treat as 0% rather than N/A
    // (N/A is reserved for platforms that don't support ad rates, e.g. SHPFY/BC,
    // which take a completely separate render path via isNonAdPlatform).
    return `${(Number(val ?? 0) * 100).toFixed(1)}%`;
  }

  function normalizePercentInput(raw: string) {
    const cleaned = raw.replace(/[^\d.]/g, "");
    if (!cleaned) return "";

    const firstDecimalIndex = cleaned.indexOf(".");
    const normalizedText =
      firstDecimalIndex === -1
        ? cleaned
        : `${cleaned.slice(0, firstDecimalIndex)}.${cleaned
            .slice(firstDecimalIndex + 1)
            .replace(/\./g, "")}`;

    if (normalizedText === ".") return "0.";

    if (/^\d+\.$/.test(normalizedText)) {
      const wholeNumber = Number.parseInt(normalizedText.slice(0, -1), 10);
      if (Number.isNaN(wholeNumber)) return "";
      return wholeNumber >= 100 ? "100.0" : normalizedText;
    }

    const parsed = Number.parseFloat(normalizedText);
    if (!Number.isFinite(parsed)) return "";

    const clamped = Math.min(Math.max(parsed, 0), 100);
    const hasExplicitDecimal = normalizedText.includes(".");
    const rawDecimals = normalizedText.split(".")[1] ?? "";

    if (hasExplicitDecimal && rawDecimals.length > 1) {
      return clamped.toFixed(1);
    }

    if (hasExplicitDecimal && rawDecimals.length === 1) {
      if (clamped === 100) return "100.0";
      return `${Math.trunc(clamped)}.${rawDecimals}`;
    }

    return clamped === 100 ? "100" : `${Math.trunc(clamped)}`;
  }

  function parseDraftPercentValue(value: string) {
    if (!value || value.endsWith(".")) return null;
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < 0 || parsed > 100) return null;
    return Math.round(parsed * 10) / 10;
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

  const adRateIdentity = { variantId: item.variantId, marketplaceListingId: item.marketplaceListingId };

  function handleSave(mode: "stage" | "push") {
    const normalizedPercent = parseDraftPercentValue(draftPercent);
    if (normalizedPercent == null || normalizedPercent === effectivePercentValue) {
      cancelEdit();
      return;
    }
    const rate = normalizedPercent / 100;
    onSave(rowId, item.platform, item.listingId, rate, mode, adRateIdentity);
    setEditing(false);
    setShowActions(false);
  }

  function handleFastPush() {
    const normalizedPercent = parseDraftPercentValue(draftPercent);
    if (normalizedPercent == null || normalizedPercent === effectivePercentValue) {
      cancelEdit();
      return;
    }
    const rate = normalizedPercent / 100;
    onSave(rowId, item.platform, item.listingId, rate, "fastPush", adRateIdentity);
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
    const parsedDraftPercent = parseDraftPercentValue(draftPercent);
    const hasDraftChange = parsedDraftPercent != null && parsedDraftPercent !== effectivePercentValue;
    const hasMeaningfulLiveChange = parsedDraftPercent != null && parsedDraftPercent !== livePercentValue;

    return (
      <div className={cn("relative z-10 w-full min-w-0 rounded border px-2.5 py-1.5 text-xs", colorClass, "ring-1 ring-ring")}>
        <div className="flex items-center gap-1 mb-1">
          <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
          <div className="shrink-0 flex flex-col items-start">
            <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
            {shortItemId && <span className="text-[8px] font-mono text-foreground/85 dark:text-muted-foreground/70 leading-none mt-0.5">#{shortItemId}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={draftPercent}
            onChange={(e) => setDraftPercent(normalizePercentInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hasMeaningfulLiveChange) setShowActions(true);
              if (e.key === "Escape") cancelEdit();
            }}
            maxLength={5}
            className="w-16 shrink-0 rounded border bg-background px-1.5 py-0.5 text-xs font-mono text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
          <span className="shrink-0 text-[10px] text-muted-foreground">%</span>
          <button
            onClick={() => {
              if (hasMeaningfulLiveChange) setShowActions(true);
            }}
            disabled={!hasMeaningfulLiveChange}
            className={cn(
              "shrink-0 rounded p-0.5 cursor-pointer",
              hasMeaningfulLiveChange ? "text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300" : "text-muted-foreground/30 cursor-not-allowed",
            )}
            title="Confirm"
          >
            <Check className="h-3 w-3" />
          </button>
          <button onClick={cancelEdit} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer" title="Cancel">
            <X className="h-3 w-3" />
          </button>
        </div>
        {showActions ? (
          <div className="mt-1.5 grid grid-cols-3 gap-1">
            <button
              onClick={() => {
                if (hasDraftChange) handleSave("stage");
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-[var(--staged)] px-1.5 py-1.5 text-[9px] font-bold leading-none text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
              title="Stage ad rate to review before pushing"
            >
              {renderCompactButtonLabel("Stage")}
            </button>
            <button
              onClick={() => {
                if (hasDraftChange) handleSave("push");
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
              title="Review the guarded live push flow for this ad rate"
            >
              {renderCompactButtonLabel("Review Push")}
            </button>
            <button
              onClick={() => {
                if (hasDraftChange) handleFastPush();
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
              title="Run the guarded fast push for this one ad rate"
            >
              {renderCompactButtonLabel("Fast Push")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/edit flex w-full min-w-0 items-start gap-1.5 rounded border px-2.5 py-1.5 text-xs",
        colorClass,
        hasStaged && "ring-1 ring-[var(--staged)]"
      )}
    >
      <PlatformIcon platform={item.platform} className="h-3.5 w-3.5 shrink-0" />
      <div className="shrink-0 flex flex-col items-start">
        <span className="w-10 text-[10px] font-extrabold uppercase text-foreground leading-none">{label}</span>
        {shortItemId && <span className="text-[8px] font-mono text-foreground/85 dark:text-muted-foreground/70 leading-none mt-0.5" title={`Item ID: ${item.listingId}`}>#{shortItemId}</span>}
      </div>
      <div className="min-w-0 flex-1 self-stretch">
        {hasStaged ? (
          <>
            <span className="flex items-center gap-1 font-semibold leading-tight whitespace-nowrap text-emerald-700 dark:text-emerald-400">
              {fmtPercent(item.stagedValue!)}
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-sm px-1 py-px text-[9px] font-bold",
                  hasFailedStage
                    ? "bg-red-500/90 text-white"
                    : "bg-[var(--staged)] text-[var(--staged-foreground)]",
                )}
                title={hasFailedStage ? failedPushState?.error : "Staged value"}
              >
                {hasFailedStage ? "FAILED" : "STAGED"}
              </span>
            </span>
            <span className="mt-1 flex items-center gap-1 font-semibold leading-tight whitespace-nowrap text-emerald-700 dark:text-emerald-400">
              {fmtPercent(item.value)}
              <span className="inline-flex shrink-0 items-center rounded-sm bg-emerald-500 px-1 py-px text-[9px] font-bold text-white">LIVE</span>
            </span>
            {hasFailedStage ? (
              <div className="mt-1 w-full min-w-0 space-y-0.5">
                <p className="break-words text-[9px] font-medium leading-snug text-red-600 dark:text-red-300">
                  {failedPushState?.summary ?? "Fast push failed"}
                </p>
                {failedPushState?.error ? (
                  <p className="break-words text-[8px] leading-snug text-red-600/85 dark:text-red-300/85">{failedPushState.error}</p>
                ) : null}
              </div>
            ) : null}
            {quickPhase !== "idle" ? (
              <div className="mt-1 w-full min-w-0 space-y-1">
                {fastPushRetry ? (
                  <button
                    type="button"
                    onClick={() => onPush(rowId, item.platform, item.listingId, "fast")}
                    className={cn(
                      "inline-flex min-w-[88px] items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                      "bg-amber-500 hover:bg-amber-600 cursor-pointer",
                    )}
                    title={quickPushState?.detail ?? "Retry fast push"}
                  >
                    {renderFastPushLabel()}
                  </button>
                ) : (
                  <div
                    className={cn(
                      "inline-flex min-w-[88px] items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                      fastPushSucceeded ? "bg-emerald-500" : "bg-blue-500",
                    )}
                    title={quickPushState?.detail ?? undefined}
                  >
                    {renderFastPushLabel()}
                  </div>
                )}
                {fastPushRetry && quickPushState?.detail ? (
                  <p className="break-words text-[9px] leading-snug text-red-600/90 dark:text-red-300/90">{quickPushState.detail}</p>
                ) : null}
              </div>
            ) : (
              <div className="mt-1 grid grid-cols-2 gap-1">
                <button
                  onClick={() => onPush(rowId, item.platform, item.listingId, "review")}
                  className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
                  title="Review the guarded live push flow for this staged ad rate"
                >
                  {renderCompactButtonLabel("Review Push")}
                </button>
                <button
                  onClick={() => onPush(rowId, item.platform, item.listingId, "fast")}
                  className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
                  title="Run the guarded fast push for this staged ad rate"
                >
                  {renderCompactButtonLabel("Fast Push")}
                </button>
                <button
                  onClick={() => onDiscard(rowId, item.platform, item.listingId)}
                  className="col-span-2 inline-flex min-w-0 items-center justify-center rounded bg-muted px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground hover:text-foreground cursor-pointer"
                  title="Discard staged ad rate and revert to live"
                >
                  {renderCompactButtonLabel("Discard")}
                </button>
              </div>
            )}
          </>
        ) : quickPhase !== "idle" ? (
          <div className="flex w-full min-w-0 flex-col items-stretch gap-1">
            <span className="font-medium leading-tight text-emerald-700 dark:text-emerald-400">{fmtPercent(item.value)}</span>
            {fastPushRetry ? (
              <button
                type="button"
                onClick={() => onPush(rowId, item.platform, item.listingId, "fast")}
                className={cn(
                  "inline-flex min-w-[72px] max-w-full items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                  "bg-amber-500 hover:bg-amber-600 cursor-pointer",
                )}
                title={quickPushState?.detail ?? "Retry fast push"}
              >
                {renderFastPushLabel()}
              </button>
            ) : (
              <div
                className={cn(
                  "inline-flex min-w-[72px] items-center justify-center gap-1 rounded px-2 py-1.5 text-[10px] font-bold leading-none text-white",
                  fastPushSucceeded ? "bg-emerald-500" : "bg-blue-500",
                )}
                title={quickPushState?.detail ?? undefined}
              >
                {renderFastPushLabel()}
              </div>
            )}
            {fastPushRetry && quickPushState?.detail ? (
              <p className="break-words text-[8px] leading-snug text-red-600/90 dark:text-red-300/90">{quickPushState.detail}</p>
            ) : null}
          </div>
        ) : (
          <span className="font-medium leading-tight text-emerald-700 dark:text-emerald-400">{fmtPercent(item.value)}</span>
        )}
      </div>
      <button
        onClick={startEdit}
        className="shrink-0 rounded p-0.5 text-muted-foreground/65 transition-colors group-hover/edit:text-foreground dark:text-transparent dark:group-hover/edit:text-muted-foreground/75 hover:!text-foreground cursor-pointer"
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
  onSave: (rowId: string, platform: string, listingId: string, newRate: number, mode: "stage" | "push" | "fastPush", identity?: { variantId?: string; marketplaceListingId?: string | null }) => void;
  onPush: (rowId: string, platform: string, listingId: string, mode?: "review" | "fast") => void;
  onDiscard: (rowId: string, platform: string, listingId: string) => void;
  quickPushStates?: Record<string, QuickPushState>;
  failedPushStates?: Record<string, FailedPushState | undefined>;
  includeMissingPlatforms?: boolean;
  missingLabel?: string;
  missingLabelsByPlatform?: Partial<Record<Platform, string>>;
  missingPlaceholder?: MissingStorePlaceholder;
}

export function EditableAdRateBlockGroup({
  items,
  rowId,
  onSave,
  onPush,
  onDiscard,
  quickPushStates,
  failedPushStates,
  includeMissingPlatforms = false,
  missingLabel = "Listing not found",
  missingLabelsByPlatform,
  missingPlaceholder = "absent",
}: EditableAdRateBlockGroupProps) {
  if (items.length === 0 && !includeMissingPlatforms) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const platformCounts = new Map<string, number>();
  for (const it of items) {
    platformCounts.set(it.platform, (platformCounts.get(it.platform) ?? 0) + 1);
  }
  const hasDuplicatePlatforms = [...platformCounts.values()].some((c) => c > 1);
  const displayEntries = buildDisplayEntries(items, includeMissingPlatforms);

  return (
    <div className="flex min-w-0 w-full flex-col gap-1">
      {displayEntries.map((entry, i) =>
        entry.kind === "item" ? (
          <EditableAdRateBlock
            key={`${entry.item.platform}-${entry.item.listingId}-${entry.item.variantId ?? ""}-${i}`}
            item={entry.item}
            rowId={rowId}
            onSave={onSave}
            onPush={onPush}
            onDiscard={onDiscard}
            quickPushState={quickPushStates?.[`${rowId}:${entry.item.platform}:${entry.item.listingId}:adRate`]}
            failedPushState={failedPushStates?.[`${rowId}:${entry.item.platform}:${entry.item.listingId}:adRate`]}
            showItemId={hasDuplicatePlatforms && (platformCounts.get(entry.item.platform) ?? 0) > 1}
          />
        ) : (
          <MissingStoreBlock
            key={`missing-${entry.platform}-${i}`}
            platform={entry.platform}
            missingLabel={missingLabelsByPlatform?.[entry.platform] ?? missingLabel}
            placeholder={missingPlaceholder}
          />
        ),
      )}
    </div>
  );
}
