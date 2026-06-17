"use client";

/**
 * Buyer feedback frame for the Return Cases detail right rail.
 *
 * Mirrors the Help Desk ticket right-rail feedback section (look + behavior):
 * it renders the buyer-feedback history oldest-first — buyer-authored vs.
 * eBay-automated, positive/neutral/negative, removals, and the leave-by
 * deadline. The data comes from /api/helpdesk/returns/[returnId]/feedback,
 * which reuses the exact same server-side `helpdesk-feedback` helpers as the
 * ticket feedback route, so the two stay in lock-step.
 */

import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, Star } from "lucide-react";
import { cn } from "@/lib/utils";

type FeedbackState = "LEFT" | "NOT_LEFT" | "UNKNOWN";

interface FeedbackItem {
  id: string;
  externalId: string;
  kind: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  starRating: number | null;
  comment: string | null;
  sellerResponse: string | null;
  ebayOrderNumber: string | null;
  ebayItemId: string | null;
  buyerUserId: string | null;
  leftAt: string;
  source: "mirror" | "live";
  isAutomated: boolean;
  removedAt?: string | null;
}

interface FeedbackData {
  state: FeedbackState;
  items: FeedbackItem[];
  checkedLive: boolean;
  removals?: { at: string }[];
  leaveBy?: string | null;
  reason?: string;
}

type FeedbackHistoryEntry =
  | { type: "feedback"; at: string; item: FeedbackItem }
  | { type: "removal"; at: string };

function buildFeedbackHistory(data: FeedbackData | null): FeedbackHistoryEntry[] {
  if (!data) return [];
  const entries: FeedbackHistoryEntry[] = data.items.map((item) => ({
    type: "feedback" as const,
    at: item.leftAt,
    item,
  }));
  for (const removal of data.removals ?? []) {
    entries.push({ type: "removal", at: removal.at });
  }
  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function formatFeedbackDate(value: string | null | undefined): string {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function formatFeedbackDeadline(value: string): string {
  try {
    return new Date(value).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return value;
  }
}

function FeedbackHistoryItemCard({
  item,
  leaveBy,
}: {
  item: FeedbackItem;
  leaveBy: string | null;
}) {
  const kindLabel = item.kind.charAt(0) + item.kind.slice(1).toLowerCase();
  const removed = Boolean(item.removedAt);
  return (
    <div
      className={cn(
        "rounded-md border border-hairline bg-surface/50 p-2",
        removed && "border-dashed",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              item.isAutomated
                ? "bg-sky-500/15 text-sky-700 dark:text-sky-300"
                : item.kind === "POSITIVE"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : item.kind === "NEGATIVE"
                  ? "bg-red-500/15 text-red-700 dark:text-red-300"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-300",
            )}
          >
            {item.isAutomated ? "Automated by eBay" : `Buyer ${kindLabel}`}
          </span>
          {removed ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Removed
            </span>
          ) : null}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatFeedbackDate(item.leftAt)}
        </span>
      </div>
      <p className="mt-1 text-xs font-medium text-foreground">
        {item.isAutomated
          ? `Automated eBay ${kindLabel} Feedback`
          : `Buyer-authored ${kindLabel} Feedback`}
      </p>
      {!removed ? (
        <p
          className={cn(
            "mt-1 rounded border px-2 py-1.5 text-[11px] leading-relaxed",
            item.isAutomated
              ? "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-200"
              : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
          )}
        >
          {item.isAutomated
            ? "Automated eBay Feedback."
            : "Feedback left directly by the buyer."}
        </p>
      ) : null}
      {typeof item.starRating === "number" && item.starRating > 0 ? (
        <p className="mt-1 text-xs text-foreground">Rating: {item.starRating}/5</p>
      ) : null}
      {item.comment ? (
        <p
          className={cn(
            "mt-1 line-clamp-4 text-xs leading-relaxed",
            removed ? "text-muted-foreground line-through" : "text-foreground",
          )}
        >
          "{item.comment}"
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">
          Feedback was left without a public comment.
        </p>
      )}
      {item.sellerResponse ? (
        <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
          Seller response: {item.sellerResponse}
        </p>
      ) : null}
      {item.isAutomated && !removed && leaveBy ? (
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Buyer can still change this by leaving their own feedback until{" "}
          <span className="font-medium text-foreground">
            {formatFeedbackDeadline(leaveBy)}
          </span>
          .
        </p>
      ) : null}
    </div>
  );
}

function FeedbackRemovalCard({ at }: { at: string }) {
  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
          <ShieldCheck className="h-3 w-3" />
          Feedback Removal Approved
        </span>
        <span className="text-[10px] text-muted-foreground">
          {formatFeedbackDate(at)}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        eBay approved the removal request and removed this feedback, including
        the ratings.
      </p>
    </div>
  );
}

export function BuyerFeedbackCard({
  returnId,
  platform,
}: {
  returnId: string;
  platform: string;
}) {
  const isEbay = platform === "TPP_EBAY" || platform === "TT_EBAY";
  const [data, setData] = useState<FeedbackData | null>(null);
  const [loading, setLoading] = useState(isEbay);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEbay) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/helpdesk/returns/${encodeURIComponent(returnId)}/feedback`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`Feedback request failed (${res.status})`);
        const json = (await res.json()) as { data: FeedbackData };
        if (cancelled) return;
        setData(json.data);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [returnId, isEbay]);

  if (!isEbay) return null;

  const history = buildFeedbackHistory(data);
  const first = data?.items[0] ?? null;
  const state = data?.state ?? "UNKNOWN";
  const leaveBy = data?.leaveBy ?? null;
  const hasRemoval = (data?.removals?.length ?? 0) > 0;

  return (
    <div className="rounded-xl border border-hairline bg-card p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Star className="h-3.5 w-3.5 text-brand" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Feedback
          </h3>
        </div>
        {loading ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking
          </span>
        ) : first?.source === "live" ? (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-foreground">
            Live
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          Feedback lookup unavailable.
        </p>
      ) : history.length > 0 ? (
        <div className="space-y-1.5">
          {history.map((entry, idx) =>
            entry.type === "feedback" ? (
              <FeedbackHistoryItemCard
                key={`fb-${entry.item.id}`}
                item={entry.item}
                leaveBy={leaveBy}
              />
            ) : (
              <FeedbackRemovalCard key={`rm-${idx}`} at={entry.at} />
            ),
          )}
          {hasRemoval && (data?.items.length ?? 0) === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              The original feedback text wasn't captured before eBay removed it,
              so only the removal is shown here.
            </p>
          ) : null}
        </div>
      ) : state === "NOT_LEFT" ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>Feedback has not been left for this order.</p>
          {leaveBy ? (
            <p>
              Buyer can leave feedback until{" "}
              <span className="font-medium text-foreground">
                {formatFeedbackDeadline(leaveBy)}
              </span>
              .
            </p>
          ) : null}
        </div>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">Checking eBay feedback...</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          No feedback result available yet.
        </p>
      )}
    </div>
  );
}
