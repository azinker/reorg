"use client";

import { useCallback, useMemo, useState } from "react";
import {
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  FileSearch,
  Loader2,
  Send,
  Store,
} from "lucide-react";
import { cn } from "@/lib/utils";

type EbayPlatform = "TPP_EBAY" | "TT_EBAY";

const PLATFORM_LABEL: Record<EbayPlatform, string> = {
  TPP_EBAY: "TPP eBay",
  TT_EBAY: "TT eBay",
};

const STEPS = [
  { id: 1, label: "Route & source", icon: ArrowLeftRight },
  { id: 2, label: "Verify preview", icon: FileSearch },
  { id: 3, label: "Publish", icon: Send },
  { id: 4, label: "Result", icon: CheckCircle2 },
] as const;

type PreviewPayload = {
  ok: boolean;
  ack: string;
  errors: string[];
  fees?: unknown;
  summary: {
    title: string;
    sourceItemId: string;
    pictureUrlCount: number;
    listingSpecificRowCount: number;
    hasVariations: boolean;
    variationCount: number;
  };
};

export default function ListingClonePage() {
  const [currentStep, setCurrentStep] = useState(1);
  const [sourcePlatform, setSourcePlatform] = useState<EbayPlatform>("TPP_EBAY");
  const [targetPlatform, setTargetPlatform] = useState<EbayPlatform>("TT_EBAY");
  const [sourceItemId, setSourceItemId] = useState("");
  const [skipPictureUpload, setSkipPictureUpload] = useState(false);
  const [itemTypeAspect, setItemTypeAspect] = useState("");
  const [policySourceItemId, setPolicySourceItemId] = useState("");
  const [shippingPolicyId, setShippingPolicyId] = useState("");
  const [returnPolicyId, setReturnPolicyId] = useState("");
  const [paymentPolicyId, setPaymentPolicyId] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [executeLoading, setExecuteLoading] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [confirmedLive, setConfirmedLive] = useState(false);
  const [newItemId, setNewItemId] = useState<string | null>(null);

  const ebayPairsEnabled = true;

  const patchOppositePlatform = useCallback(
    (role: "source" | "target", value: EbayPlatform) => {
      if (role === "source") {
        setSourcePlatform(value);
        setTargetPlatform((prev) => (prev === value ? (value === "TPP_EBAY" ? "TT_EBAY" : "TPP_EBAY") : prev));
      } else {
        setTargetPlatform(value);
        setSourcePlatform((prev) => (prev === value ? (value === "TPP_EBAY" ? "TT_EBAY" : "TPP_EBAY") : prev));
      }
    },
    [],
  );

  function swapRoute() {
    setSourcePlatform(targetPlatform);
    setTargetPlatform(sourcePlatform);
    setPreviewResult(null);
    setPreviewError(null);
    setExecuteError(null);
    setNewItemId(null);
    setConfirmedLive(false);
  }

  const feesSnippet = useMemo(() => {
    if (!previewResult?.fees) return null;
    try {
      return JSON.stringify(previewResult.fees).slice(0, 1400);
    } catch {
      return String(previewResult.fees);
    }
  }, [previewResult]);

  async function runPreview() {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewResult(null);
    setExecuteError(null);
    setNewItemId(null);
    setConfirmedLive(false);
    try {
      const res = await fetch("/api/listing-clone/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePlatform,
          targetPlatform,
          sourceItemId: sourceItemId.trim(),
          skipPictureUpload,
          itemTypeAspect: itemTypeAspect.trim() || undefined,
          policySourceItemId: policySourceItemId.trim() || undefined,
          shippingPolicyId: shippingPolicyId.trim() || undefined,
          returnPolicyId: returnPolicyId.trim() || undefined,
          paymentPolicyId: paymentPolicyId.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof json.error === "string" ? json.error : "Preview failed.");
      }
      if (!json.data) throw new Error("Invalid preview response.");
      setPreviewResult(json.data as PreviewPayload);
      setCurrentStep(2);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : "Preview failed.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function runExecute() {
    if (!confirmedLive) return;
    setExecuteLoading(true);
    setExecuteError(null);
    setNewItemId(null);
    try {
      const res = await fetch("/api/listing-clone/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourcePlatform,
          targetPlatform,
          sourceItemId: sourceItemId.trim(),
          confirmedLivePush: true,
          skipPictureUpload,
          itemTypeAspect: itemTypeAspect.trim() || undefined,
          policySourceItemId: policySourceItemId.trim() || undefined,
          shippingPolicyId: shippingPolicyId.trim() || undefined,
          returnPolicyId: returnPolicyId.trim() || undefined,
          paymentPolicyId: paymentPolicyId.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof json.error === "string" ? json.error : "Publish failed.");
      }
      const itemId = json.data?.newItemId as string | undefined;
      setNewItemId(itemId ?? null);
      setCurrentStep(4);
    } catch (e) {
      setExecuteError(e instanceof Error ? e.message : "Publish failed.");
    } finally {
      setExecuteLoading(false);
    }
  }

  const listingUrl =
    newItemId != null && newItemId !== ""
      ? `https://www.ebay.com/itm/${newItemId}`
      : null;

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Listing Clone</h1>
        <p className="text-sm text-muted-foreground">
          Clone fixed-price eBay listings between accounts with Trading API verify-first safety.
        </p>
      </div>

      <div
        className="mb-6 rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
        role="status"
      >
        This creates a <strong className="font-semibold text-foreground">new listing</strong> on the
        destination account (insertion fees may apply). It never deletes or modifies the source
        listing. Publishing respects global and per-store write locks, staging blocks, and the same{" "}
        <strong className="font-semibold text-foreground">live push</strong> gate as Catalog.
      </div>

      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-0">
          {STEPS.map((step, index) => {
            const isActive = step.id === currentStep;
            const isCompleted = step.id < currentStep;
            const Icon = step.icon;
            return (
              <div key={step.id} className="flex flex-1 items-center">
                <button
                  type="button"
                  onClick={() => setCurrentStep(step.id)}
                  aria-label={`Go to step ${step.id}: ${step.label}`}
                  aria-current={isActive ? "step" : undefined}
                  className={cn(
                    "group flex flex-1 cursor-pointer flex-col items-center gap-2 rounded py-2",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                      isActive && "border-primary bg-primary text-primary-foreground",
                      isCompleted && "border-green-500/50 bg-green-500/20 text-green-600 dark:text-green-400",
                      !isActive &&
                        !isCompleted &&
                        "border-border bg-muted/50 text-muted-foreground group-hover:border-muted-foreground/50",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                  </div>
                  <span
                    className={cn(
                      "text-xs font-medium",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                </button>
                {index < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "h-0.5 min-w-[20px] flex-1",
                      step.id < currentStep ? "bg-green-500/40" : "bg-border",
                    )}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <section className="mb-8 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-foreground">Route</h2>
          </div>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                From
              </span>
              <select
                value={sourcePlatform}
                onChange={(e) =>
                  patchOppositePlatform("source", e.target.value as EbayPlatform)
                }
                disabled={!ebayPairsEnabled}
                className={cn(
                  "cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {(Object.keys(PLATFORM_LABEL) as EbayPlatform[]).map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={swapRoute}
              className={cn(
                "inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground",
                "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              aria-label="Swap source and destination"
            >
              <ArrowLeftRight className="h-4 w-4" aria-hidden />
              Swap
            </button>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                To
              </span>
              <select
                value={targetPlatform}
                onChange={(e) =>
                  patchOppositePlatform("target", e.target.value as EbayPlatform)
                }
                disabled={!ebayPairsEnabled}
                className={cn(
                  "cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                {(Object.keys(PLATFORM_LABEL) as EbayPlatform[]).map((p) => (
                  <option key={p} value={p}>
                    {PLATFORM_LABEL[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">More destinations</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { from: "TT eBay", to: "BigCommerce" },
                { from: "TPP eBay", to: "BigCommerce" },
                { from: "TT eBay", to: "Shopify" },
                { from: "TPP eBay", to: "Shopify" },
              ].map((route) => (
                <div
                  key={`${route.from}-${route.to}`}
                  className="rounded-lg border border-border bg-muted/20 px-4 py-3 opacity-60"
                  aria-disabled="true"
                >
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Store className="h-4 w-4 shrink-0" aria-hidden />
                    <span>
                      {route.from} → {route.to}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-medium text-muted-foreground/90">
                    Coming soon — same verify → confirm flow when product creates ship.
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {currentStep === 1 && (
          <div className="space-y-6">
            <div>
              <label htmlFor="source-item-id" className="text-sm font-medium text-foreground">
                Source Item ID
              </label>
              <input
                id="source-item-id"
                type="text"
                inputMode="numeric"
                pattern="\d*"
                placeholder="e.g. 204226527330"
                value={sourceItemId}
                onChange={(e) => setSourceItemId(e.target.value.replace(/\D/g, ""))}
                className={cn(
                  "mt-2 w-full max-w-md rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Numeric eBay Item ID from <strong>{PLATFORM_LABEL[sourcePlatform]}</strong>.
              </p>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={skipPictureUpload}
                onChange={(e) => setSkipPictureUpload(e.target.checked)}
                className="cursor-pointer rounded border-border"
              />
              Skip picture re-upload (only if Verify succeeds without EPS — uncommon)
            </label>

            <div className="rounded-lg border border-border bg-muted/20">
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className={cn(
                  "flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left text-sm font-medium text-foreground",
                  "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                )}
              >
                Advanced options
                <span className="text-muted-foreground">{advancedOpen ? "−" : "+"}</span>
              </button>
              {advancedOpen && (
                <div className="space-y-4 border-t border-border px-4 py-4">
                  <div>
                    <label htmlFor="item-type" className="text-xs font-medium text-muted-foreground">
                      Item specifics “Type” override (optional)
                    </label>
                    <input
                      id="item-type"
                      type="text"
                      value={itemTypeAspect}
                      onChange={(e) => setItemTypeAspect(e.target.value)}
                      className={cn(
                        "mt-1 w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                      placeholder="Exact aspect value if Verify requires listing-level Type"
                    />
                  </div>
                  <div>
                    <label htmlFor="policy-source" className="text-xs font-medium text-muted-foreground">
                      Policy source Item ID on{" "}
                      <strong>{PLATFORM_LABEL[targetPlatform]}</strong> (optional)
                    </label>
                    <input
                      id="policy-source"
                      type="text"
                      inputMode="numeric"
                      value={policySourceItemId}
                      onChange={(e) => setPolicySourceItemId(e.target.value.replace(/\D/g, ""))}
                      className={cn(
                        "mt-1 w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      )}
                      placeholder="Existing listing to copy SellerProfiles from"
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <label htmlFor="ship-pol" className="text-xs text-muted-foreground">
                        Shipping policy ID
                      </label>
                      <input
                        id="ship-pol"
                        type="text"
                        value={shippingPolicyId}
                        onChange={(e) => setShippingPolicyId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="ret-pol" className="text-xs text-muted-foreground">
                        Return policy ID
                      </label>
                      <input
                        id="ret-pol"
                        type="text"
                        value={returnPolicyId}
                        onChange={(e) => setReturnPolicyId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                    <div>
                      <label htmlFor="pay-pol" className="text-xs text-muted-foreground">
                        Payment policy ID
                      </label>
                      <input
                        id="pay-pol"
                        type="text"
                        value={paymentPolicyId}
                        onChange={(e) => setPaymentPolicyId(e.target.value)}
                        className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {previewError && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {previewError}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={previewLoading || sourceItemId.trim().length < 10}
                onClick={() => void runPreview()}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground",
                  "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  (previewLoading || sourceItemId.trim().length < 10) &&
                    "cursor-not-allowed opacity-50",
                )}
              >
                {previewLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Running verify…
                  </>
                ) : (
                  <>
                    <FileSearch className="h-4 w-4" aria-hidden />
                    Run verify preview
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {currentStep === 2 && (
          <div className="space-y-4">
            {!previewResult ? (
              <p className="text-sm text-muted-foreground">
                No preview yet. Go back to step 1 and run verify.
              </p>
            ) : (
              <>
                <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-100">
                  VerifyAck: <strong className="text-foreground">{previewResult.ack}</strong>
                </div>
                <dl className="grid gap-2 text-sm">
                  <div className="flex flex-wrap gap-2">
                    <dt className="text-muted-foreground">Title</dt>
                    <dd className="font-medium text-foreground">{previewResult.summary.title}</dd>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <dt className="text-muted-foreground">Variations</dt>
                    <dd className="text-foreground">
                      {previewResult.summary.hasVariations
                        ? `${previewResult.summary.variationCount} SKU(s)`
                        : "Single SKU"}
                    </dd>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <dt className="text-muted-foreground">Pictures</dt>
                    <dd className="text-foreground">{previewResult.summary.pictureUrlCount}</dd>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <dt className="text-muted-foreground">Listing specifics rows</dt>
                    <dd className="text-foreground">
                      {previewResult.summary.listingSpecificRowCount}
                    </dd>
                  </div>
                </dl>
                {previewResult.errors.length > 0 && (
                  <div className="rounded-md border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm">
                    <p className="font-medium text-foreground">Warnings / messages</p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                      {previewResult.errors.map((msg, i) => (
                        <li key={i}>{msg}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {feesSnippet && (
                  <details className="rounded-md border border-border bg-muted/30 px-4 py-3 text-xs">
                    <summary className="cursor-pointer font-medium text-foreground">
                      Fees snippet (truncated)
                    </summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-muted-foreground">
                      {feesSnippet}
                    </pre>
                  </details>
                )}
              </>
            )}
            <div className="flex flex-wrap gap-3 pt-4">
              <button
                type="button"
                onClick={() => setCurrentStep(1)}
                className={cn(
                  "cursor-pointer rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                Back
              </button>
              <button
                type="button"
                disabled={!previewResult}
                onClick={() => setCurrentStep(3)}
                className={cn(
                  "cursor-pointer rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !previewResult && "cursor-not-allowed opacity-50",
                )}
              >
                Continue to publish
              </button>
            </div>
          </div>
        )}

        {currentStep === 3 && (
          <div className="space-y-6">
            {!previewResult ? (
              <p className="text-sm text-muted-foreground">
                No verify preview loaded. Use step 1 to run verify, then continue from step 2.
              </p>
            ) : (
              <>
            <div className="rounded-lg border border-border bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Summary</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>
                  Copy from{" "}
                  <strong className="text-foreground">{PLATFORM_LABEL[sourcePlatform]}</strong> Item{" "}
                  <strong className="text-foreground">{sourceItemId.trim() || "—"}</strong>
                </li>
                <li>
                  Publish on{" "}
                  <strong className="text-foreground">{PLATFORM_LABEL[targetPlatform]}</strong>
                </li>
                <li>
                  Title preview:{" "}
                  <strong className="text-foreground">{previewResult.summary.title}</strong>
                </li>
              </ul>
            </div>

            <label className="flex cursor-pointer items-start gap-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={confirmedLive}
                onChange={(e) => setConfirmedLive(e.target.checked)}
                className="mt-1 cursor-pointer rounded border-border"
              />
              <span>
                I confirm I want to create this listing live on{" "}
                <strong>{PLATFORM_LABEL[targetPlatform]}</strong>. I understand insertion fees may
                apply, and that this uses the same live-push approval gate as Catalog changes.
              </span>
            </label>

            {executeError && (
              <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                {executeError}
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setCurrentStep(2)}
                className={cn(
                  "cursor-pointer rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                Back
              </button>
              <button
                type="button"
                disabled={executeLoading || !confirmedLive || !previewResult}
                onClick={() => void runExecute()}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground",
                  "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  (executeLoading || !confirmedLive || !previewResult) &&
                    "cursor-not-allowed opacity-50",
                )}
              >
                {executeLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Publishing…
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" aria-hidden />
                    Publish listing
                  </>
                )}
              </button>
            </div>
              </>
            )}
          </div>
        )}

        {currentStep === 4 && (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-500/35 bg-green-500/10 px-4 py-4 text-sm text-green-100">
              Listing publish finished.
              {newItemId ? (
                <>
                  {" "}
                  New Item ID:{" "}
                  <strong className="font-mono text-foreground">{newItemId}</strong>
                </>
              ) : (
                <span className="text-muted-foreground"> Item ID not returned — check audit logs.</span>
              )}
            </div>
            {listingUrl && (
              <div className="flex flex-wrap gap-3">
                <a
                  href={listingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted",
                  )}
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Open on eBay
                </a>
                <button
                  type="button"
                  onClick={() =>
                    newItemId &&
                    void navigator.clipboard.writeText(newItemId).catch(() => {})
                  }
                  disabled={!newItemId}
                  className={cn(
                    "cursor-pointer rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted",
                    !newItemId && "cursor-not-allowed opacity-50",
                  )}
                >
                  Copy Item ID
                </button>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              Run <strong className="text-foreground">Sync</strong> for{" "}
              {PLATFORM_LABEL[targetPlatform]} when you want this listing in the main catalog grid.
            </p>
            <button
              type="button"
              onClick={() => {
                setCurrentStep(1);
                setPreviewResult(null);
                setPreviewError(null);
                setExecuteError(null);
                setConfirmedLive(false);
                setNewItemId(null);
              }}
              className={cn(
                "cursor-pointer rounded-lg bg-muted px-4 py-2 text-sm font-medium text-foreground hover:bg-muted/80",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              Clone another
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
