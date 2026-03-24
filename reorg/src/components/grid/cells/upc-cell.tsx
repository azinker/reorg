"use client";

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { AlertTriangle, Check, Copy, Loader2, Lock, X } from "lucide-react";
import { copySvgElementImage } from "@/lib/client-clipboard";
import { PlatformIcon } from "@/components/grid/platform-icon";
import { PLATFORM_COLORS, type Platform } from "@/lib/grid-types";
import { GRID_INTERACTION_EVENT } from "@/lib/grid-interaction-lock";
import { cn } from "@/lib/utils";

type LiveUpcLine =
  | {
      kind: "all";
      label: string;
      value: string;
      state?: "live";
    }
  | {
      kind: "platform";
      platform: Platform;
      label: string;
      value: string | null;
      state: "live" | "missing" | "pending_refresh" | "not_found";
    };

export type LiveUpcChoice = {
  platform: Platform;
  label: string;
  value: string | null;
  editable: boolean;
  state?: "live" | "missing" | "pending_refresh" | "not_found";
};

const upcLiveCache = new Map<string, { expiresAt: number; value: LiveUpcLine[] }>();
const upcLiveInflight = new Map<
  string,
  Promise<{ lines: LiveUpcLine[]; choices: LiveUpcChoice[] }>
>();
const upcChoiceCache = new Map<string, { expiresAt: number; value: LiveUpcChoice[] }>();
const upcUiStateCache = new Map<
  string,
  {
    editing: boolean;
    draft: string;
    showActions: boolean;
    selectorMode: "review" | "fast" | "edit" | "match" | null;
    forceSingleSourceMatch: boolean;
    selectedTarget: { platform: string; listingId: string } | null;
    dismissedPlatforms: string[];
  }
>();

const PLATFORM_TEXT_COLORS: Record<Platform, string> = {
  TPP_EBAY: "text-blue-400",
  TT_EBAY: "text-emerald-400",
  BIGCOMMERCE: "text-orange-400",
  SHOPIFY: "text-lime-400",
};

const PLATFORM_INPUT_BORDERS: Record<Platform, string> = {
  TPP_EBAY: "border-blue-500/50 focus:ring-blue-500/50",
  TT_EBAY: "border-emerald-500/50 focus:ring-emerald-500/50",
  BIGCOMMERCE: "border-orange-500/50 focus:ring-orange-500/50",
  SHOPIFY: "border-lime-500/50 focus:ring-lime-500/50",
};

type UpcQuickPushPhase =
  | "idle"
  | "dry-run"
  | "ready"
  | "pushing"
  | "success"
  | "error"
  | "blocked";

interface UpcCellProps {
  rowId: string;
  upc: string | null;
  liveFetchRevision?: number;
  disableLiveFetch?: boolean;
  stagedUpc?: string | null;
  editable?: boolean;
  canPush?: boolean;
  pushTargets?: Array<{
    platform: string;
    label: string;
    listingId: string;
    stagedChangeId?: string | null;
  }>;
  quickPushState?: {
    phase: UpcQuickPushPhase;
    detail?: string;
  };
  failedPushTargets?: Record<string, { summary: string; error: string } | undefined>;
  onSave?: (
    value: string,
    mode: "stage" | "push" | "fastPush",
    target?: { platform: string; listingId: string; currentValue?: string | null },
  ) => void;
  onReviewPush?: () => void;
  onFastPush?: () => void;
  onReviewPushTarget?: (platform: string, listingId: string) => void;
  onFastPushTarget?: (platform: string, listingId: string) => void;
  onDiscard?: () => void;
  onDiscardTarget?: (platform: string, listingId: string) => void;
  onMatchUpc?: (
    choices: LiveUpcChoice[],
    mode: "stage" | "push" | "fastPush",
    options?: { allowSingleSource?: boolean },
  ) => void;
}

function CopyNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="absolute -top-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-0.5 text-[10px] font-medium text-background shadow-lg">
      Copied!
    </span>
  );
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

function getLiveUpcText(line: LiveUpcLine): string {
  if (line.value) {
    return line.value;
  }
  if (line.kind === "platform" && line.state === "pending_refresh") {
    return "Waiting on eBay detail";
  }
  if (line.kind === "platform" && line.state === "not_found") {
    return "Listing not found";
  }
  return "No UPC";
}

function getLiveUpcBadge(line: LiveUpcLine): string {
  if (line.value) {
    return "LIVE";
  }
  if (line.kind === "platform" && line.state === "pending_refresh") {
    return "WAIT";
  }
  if (line.kind === "platform" && line.state === "not_found") {
    return "MISS";
  }
  return "NONE";
}

