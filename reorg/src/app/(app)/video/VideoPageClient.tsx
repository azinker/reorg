"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  ImageIcon,
  Loader2,
  Play,
  RefreshCw,
  Sparkles,
  Video,
  WandSparkles,
} from "lucide-react";

type VideoWindow = "7d" | "30d" | "90d";

type VideoTopItem = {
  sku: string;
  title: string | null;
  marketplaceListingId: string | null;
  platformItemId: string | null;
  imageUrl: string | null;
  unitsSold: number;
  grossRevenue: number;
  netRevenue: number | null;
  orderCount: number;
  salePrice: number | null;
  inventory: number | null;
  listingUrl: string | null;
  hasListingDescription: boolean;
  photoCount: number;
};

type VideoSalesCoverage = {
  window: VideoWindow;
  requestedFrom: string;
  requestedTo: string;
  latestOrderDate: string | null;
  hasCurrentWindowData: boolean;
  isStale: boolean;
  message: string | null;
};

type HiggsfieldConnectionStatus = {
  configured: boolean;
  authMode: "HF_KEY" | "HIGGSFIELD_API_KEY_SECRET" | "missing";
  modelId: string;
  quality: "1080p";
  size: "1920x1080";
  aspectRatio: "16:9";
};

type VideoListingBrief = {
  marketplaceListingId: string;
  sku: string;
  title: string;
  platformItemId: string;
  listingUrl: string;
  imageUrls: string[];
  descriptionText: string | null;
  salePrice: number | null;
  inventory: number | null;
  upc: string | null;
  weight: string | null;
  condition: string | null;
  category: string | null;
  itemSpecifics: Array<{ name: string; value: string }>;
  prompt: string;
  negativePrompt: string;
  generationSettings: {
    modelId: string;
    quality: "1080p";
    size: "1920x1080";
    aspectRatio: "16:9";
    durationSeconds: number;
    formatGuidance: string;
  };
};

type ItemsResponse = {
  items: VideoTopItem[];
  coverage: VideoSalesCoverage;
  connection: HiggsfieldConnectionStatus;
  generatedAt: string;
};

type GenerateResponse = {
  brief: VideoListingBrief;
  higgsfield: {
    status?: string;
    request_id?: string;
    status_url?: string;
    video?: { url?: string };
  } | null;
};

function formatCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Never";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function readJsonData<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : "Request failed.";
    throw new Error(message);
  }
  return (json as { data: T }).data;
}

function SettingPill(props: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {props.label}
      </p>
      <p className="mt-1 text-sm font-medium text-foreground">{props.value}</p>
    </div>
  );
}