export function UpcCell({
  rowId,
  upc,
  liveFetchRevision = 0,
  disableLiveFetch = false,
  stagedUpc = null,
  editable = false,
  canPush = false,
  pushTargets = [],
  quickPushState,
  failedPushTargets = {},
  onSave,
  onReviewPush,
  onFastPush,
  onReviewPushTarget,
  onFastPushTarget,
  onDiscard,
  onDiscardTarget,
  onMatchUpc,
}: UpcCellProps) {
  const cachedUiState = upcUiStateCache.get(rowId);
  const svgRef = useRef<SVGSVGElement>(null);
  const [copied, setCopied] = useState(false);
  const [imageCopied, setImageCopied] = useState(false);
  const [editing, setEditing] = useState(cachedUiState?.editing ?? false);
  const [draft, setDraft] = useState(cachedUiState?.draft ?? "");
  const [showActions, setShowActions] = useState(cachedUiState?.showActions ?? false);
  const [selectorMode, setSelectorMode] = useState<"review" | "fast" | "edit" | "match" | null>(
    cachedUiState?.selectorMode ?? null,
  );
  const [forceSingleSourceMatch, setForceSingleSourceMatch] = useState(
    cachedUiState?.forceSingleSourceMatch ?? false,
  );
  const [dismissedPlatforms, setDismissedPlatforms] = useState<string[]>(cachedUiState?.dismissedPlatforms ?? []);
  const [liveLines, setLiveLines] = useState<LiveUpcLine[]>([]);
  const [liveChoices, setLiveChoices] = useState<LiveUpcChoice[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<{ platform: string; listingId: string } | null>(
    cachedUiState?.selectedTarget ?? null,
  );
  const quickPhase = quickPushState?.phase ?? "idle";
  const canUseStoredUpcFallback = disableLiveFetch;
  const firstLiveValue = liveLines.find((line) => line.value)?.value ?? null;
  const displayedUpc = stagedUpc ?? firstLiveValue ?? (canUseStoredUpcFallback ? upc : null);
  const effectiveUpc = stagedUpc ?? firstLiveValue ?? (canUseStoredUpcFallback ? upc ?? "" : "");
  const hasMultipleTargets = pushTargets.length > 1;
  const interactionActive = editing || selectorMode !== null || showActions;

  useEffect(() => {
    upcUiStateCache.set(rowId, {
      editing,
      draft,
      showActions,
      selectorMode,
      forceSingleSourceMatch,
      selectedTarget,
      dismissedPlatforms,
    });
  }, [dismissedPlatforms, draft, editing, forceSingleSourceMatch, rowId, selectedTarget, selectorMode, showActions]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const sourceId = `upc:${rowId}`;
    window.dispatchEvent(
      new CustomEvent(GRID_INTERACTION_EVENT, {
        detail: { sourceId, active: interactionActive },
      }),
    );

    return () => {
      window.dispatchEvent(
        new CustomEvent(GRID_INTERACTION_EVENT, {
          detail: { sourceId, active: false },
        }),
      );
    };
  }, [interactionActive, rowId]);

  useEffect(() => {
    if (disableLiveFetch) {
      setLiveLines([]);
      setLiveChoices([]);
      return;
    }
    let active = true;
    const cached = upcLiveCache.get(rowId);
    const cachedChoices = upcChoiceCache.get(rowId);
    if (cached && cached.expiresAt > Date.now() && cachedChoices && cachedChoices.expiresAt > Date.now()) {
      setLiveLines(cached.value);
      setLiveChoices(cachedChoices.value);
      return;
    }

    const existing = upcLiveInflight.get(rowId);
    const request =
      existing ??
      fetch(`/api/grid/${rowId}/upc-live`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Failed to load live UPCs: ${response.status}`);
          }
          const payload = (await response.json()) as { data?: { lines?: LiveUpcLine[]; choices?: LiveUpcChoice[] } };
          const lines = payload.data?.lines ?? [];
          const choices = payload.data?.choices ?? [];
          upcLiveCache.set(rowId, {
            expiresAt: Date.now() + 60_000,
            value: lines,
          });
          upcChoiceCache.set(rowId, {
            expiresAt: Date.now() + 60_000,
            value: choices,
          });
          return { lines, choices };
        })
        .finally(() => {
          upcLiveInflight.delete(rowId);
        });

    if (!existing) {
      upcLiveInflight.set(rowId, request);
    }

    void request
      .then(({ lines, choices }) => {
        if (active) {
          setLiveLines(lines);
          setLiveChoices(choices);
        }
      })
      .catch((error) => {
        console.error("[upc-cell] failed to load live UPC lines", error);
      });

    return () => {
      active = false;
    };
  }, [disableLiveFetch, rowId]);

  useEffect(() => {
    if (disableLiveFetch) return;
    if (quickPhase === "success") {
      upcLiveCache.delete(rowId);
      upcChoiceCache.delete(rowId);
      void fetch(`/api/grid/${rowId}/upc-live`, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return [];
          const payload = (await response.json()) as { data?: { lines?: LiveUpcLine[]; choices?: LiveUpcChoice[] } };
          const lines = payload.data?.lines ?? [];
          const choices = payload.data?.choices ?? [];
          upcLiveCache.set(rowId, {
            expiresAt: Date.now() + 60_000,
            value: lines,
          });
          upcChoiceCache.set(rowId, {
            expiresAt: Date.now() + 60_000,
            value: choices,
          });
          setLiveLines(lines);
          setLiveChoices(choices);
          return lines;
        })
        .catch((error) => {
          console.error("[upc-cell] failed to refresh live UPC lines", error);
        });
    }
  }, [disableLiveFetch, quickPhase, rowId]);

  useEffect(() => {
    if (!stagedUpc) {
      setSelectorMode(null);
      setForceSingleSourceMatch(false);
      setSelectedTarget(null);
      setDismissedPlatforms([]);
    }
  }, [stagedUpc]);

  useEffect(() => {
    if (quickPhase === "success") {
      setSelectorMode(null);
    }
  }, [quickPhase]);

  useEffect(() => {
    if (disableLiveFetch) return;
    if (!upc && !stagedUpc) return;
    upcLiveCache.delete(rowId);
    upcChoiceCache.delete(rowId);
    let active = true;
    void fetch(`/api/grid/${rowId}/upc-live`)
      .then(async (response) => {
        if (!response.ok) return null;
        const payload = (await response.json()) as { data?: { lines?: LiveUpcLine[]; choices?: LiveUpcChoice[] } };
        const lines = payload.data?.lines ?? [];
        const choices = payload.data?.choices ?? [];
        upcLiveCache.set(rowId, { expiresAt: Date.now() + 60_000, value: lines });
        upcChoiceCache.set(rowId, { expiresAt: Date.now() + 60_000, value: choices });
        if (active) {
          setLiveLines(lines);
          setLiveChoices(choices);
        }
        return null;
      })
      .catch(() => null);
    return () => {
      active = false;
    };
  }, [disableLiveFetch, liveFetchRevision, rowId, stagedUpc, upc]);

  useEffect(() => {
    if (editing) return;
    if (!svgRef.current) return;

    if (!displayedUpc) {
      const svg = svgRef.current;
      svg.setAttribute("viewBox", "0 0 160 55");
      svg.innerHTML = `
        <rect width="160" height="55" fill="transparent"/>
        <line x1="10" y1="28" x2="150" y2="28" stroke="currentColor" stroke-width="1.5" opacity="0.3"/>
        <text x="80" y="22" text-anchor="middle" fill="currentColor" font-size="12" font-family="monospace" opacity="0.5">NO UPC</text>
        <text x="80" y="42" text-anchor="middle" fill="currentColor" font-size="9" font-family="monospace" opacity="0.35">AVAILABLE</text>
      `;
      return;
    }

    const opts = {
      width: 1.8,
      height: 48,
      displayValue: false,
      margin: 4,
      background: "transparent",
      lineColor: "currentColor",
    };

    let format = "CODE128";
    if (displayedUpc.length === 12) format = "UPC";
    else if (displayedUpc.length === 13) format = "EAN13";

    try {
      JsBarcode(svgRef.current, displayedUpc, { ...opts, format });
    } catch {
      try {
        JsBarcode(svgRef.current, displayedUpc, { ...opts, format: "CODE128" });
      } catch {
        if (svgRef.current) svgRef.current.innerHTML = "";
      }
    }
  }, [displayedUpc, editing]);

  function handleCopy(value: string | null) {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleCopyImage() {
    if (!displayedUpc || !svgRef.current) return;
    try {
      await copySvgElementImage(svgRef.current);
      setImageCopied(true);
      setTimeout(() => setImageCopied(false), 1500);
    } catch (error) {
      console.error("[upc-cell] failed to copy barcode image", error);
    }
  }

  function renderFastPushLabel() {
    if (quickPhase === "dry-run" || quickPhase === "ready") {
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

  function handleQuickPushRetry() {
    if (hasMultipleTargets) {
      setSelectorMode("fast");
      return;
    }
    onFastPush?.();
  }

  function startEdit() {
    if (!editable) return;

    if (liveChoices.length === 0) {
      setShowActions(false);
      setSelectorMode("edit");
      return;
    }

    const hasMultipleMarketplaceChoices = liveChoices.length > 1;

    if (hasMultipleMarketplaceChoices) {
      setShowActions(false);
      setSelectorMode("edit");
      return;
    }

    const choice = liveChoices.find((entry) => entry.editable);
    const fallbackTarget = pushTargets[0];
    setDraft(choice?.value ?? stagedUpc ?? upc ?? "");
    setSelectedTarget(
      choice
        ? {
            platform: choice.platform,
            listingId: pushTargets.find((target) => target.platform === choice.platform)?.listingId ?? "",
          }
        : fallbackTarget
          ? { platform: fallbackTarget.platform, listingId: fallbackTarget.listingId }
          : null,
    );
    setShowActions(false);
    setSelectorMode(null);
    setEditing(true);
  }

  function cancelEdit() {
    const hasMultipleMarketplaceChoices = liveChoices.length > 1;
    setEditing(false);
    setShowActions(false);
    setSelectorMode(hasMultipleMarketplaceChoices ? "edit" : null);
  }

  function normalizedDraft() {
    return draft.trim();
  }

  function hasDraftChange() {
    const selectedChoice =
      selectedTarget
        ? liveChoices.find((choice) => choice.platform === selectedTarget.platform)
        : null;
    const baseline = selectedChoice ? (selectedChoice.value ?? "") : effectiveUpc;
    return normalizedDraft().length > 0 && normalizedDraft() !== baseline;
  }

  function renderPushTargetLabel(label: string) {
    return (
      <span className="flex items-center justify-center gap-1">
        <span>{label}</span>
      </span>
    );
  }

  function handleEditChoice(choice: LiveUpcChoice) {
    if (!choice.editable) return;
    setSelectedTarget({
      platform: choice.platform,
      listingId: pushTargets.find((target) => target.platform === choice.platform)?.listingId ?? "",
    });
    setDraft(choice.value ?? "");
    setSelectorMode(null);
    setShowActions(false);
    setEditing(true);
  }

  function getActivePushTarget() {
    if (!selectedTarget) return null;
    return (
      pushTargets.find(
        (target) =>
          target.platform === selectedTarget.platform &&
          (!selectedTarget.listingId || target.listingId === selectedTarget.listingId),
      ) ?? null
    );
  }

  function saveDraft(mode: "stage" | "push" | "fastPush") {
    const activeTarget = getActivePushTarget();
    const activeChoice =
      activeTarget
        ? liveChoices.find((choice) => choice.platform === activeTarget.platform)
        : null;
    onSave?.(
      normalizedDraft(),
      mode,
      activeTarget
        ? {
            platform: activeTarget.platform,
            listingId: activeTarget.listingId,
            currentValue: activeChoice?.value ?? null,
          }
        : undefined,
    );
  }

  function renderCopyButton(value: string | null, label: string) {
    if (!value) return null;
    return (
      <button
        onClick={() => handleCopy(value)}
        className="shrink-0 rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground cursor-pointer"
        title={`Copy ${label}`}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      </button>
    );
  }

  function renderInlineUpcActions(line: LiveUpcLine) {
    if (!canPush) return null;
    if (line.kind !== "platform") return null;

    const actionableTarget = pushTargets.find((target) => target.platform === line.platform);

    if (quickPhase !== "idle") {
      return (
        <div className="mt-1 flex justify-center">
          {quickPhase === "error" || quickPhase === "blocked" ? (
            <button
              onClick={handleQuickPushRetry}
              className="inline-flex min-w-[88px] cursor-pointer items-center justify-center gap-1 rounded bg-amber-500 px-1.5 py-1 text-[9px] font-bold leading-none text-white hover:bg-amber-400"
              title={quickPushState?.detail ?? undefined}
            >
              {quickPhase === "blocked" ? (
                <>
                  <AlertTriangle className="h-3 w-3" />
                  Blocked
                </>
              ) : (
                renderFastPushLabel()
              )}
            </button>
          ) : (
            <div
              className={cn(
                "inline-flex min-w-[88px] items-center justify-center gap-1 rounded px-1.5 py-1 text-[9px] font-bold leading-none text-white",
                quickPhase === "success" ? "bg-emerald-500" : "bg-blue-500",
              )}
              title={quickPushState?.detail ?? undefined}
            >
              {renderFastPushLabel()}
            </div>
          )}
        </div>
      );
    }

    return (
      <div className="mt-1 grid grid-cols-3 gap-1">
        <button
          onClick={onReviewPush}
          className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1 py-[3px] text-[8px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
        >
          {renderCompactButtonLabel("Review Push")}
        </button>
        <button
          onClick={onFastPush}
          className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1 py-[3px] text-[8px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
        >
          {renderCompactButtonLabel("Fast Push")}
        </button>
        <button
          onClick={() => {
            if (actionableTarget && onDiscardTarget) {
              onDiscardTarget(actionableTarget.platform, actionableTarget.listingId);
              return;
            }
            setDismissedPlatforms((prev) =>
              prev.includes(line.platform) ? prev : [...prev, line.platform],
            );
          }}
          className="inline-flex min-w-0 items-center justify-center rounded bg-muted px-1 py-[3px] text-[8px] font-medium leading-none text-muted-foreground hover:text-foreground cursor-pointer"
        >
          {renderCompactButtonLabel("Discard")}
        </button>
      </div>
    );
  }

  function renderUpcLine(line: LiveUpcLine) {
    if (line.kind === "all") {
      return (
        <div key={`all:${line.value}`} className="flex w-full items-center gap-1">
          <div className="grid min-h-[28px] min-w-0 flex-1 grid-cols-[46px_minmax(0,1fr)_34px] items-center gap-1.5 rounded-md border border-emerald-500/30 bg-background/40 px-1.5 py-1">
            <span className="inline-flex min-h-[20px] flex-col items-center justify-center rounded-sm bg-emerald-500/15 px-1 text-center text-[7px] font-bold uppercase leading-[1.05] text-emerald-300">
              <span>All</span>
              <span>Stores</span>
            </span>
            <span className="block min-w-0 truncate pr-1 text-center font-mono text-[10px] font-semibold leading-none tracking-tight text-emerald-300">
              {line.value}
            </span>
            <span className="inline-flex min-h-[18px] min-w-[22px] items-center justify-center rounded-sm bg-emerald-500 px-0.5 text-[6px] font-bold leading-none text-white">
              LIVE
            </span>
          </div>
          {renderCopyButton(line.value, `${line.label} UPC`)}
        </div>
      );
    }

    const normalizedStagedUpc = stagedUpc?.trim() ?? "";
    const liveChoice = liveChoices.find((choice) => choice.platform === line.platform);
    const hasActiveStageForLine = Boolean(
      pushTargets.find(
        (target) => target.platform === line.platform && Boolean(target.stagedChangeId),
      ),
    );
    const actionableTarget = pushTargets.find((target) => target.platform === line.platform);
    const stagedTarget =
      Boolean(normalizedStagedUpc) &&
      hasActiveStageForLine &&
      !dismissedPlatforms.includes(line.platform) &&
      ((liveChoice?.value?.trim() ?? "") !== normalizedStagedUpc);
    const failedPushTarget =
      actionableTarget
        ? failedPushTargets[`${actionableTarget.platform}:${actionableTarget.listingId}`]
        : undefined;
    if (stagedTarget && stagedUpc) {
      return (
        <div key={`${line.platform}:staged:${line.value ?? "none"}`} className="flex w-full items-start gap-1">
          <div className="w-full rounded-md border border-border/60 bg-background/40 px-1.5 py-1">
            <div className="grid min-h-[28px] min-w-0 grid-cols-[46px_minmax(0,1fr)_34px] items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex min-h-[20px] items-center justify-center gap-1 rounded-sm px-1 py-px text-[7px] font-bold uppercase leading-none",
                  PLATFORM_COLORS[line.platform],
                )}
              >
                <PlatformIcon platform={line.platform} size={11} />
                <span>{line.label}</span>
              </span>
              <span className="block min-w-0 truncate pr-1 font-mono text-[10px] font-semibold leading-none tracking-tight text-amber-300">
                {stagedUpc}
              </span>
              <span
                className={cn(
                  "inline-flex min-h-[18px] min-w-[22px] items-center justify-center rounded-sm px-0.5 text-[6px] font-bold leading-none",
                  failedPushTarget ? "bg-red-500 text-white" : "bg-amber-500 text-black",
                )}
                title={failedPushTarget?.error}
              >
                {failedPushTarget ? "FAILED" : "NEW"}
              </span>
            </div>
            <div className="mt-1 grid min-h-[26px] min-w-0 grid-cols-[46px_minmax(0,1fr)_34px] items-center gap-1.5">
              <span className="inline-flex min-h-[20px] items-center justify-center rounded-sm bg-muted px-1 text-[7px] font-bold uppercase leading-none text-muted-foreground">
                Live
              </span>
              <span
                className={cn(
                  "block min-w-0 truncate pr-1 font-mono text-[10px] font-semibold leading-none tracking-tight",
                  line.value ? PLATFORM_TEXT_COLORS[line.platform] : "text-muted-foreground/60",
                )}
              >
                {getLiveUpcText(line)}
              </span>
              <span
                className={cn(
                  "inline-flex min-h-[18px] min-w-[22px] items-center justify-center rounded-sm px-0.5 text-[6px] font-bold leading-none text-white",
                  line.value
                    ? line.platform === "TPP_EBAY"
                      ? "bg-blue-500"
                      : line.platform === "TT_EBAY"
                        ? "bg-emerald-500"
                      : line.platform === "BIGCOMMERCE"
                          ? "bg-orange-500"
                          : "bg-lime-500 text-black"
                    : line.state === "pending_refresh"
                      ? "bg-amber-500 text-black"
                      : line.state === "not_found"
                        ? "bg-muted text-muted-foreground"
                      : "bg-muted text-muted-foreground",
                )}
              >
                {getLiveUpcBadge(line)}
              </span>
            </div>
            {failedPushTarget ? (
              <div
                className="mt-1 truncate text-[9px] font-medium leading-none text-red-300"
                title={failedPushTarget.error}
              >
                {failedPushTarget.summary}
              </div>
            ) : null}
            {renderInlineUpcActions(line)}
          </div>
          {renderCopyButton(stagedUpc, `${line.label} staged UPC`)}
        </div>
      );
    }

    return (
        <div key={`${line.platform}:${line.value ?? "none"}`} className="flex w-full items-center gap-1">
          <div className="grid min-h-[28px] min-w-0 flex-1 grid-cols-[46px_minmax(0,1fr)_34px] items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-1.5 py-1">
          <span
            className={cn(
              "inline-flex min-h-[20px] items-center justify-center gap-1 rounded-sm px-1 py-px text-[7px] font-bold uppercase leading-none",
              PLATFORM_COLORS[line.platform],
            )}
          >
            <PlatformIcon platform={line.platform} size={11} />
            <span>{line.label}</span>
          </span>
            <span
              className={cn(
                "block min-w-0 truncate pr-1 font-mono text-[10px] font-semibold leading-none tracking-tight",
                line.value ? PLATFORM_TEXT_COLORS[line.platform] : "text-muted-foreground/60",
              )}
            >
              {getLiveUpcText(line)}
            </span>
            <span
              className={cn(
                "inline-flex min-h-[18px] min-w-[22px] items-center justify-center rounded-sm px-0.5 text-[6px] font-bold leading-none text-white",
                line.value
                  ? line.platform === "TPP_EBAY"
                    ? "bg-blue-500"
                    : line.platform === "TT_EBAY"
                      ? "bg-emerald-500"
                    : line.platform === "BIGCOMMERCE"
                        ? "bg-orange-500"
                        : "bg-lime-500 text-black"
                  : line.state === "pending_refresh"
                    ? "bg-amber-500 text-black"
                    : line.state === "not_found"
                      ? "bg-muted text-muted-foreground"
                    : "bg-muted text-muted-foreground",
              )}
            >
            {getLiveUpcBadge(line)}
            </span>
          </div>
          {renderCopyButton(line.value, `${line.label} UPC`)}
      </div>
    );
  }

  function renderLiveLines() {
    if (liveLines.length === 0) {
      return null;
    }

    return (
      <div className="mt-1 flex w-full flex-col items-center gap-1">
        {liveLines.map((line) => renderUpcLine(line))}
      </div>
    );
  }

  const showSelector = selectorMode !== null && quickPhase === "idle";
  const showInlineEditSelector = selectorMode === "edit" && quickPhase === "idle";
  const showMatchSelector = selectorMode === "match" && quickPhase === "idle";
  const showActionSelector =
    selectorMode !== null && selectorMode !== "edit" && selectorMode !== "match" && quickPhase === "idle";

  function getMatchUpcPreview(allowSingleSource = false) {
    const normalizedChoices = liveChoices.map((choice) => ({
      ...choice,
      normalizedValue: choice.value?.trim() ?? "",
    }));
    const populatedChoices = normalizedChoices.filter((choice) => choice.normalizedValue.length > 0);
    if (populatedChoices.length === 0) {
      return {
        majorityUpc: null,
        mismatchCount: 0,
        actionableMismatchCount: 0,
        tied: false,
        ready: false,
        canMatchAnyway: false,
        detail: "No live UPC is available yet.",
        majorityChoices: [] as LiveUpcChoice[],
        mismatchChoices: [] as LiveUpcChoice[],
        actionableMismatchChoices: [] as LiveUpcChoice[],
        lockedMismatchChoices: [] as LiveUpcChoice[],
      };
    }

    const counts = new Map<string, number>();
    for (const choice of populatedChoices) {
      counts.set(choice.normalizedValue, (counts.get(choice.normalizedValue) ?? 0) + 1);
    }

    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const topCount = ranked[0]?.[1] ?? 0;
    const leaders = ranked.filter(([, count]) => count === topCount);
    const singleSourceCandidate =
      populatedChoices.length === 1 &&
      normalizedChoices.length > 1 &&
      normalizedChoices.every(
        (choice) =>
          choice.normalizedValue.length === 0 ||
          choice.normalizedValue === populatedChoices[0]?.normalizedValue,
      );
    if (leaders.length !== 1 || (topCount < 2 && !(allowSingleSource && singleSourceCandidate))) {
      const forceChoices = singleSourceCandidate
        ? normalizedChoices.filter(
            (choice) => choice.normalizedValue !== (populatedChoices[0]?.normalizedValue ?? ""),
          )
        : [];
      return {
        majorityUpc: null,
        mismatchCount: 0,
        actionableMismatchCount: 0,
        tied: true,
        ready: false,
        canMatchAnyway: singleSourceCandidate,
        detail:
          singleSourceCandidate
            ? "Only one marketplace has a UPC on this row. Use Match Anyway only if you want the blank marketplaces to inherit that UPC."
            : topCount < 2
            ? "Match UPC needs at least two marketplaces sharing the same UPC before it can update the others."
            : "There is a tie, so reorG cannot safely choose the right UPC.",
        majorityChoices: singleSourceCandidate ? populatedChoices : ([] as LiveUpcChoice[]),
        mismatchChoices: forceChoices,
        actionableMismatchChoices: forceChoices.filter((choice) => choice.editable),
        lockedMismatchChoices: forceChoices.filter((choice) => !choice.editable),
      };
    }

    const majorityUpc =
      allowSingleSource && singleSourceCandidate
        ? (populatedChoices[0]?.normalizedValue ?? null)
        : (leaders[0]?.[0] ?? null);
    const majorityChoices = normalizedChoices.filter((choice) => choice.normalizedValue === (majorityUpc ?? ""));
    const mismatchChoices = normalizedChoices.filter((choice) => choice.normalizedValue !== (majorityUpc ?? ""));
    const actionableMismatchChoices = mismatchChoices.filter((choice) => choice.editable);
    const lockedMismatchChoices = mismatchChoices.filter((choice) => !choice.editable);
    const mismatchCount = mismatchChoices.length;
    const actionableMismatchCount = actionableMismatchChoices.length;

    if (!majorityUpc || mismatchCount === 0 || actionableMismatchCount === 0) {
      return {
        majorityUpc,
        mismatchCount,
        actionableMismatchCount,
        tied: false,
        ready: false,
        canMatchAnyway: false,
        detail: !majorityUpc
          ? "No majority UPC was found."
          : mismatchCount === 0
            ? `All marketplace UPCs already match ${majorityUpc}.`
            : "The differing marketplaces are not available for UPC push from this row yet.",
        majorityChoices,
        mismatchChoices,
        actionableMismatchChoices,
        lockedMismatchChoices,
      };
    }

    return {
      majorityUpc,
      mismatchCount,
      actionableMismatchCount,
      tied: false,
      ready: true,
      canMatchAnyway: false,
      detail: allowSingleSource && singleSourceCandidate
        ? `Match the blank marketplaces to the only available UPC ${majorityUpc}.`
        : `Match ${actionableMismatchCount === 1 ? "1 marketplace" : `${actionableMismatchCount} marketplaces`} to majority UPC ${majorityUpc}.`,
      majorityChoices,
      mismatchChoices,
      actionableMismatchChoices,
      lockedMismatchChoices,
    };
  }

  function renderMatchSelector() {
    const preview = getMatchUpcPreview(forceSingleSourceMatch);
    const disabled = !preview.ready;
    const hasPreviewRoute = preview.majorityChoices.length > 0 || preview.mismatchChoices.length > 0;

    return (
      <div className="mt-1 w-full space-y-1">
        <div className="rounded border border-border bg-background/40 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">
          Match UPC to majority UPC
        </div>
        <div className="rounded border border-border/60 bg-background/30 px-2 py-1 text-center text-[10px] font-medium text-foreground/80">
          {hasPreviewRoute && (!preview.canMatchAnyway || forceSingleSourceMatch) ? (
            <>
              <div className="flex flex-wrap items-center justify-center gap-2 text-[10px]">
                <span className="inline-flex flex-wrap items-center justify-center gap-2">
                  {preview.majorityChoices.map((choice) => (
                    <span key={`majority:${choice.platform}`} className="inline-flex items-center gap-1">
                      <PlatformIcon platform={choice.platform} size={11} />
                      <span>{choice.label}</span>
                    </span>
                  ))}
                </span>
                <span className="text-muted-foreground">-&gt;</span>
                <span className="inline-flex flex-wrap items-center justify-center gap-2">
                  {preview.mismatchChoices.map((choice) => (
                    <span key={`target:${choice.platform}`} className="inline-flex items-center gap-1">
                      <PlatformIcon platform={choice.platform} size={11} />
                      <span>{choice.label}</span>
                      {!choice.editable ? <Lock className="h-3 w-3 text-muted-foreground/80" /> : null}
                    </span>
                  ))}
                </span>
              </div>
              <div className="mt-1 space-y-1 border-t border-border/50 pt-1 text-left">
                {preview.mismatchChoices.map((choice) => (
                  <div
                    key={`change:${choice.platform}`}
                    className="flex items-center justify-between gap-2 text-[10px]"
                  >
                    <span className="inline-flex min-w-0 items-center gap-1 font-medium text-foreground/85">
                      <PlatformIcon platform={choice.platform} size={11} />
                      <span>{choice.label}</span>
                      {!choice.editable ? <Lock className="h-3 w-3 text-muted-foreground/80" /> : null}
                    </span>
                    <span className="font-mono text-foreground/90">
                      {(choice.value ?? "No UPC")} -&gt; {preview.majorityUpc ?? "No UPC"}
                    </span>
                  </div>
                ))}
              </div>
              {preview.lockedMismatchChoices.length > 0 ? (
                <div className="mt-1 rounded bg-muted/60 px-2 py-1 text-[9px] text-muted-foreground">
                  Push available now: {preview.actionableMismatchChoices.map((choice) => choice.label).join(", ") || "None"}.
                  Locked right now: {preview.lockedMismatchChoices.map((choice) => choice.label).join(", ")}.
                </div>
              ) : null}
            </>
          ) : (
            <div className="rounded border border-dashed border-border/60 bg-background/20 px-2 py-2 text-center text-[10px] text-muted-foreground">
              {preview.detail}
            </div>
          )}
        </div>
        {preview.canMatchAnyway && !forceSingleSourceMatch ? (
          <button
            onClick={() => setForceSingleSourceMatch(true)}
            className="inline-flex w-full min-w-0 items-center justify-center rounded border border-amber-400/40 bg-amber-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-black hover:bg-amber-400 cursor-pointer"
            title="Force match the blank marketplaces to the one available UPC on this row"
          >
            {renderCompactButtonLabel("Match Anyway")}
          </button>
        ) : (
          <div className="grid grid-cols-3 gap-1">
            <button
              onClick={() => {
                onMatchUpc?.(liveChoices, "stage", { allowSingleSource: forceSingleSourceMatch });
                setSelectorMode(null);
                setForceSingleSourceMatch(false);
              }}
              disabled={disabled}
              className={cn(
                "inline-flex min-w-0 items-center justify-center rounded border px-1.5 py-1.5 text-[9px] font-bold leading-none",
                disabled
                  ? "cursor-not-allowed border-border/60 bg-background/25 text-muted-foreground/45"
                  : "cursor-pointer border-[var(--staged)]/40 bg-[var(--staged)] text-[var(--staged-foreground)] hover:opacity-80",
              )}
              title={disabled ? preview.detail : "Stage the Match UPC update"}
            >
              {renderCompactButtonLabel("Stage")}
            </button>
            <button
              onClick={() => {
                onMatchUpc?.(liveChoices, "push", { allowSingleSource: forceSingleSourceMatch });
                setSelectorMode(null);
                setForceSingleSourceMatch(false);
              }}
              disabled={disabled}
              className={cn(
                "inline-flex min-w-0 items-center justify-center rounded border px-1.5 py-1.5 text-[9px] font-bold leading-none text-white",
                disabled
                  ? "cursor-not-allowed border-border/60 bg-background/25 text-muted-foreground/45"
                  : "cursor-pointer border-emerald-400/40 bg-emerald-500 hover:bg-emerald-600",
              )}
              title={disabled ? preview.detail : "Open Review Push for Match UPC"}
            >
              {renderCompactButtonLabel("Review Push")}
            </button>
            <button
              onClick={() => {
                onMatchUpc?.(liveChoices, "fastPush", { allowSingleSource: forceSingleSourceMatch });
                setSelectorMode(null);
                setForceSingleSourceMatch(false);
              }}
              disabled={disabled}
              className={cn(
                "inline-flex min-w-0 items-center justify-center rounded border px-1.5 py-1.5 text-[9px] font-bold leading-none text-white",
                disabled
                  ? "cursor-not-allowed border-border/60 bg-background/25 text-muted-foreground/45"
                  : "cursor-pointer border-blue-400/40 bg-blue-500 hover:bg-blue-600",
              )}
              title={disabled ? preview.detail : "Run Fast Push for Match UPC"}
            >
              {renderCompactButtonLabel("Fast Push")}
            </button>
          </div>
        )}
        <button
          onClick={() => {
            if (forceSingleSourceMatch) {
              setForceSingleSourceMatch(false);
              return;
            }
            setSelectorMode(null);
          }}
          className="inline-flex w-full min-w-0 items-center justify-center rounded border border-border/80 bg-background/50 px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground cursor-pointer"
        >
          {renderCompactButtonLabel("Back")}
        </button>
      </div>
    );
  }

  function renderSelector() {
    return (
      <div className="mt-1 w-full space-y-1">
        <div className="rounded border border-border bg-background/40 px-2 py-1 text-center text-[10px] font-medium text-muted-foreground">
          {selectorMode === "edit" ? "Choose marketplace to edit" : "Choose marketplace"}
        </div>
        <div className={cn("gap-1", selectorMode === "edit" ? "grid grid-cols-1" : "grid grid-cols-2")}>
          {selectorMode === "edit" ? (
            liveChoices.length === 0 ? (
              <div className="inline-flex items-center justify-center gap-1 rounded border border-border bg-background/30 px-2 py-2 text-[10px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading marketplaces...
              </div>
            ) : (
              liveChoices.map((choice) => (
                <button
                  key={`edit:${choice.platform}:${choice.value}`}
                  onClick={() => handleEditChoice(choice)}
                  disabled={!choice.editable}
                  className={cn(
                    "flex min-w-0 items-center justify-between gap-1 rounded border px-2 py-1 text-left text-[10px] font-semibold",
                    PLATFORM_COLORS[choice.platform],
                    choice.editable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                  )}
                  title={choice.editable ? `Edit ${choice.label} UPC` : `${choice.label} UPC push is not enabled yet`}
                >
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <PlatformIcon platform={choice.platform} size={11} />
                    <span>{choice.label}</span>
                  </span>
                  <span className="min-w-0 flex-1 break-all text-right font-mono text-[10px]">{choice.value ?? "No UPC"}</span>
                  {!choice.editable ? <Lock className="h-3 w-3 shrink-0" /> : null}
                </button>
              ))
            )
          ) : (
            pushTargets.map((target) => (
              <button
                key={`${target.platform}:${target.listingId}`}
                onClick={() => {
                  if (selectorMode === "review") {
                    onReviewPushTarget?.(target.platform, target.listingId);
                  } else {
                    onFastPushTarget?.(target.platform, target.listingId);
                  }
                  setSelectorMode(null);
                }}
                className="inline-flex min-w-0 items-center justify-center rounded bg-primary/15 px-1.5 py-1.5 text-[9px] font-bold leading-none text-primary hover:bg-primary/25 cursor-pointer"
                title={`Push UPC to ${target.label}`}
              >
                {renderPushTargetLabel(target.label)}
              </button>
            ))
          )}
        </div>
        {selectorMode === "edit" ? (
          <button
            onClick={() => setSelectorMode(null)}
            className="inline-flex w-full min-w-0 items-center justify-center rounded border border-border/80 bg-background/50 px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground cursor-pointer"
          >
            {renderCompactButtonLabel("Back")}
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-1">
            <button
              onClick={() => setSelectorMode(null)}
              className="inline-flex min-w-0 items-center justify-center rounded border border-border/80 bg-background/50 px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground transition-colors hover:border-border hover:bg-background/70 hover:text-foreground cursor-pointer"
            >
              {renderCompactButtonLabel("Back")}
            </button>
            <button
              onClick={onDiscard}
              className="inline-flex min-w-0 items-center justify-center rounded border border-border bg-background/40 px-1.5 py-1.5 text-[9px] font-medium leading-none text-muted-foreground hover:text-foreground cursor-pointer"
            >
              {renderCompactButtonLabel("Discard")}
            </button>
          </div>
        )}
      </div>
    );
  }

  const matchPreview = getMatchUpcPreview();
  const matchAlreadyComplete =
    !matchPreview.ready &&
    !matchPreview.tied &&
    Boolean(matchPreview.majorityUpc) &&
    matchPreview.mismatchCount === 0;

  if (editing) {
    const valid = hasDraftChange();
    const selectedPlatform =
      selectedTarget?.platform && selectedTarget.platform in PLATFORM_INPUT_BORDERS
        ? (selectedTarget.platform as Platform)
        : null;
    return (
      <div className="w-full rounded border border-violet-500/40 bg-background/40 px-2 py-2">
        <div className="flex items-center gap-1">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\s+/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancelEdit();
              if (e.key === "Enter" && valid) setShowActions(true);
            }}
            className={cn(
              "min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs font-mono text-foreground outline-none focus:ring-1",
              selectedPlatform ? PLATFORM_INPUT_BORDERS[selectedPlatform] : "border-input focus:ring-ring",
            )}
            autoFocus
          />
          <button
            onClick={() => {
              if (valid) setShowActions(true);
            }}
            disabled={!valid}
            className={cn(
              "rounded p-0.5",
              valid ? "cursor-pointer text-emerald-400 hover:text-emerald-300" : "cursor-not-allowed text-muted-foreground/30",
            )}
            title="Confirm"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            onClick={cancelEdit}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
            title="Cancel"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
        {showActions ? (
          <div className="mt-1 grid w-full grid-cols-3 gap-1">
            <button
              onClick={() => {
                saveDraft("stage");
                setEditing(false);
                setShowActions(false);
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-[var(--staged)] px-1.5 py-1.5 text-[9px] font-bold leading-none text-[var(--staged-foreground)] hover:opacity-80 cursor-pointer"
            >
              {renderCompactButtonLabel("Stage")}
            </button>
            <button
              onClick={() => {
                const activeTarget = getActivePushTarget();
                if (activeTarget) {
                  saveDraft("push");
                  setEditing(false);
                  setShowActions(false);
                  return;
                }
                if (hasMultipleTargets) {
                  saveDraft("stage");
                  setEditing(false);
                  setShowActions(false);
                  setSelectorMode("review");
                  return;
                }
                setEditing(false);
                setShowActions(false);
                saveDraft("push");
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-emerald-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-emerald-600 cursor-pointer"
            >
              {renderCompactButtonLabel("Review Push")}
            </button>
            <button
              onClick={() => {
                const activeTarget = getActivePushTarget();
                if (activeTarget) {
                  saveDraft("fastPush");
                  setEditing(false);
                  setShowActions(false);
                  return;
                }
                if (hasMultipleTargets) {
                  saveDraft("stage");
                  setEditing(false);
                  setShowActions(false);
                  setSelectorMode("fast");
                  return;
                }
                setEditing(false);
                setShowActions(false);
                saveDraft("fastPush");
              }}
              className="inline-flex min-w-0 items-center justify-center rounded bg-blue-500 px-1.5 py-1.5 text-[9px] font-bold leading-none text-white hover:bg-blue-600 cursor-pointer"
            >
              {renderCompactButtonLabel("Fast Push")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center gap-1 text-foreground">
      <CopyNotice show={copied || imageCopied} />
      <svg
        ref={svgRef}
        className="h-[48px] w-full max-w-[160px] cursor-pointer"
        onClick={() => {}}
        onContextMenu={(e) => {
          e.preventDefault();
          void handleCopyImage();
        }}
        role="img"
        aria-label={displayedUpc ? `UPC barcode: ${displayedUpc}` : "No UPC available"}
      />

      <div className="w-full">
        {showInlineEditSelector ? (
          renderSelector()
        ) : showMatchSelector ? (
          renderMatchSelector()
        ) : liveLines.length > 0 ? (
          renderLiveLines()
        ) : displayedUpc ? null : (
          <span className="text-[10px] font-medium text-muted-foreground/40 italic">No UPC</span>
        )}
      </div>

      {showInlineEditSelector || showMatchSelector ? null : showActionSelector ? (
        renderSelector()
      ) : editable && quickPhase === "idle" ? (
        <div className="mt-1 grid w-[calc(100%-18px)] grid-cols-2 gap-1 self-start">
          <button
            onClick={startEdit}
            className="inline-flex min-w-0 items-center justify-center rounded border border-border bg-background/40 px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
          >
            Edit
          </button>
          <button
            onClick={() => setSelectorMode("match")}
            disabled={liveChoices.length === 0 || matchAlreadyComplete}
            className={cn(
              "inline-flex min-w-0 items-center justify-center rounded border border-border bg-background/40 px-2 py-1 text-[10px] font-medium transition-colors",
              liveChoices.length === 0 || matchAlreadyComplete
                ? "cursor-not-allowed text-muted-foreground/40"
                : "cursor-pointer text-muted-foreground hover:text-foreground",
            )}
            title={
              matchAlreadyComplete
                ? "All marketplace UPCs already match on this row"
                : "Match minority marketplace UPCs to the majority UPC on this row"
            }
          >
            {matchAlreadyComplete ? "UPCs Already Match" : "Match UPC"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