export function VideoPageClient() {
  const [windowDays, setWindowDays] = useState<VideoWindow>("30d");
  const [items, setItems] = useState<VideoTopItem[]>([]);
  const [coverage, setCoverage] = useState<VideoSalesCoverage | null>(null);
  const [connection, setConnection] = useState<HiggsfieldConnectionStatus | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [brief, setBrief] = useState<VideoListingBrief | null>(null);
  const [loadingItems, setLoadingItems] = useState(true);
  const [loadingBrief, setLoadingBrief] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [requestId, setRequestId] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollTimerRef = useRef<number | null>(null);

  const selectedItem = useMemo(
    () => items.find((item) => item.marketplaceListingId === selectedId) ?? null,
    [items, selectedId],
  );

  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    setError("");
    try {
      const params = new URLSearchParams({ window: windowDays, limit: "40" });
      const data = await readJsonData<ItemsResponse>(
        await fetch(`/api/video/items?${params.toString()}`, { cache: "no-store" }),
      );
      setItems(data.items);
      setCoverage(data.coverage);
      setConnection(data.connection);
      setStatusText(data.coverage.message ?? `TPP rankings refreshed ${formatDateTime(data.generatedAt)}.`);
      setSelectedId((current) => {
        if (current && data.items.some((item) => item.marketplaceListingId === current)) return current;
        return data.items.find((item) => item.marketplaceListingId)?.marketplaceListingId ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load Video items.");
    } finally {
      setLoadingItems(false);
    }
  }, [windowDays]);

  const loadBrief = useCallback(async (marketplaceListingId: string) => {
    setLoadingBrief(true);
    setError("");
    setVideoUrl(null);
    setRequestId(null);
    try {
      const params = new URLSearchParams({ marketplaceListingId });
      const data = await readJsonData<VideoListingBrief>(
        await fetch(`/api/video/brief?${params.toString()}`, { cache: "no-store" }),
      );
      setBrief(data);
      setStatusText("Prompt built from live TPP eBay GetItem data, including full description and listing photos returned by eBay.");
    } catch (briefError) {
      setBrief(null);
      setError(briefError instanceof Error ? briefError.message : "Failed to build prompt.");
    } finally {
      setLoadingBrief(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (!selectedId) {
      setBrief(null);
      return;
    }
    void loadBrief(selectedId);
  }, [loadBrief, selectedId]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
    };
  }, []);

  const pollStatus = useCallback((nextRequestId: string) => {
    if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
    pollTimerRef.current = window.setInterval(async () => {
      try {
        const params = new URLSearchParams({ requestId: nextRequestId });
        const data = await readJsonData<Record<string, unknown>>(
          await fetch(`/api/video/higgsfield/status?${params.toString()}`, { cache: "no-store" }),
        );
        const status = typeof data.status === "string" ? data.status : "processing";
        setStatusText(`Higgsfield status: ${status}.`);
        const video = data.video && typeof data.video === "object" ? data.video as { url?: unknown } : null;
        if (status === "completed" || typeof video?.url === "string") {
          if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
          setVideoUrl(typeof video?.url === "string" ? video.url : null);
        }
        if (status === "failed" || status === "nsfw" || status === "cancelled") {
          if (pollTimerRef.current) window.clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      } catch (statusError) {
        setError(statusError instanceof Error ? statusError.message : "Failed to poll Higgsfield status.");
      }
    }, 7000);
  }, []);

  async function submitToHiggsfield() {
    if (!brief) return;
    setSubmitting(true);
    setError("");
    setVideoUrl(null);
    try {
      const data = await readJsonData<GenerateResponse>(
        await fetch("/api/video/higgsfield/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            marketplaceListingId: brief.marketplaceListingId,
            durationSeconds: brief.generationSettings.durationSeconds,
          }),
        }),
      );
      setBrief(data.brief);
      const nextRequestId = data.higgsfield?.request_id ?? null;
      setRequestId(nextRequestId);
      setStatusText(nextRequestId ? "Higgsfield generation queued." : "Higgsfield returned a response.");
      if (data.higgsfield?.video?.url) {
        setVideoUrl(data.higgsfield.video.url);
      } else if (nextRequestId) {
        pollStatus(nextRequestId);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to submit generation.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyPrompt() {
    if (!brief) return;
    await navigator.clipboard.writeText(`${brief.prompt}\n\nNegative prompt:\n${brief.negativePrompt}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-border bg-[radial-gradient(circle_at_top_left,rgba(196,62,62,0.15),transparent_42%),linear-gradient(180deg,rgba(15,23,42,0.98),rgba(15,23,42,0.9))] p-6 shadow-sm xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#C43E3E]/35 bg-[#C43E3E]/12 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-red-100">
            <Video className="h-3.5 w-3.5" />
            Video
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            Product videos from top TPP eBay performers.
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Select a high-performing listing, review the generated creative prompt, then queue a 1080p Higgsfield product video.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:min-w-[520px] xl:grid-cols-4">
          <SettingPill label="Quality" value={connection?.quality ?? "1080p"} />
          <SettingPill label="Size" value={connection?.size ?? "1920x1080"} />
          <SettingPill label="Ratio" value={connection?.aspectRatio ?? "16:9"} />
          <div className={`rounded-lg border px-3 py-2 ${
            connection?.configured
              ? "border-emerald-500/25 bg-emerald-500/10"
              : "border-amber-500/25 bg-amber-500/10"
          }`}>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Higgsfield
            </p>
            <p className={connection?.configured ? "mt-1 text-sm font-medium text-emerald-200" : "mt-1 text-sm font-medium text-amber-200"}>
              {connection?.configured ? "Connected" : "Needs env"}
            </p>
          </div>
        </div>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      ) : null}

      {statusText ? (
        <div className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm ${
          coverage?.isStale
            ? "border-amber-500/25 bg-amber-500/10 text-amber-100"
            : "border-border bg-card text-muted-foreground"
        }`}>
          {coverage?.isStale ? (
            <AlertTriangle className="h-4 w-4 text-amber-200" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-300" />
          )}
          <span>{statusText}</span>
          {requestId ? <span className="ml-auto font-mono text-xs">Request {requestId}</span> : null}
        </div>
      ) : null}

      <div className="grid gap-4 2xl:grid-cols-[1.25fr_0.95fr]">
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Top TPP Items
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Ranked by units sold, then gross revenue.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(["7d", "30d", "90d"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setWindowDays(value)}
                  className={`cursor-pointer rounded-md border px-3 py-2 text-xs font-medium ${
                    windowDays === value
                      ? "border-[#C43E3E]/45 bg-[#C43E3E]/15 text-red-100"
                      : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  }`}
                >
                  {value.toUpperCase()}
                </button>
              ))}
              <button
                type="button"
                onClick={() => void loadItems()}
                className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/50"
              >
                {loadingItems ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="pb-3 pr-4">Listing</th>
                  <th className="pb-3 pr-4">Units</th>
                  <th className="pb-3 pr-4">Gross</th>
                  <th className="pb-3 pr-4">Orders</th>
                  <th className="pb-3 pr-4">Media</th>
                  <th className="pb-3">Open</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isSelected = item.marketplaceListingId === selectedId;
                  return (
                    <tr
                      key={`${item.sku}-${item.platformItemId ?? "none"}`}
                      className={`border-t border-border/70 align-top ${
                        isSelected ? "bg-[#C43E3E]/8" : "hover:bg-muted/30"
                      }`}
                    >
                      <td className="py-3 pr-4">
                        <button
                          type="button"
                          disabled={!item.marketplaceListingId}
                          onClick={() => item.marketplaceListingId && setSelectedId(item.marketplaceListingId)}
                          className="grid cursor-pointer grid-cols-[56px_1fr] gap-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
                            {item.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <ImageIcon className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium text-foreground">{item.sku}</div>
                            <div className="mt-0.5 max-w-[520px] truncate text-xs text-muted-foreground">
                              {item.title ?? "Untitled listing"}
                            </div>
                            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                              {item.platformItemId ?? "No item ID"}
                            </div>
                          </div>
                        </button>
                      </td>
                      <td className="py-3 pr-4 text-foreground">{item.unitsSold.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-emerald-300">{formatCurrency(item.grossRevenue)}</td>
                      <td className="py-3 pr-4 text-muted-foreground">{item.orderCount.toLocaleString()}</td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        <div className="flex flex-wrap gap-1.5">
                          <span className="rounded-full border border-border bg-background px-2 py-1 text-xs">
                            {item.photoCount} photos
                          </span>
                          {item.hasListingDescription ? (
                            <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-200">
                              Description
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="py-3">
                        {item.listingUrl ? (
                          <a
                            href={item.listingUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground hover:bg-muted/50"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            eBay
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {loadingItems ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading rankings...
              </div>
            ) : null}
            {!loadingItems && items.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {coverage?.message ?? "No current-window TPP eBay revenue lines were found."}
              </div>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Creative Brief
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selectedItem ? selectedItem.sku : "Select a listing"}
                </p>
              </div>
              {loadingBrief ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>

            {brief ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
                  <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-background">
                    {brief.imageUrls[0] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={brief.imageUrls[0]} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-medium text-foreground">{brief.title}</h3>
                    <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                      <span>Item {brief.platformItemId}</span>
                      <span>{brief.condition ?? "Condition unknown"}</span>
                      <span>{formatCurrency(brief.salePrice)}</span>
                      <span>{brief.inventory == null ? "Inventory unknown" : `${brief.inventory} in stock`}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {brief.itemSpecifics.slice(0, 5).map((entry) => (
                        <span key={`${entry.name}-${entry.value}`} className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground">
                          {entry.name}: {entry.value}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid gap-2 sm:grid-cols-4">
                  <SettingPill label="Model" value={brief.generationSettings.modelId} />
                  <SettingPill label="Quality" value={brief.generationSettings.quality} />
                  <SettingPill label="Size" value={brief.generationSettings.size} />
                  <SettingPill label="Length" value={`${brief.generationSettings.durationSeconds}s`} />
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyPrompt()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground hover:bg-muted/50"
                  >
                    <Copy className="h-4 w-4" />
                    {copied ? "Copied" : "Copy Prompt"}
                  </button>
                  <button
                    type="button"
                    disabled={!connection?.configured || submitting || brief.imageUrls.length === 0}
                    onClick={() => void submitToHiggsfield()}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-[#C43E3E]/35 bg-[#C43E3E] px-3 py-2 text-sm font-medium text-white hover:bg-[#aa3434] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
                    Generate
                  </button>
                  {videoUrl ? (
                    <a
                      href={videoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200 hover:bg-emerald-500/15"
                    >
                      <Play className="h-4 w-4" />
                      Open Video
                    </a>
                  ) : null}
                  {brief.listingUrl ? (
                    <a
                      href={brief.listingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground hover:bg-muted/50"
                    >
                      <ExternalLink className="h-4 w-4" />
                      eBay Listing
                    </a>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                {selectedItem?.marketplaceListingId ? "Building brief..." : "No TPP listing is selected."}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Prompt
              </h2>
              <Sparkles className="h-4 w-4 text-[#C43E3E]" />
            </div>
            <pre className="mt-4 max-h-[580px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background p-4 text-xs leading-5 text-foreground">
              {brief ? `${brief.prompt}\n\nNegative prompt:\n${brief.negativePrompt}` : "Select a TPP eBay listing to build a product video prompt."}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
