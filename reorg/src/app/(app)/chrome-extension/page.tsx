"use client";

import { useState } from "react";
import {
  Puzzle,
  Download,
  Loader2,
  ExternalLink,
  CheckCircle2,
  FolderOpen,
  ToggleLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

const PRODUCTION_ORIGIN = "https://reorg.theperfectpart.net";

export default function ChromeExtensionPage() {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload() {
    setDownloadError(null);
    setDownloading(true);
    try {
      const res = await fetch("/api/chrome-extension/download", {
        credentials: "include",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(typeof j?.error === "string" ? j.error : `Download failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "reorg-chrome-extension.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="border-b border-border px-6 py-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
          <Puzzle className="h-6 w-6 shrink-0 text-[#C43E3E]" aria-hidden />
          Chrome extension
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Install the reorG Dashboard Link extension to jump from eBay, Shopify admin, or BigCommerce
          admin straight to the matching row on the dashboard—using an existing reorG tab when
          possible.
        </p>
      </div>

      <div className="mx-auto w-full max-w-3xl space-y-10 px-6 py-8">
        <section className="rounded-lg border border-border bg-card/40 p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Download
          </h2>
          <p className="mt-2 text-sm text-foreground">
            Download the extension package as a ZIP file. Unzip it, then in Chrome use{" "}
            <strong className="font-medium text-foreground">Load unpacked</strong> on the folder that{" "}
            <strong className="font-medium text-foreground">directly</strong> contains{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">manifest.json</code>{" "}
            (same level as <code className="font-mono text-xs">background.js</code>), not a parent
            folder and not the <code className="font-mono text-xs">.zip</code> file.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloading}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold transition-colors cursor-pointer",
                downloading
                  ? "cursor-wait bg-muted text-muted-foreground"
                  : "bg-violet-600 text-white hover:bg-violet-700",
              )}
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Download className="h-4 w-4" aria-hidden />
              )}
              {downloading ? "Preparing…" : "Download extension (ZIP)"}
            </button>
            {downloadError ? (
              <span className="text-sm text-red-600 dark:text-red-400">{downloadError}</span>
            ) : null}
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Install in Google Chrome
          </h2>
          <ol className="mt-4 space-y-4 text-sm text-foreground">
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600/15 text-xs font-bold text-violet-600 dark:text-violet-400">
                1
              </span>
              <div>
                <p className="font-medium">Unzip the download</p>
                <p className="mt-1 text-muted-foreground">
                  Extract <code className="font-mono text-xs">reorg-chrome-extension.zip</code>. Open
                  the extracted location until you see <code className="font-mono text-xs">
                    manifest.json
                  </code>{" "}
                  and <code className="font-mono text-xs">background.js</code> in the{" "}
                  <strong className="font-medium text-foreground">same</strong> folder — that is the
                  folder you will choose in the next step. If Windows created a nested folder, use the
                  inner one (Chrome shows &quot;Manifest file is missing&quot; if you pick the wrong
                  level).
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600/15 text-xs font-bold text-violet-600 dark:text-violet-400">
                2
              </span>
              <div>
                <p className="font-medium">Open Chrome Extensions</p>
                <p className="mt-1 text-muted-foreground">
                  In Chrome, go to{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    chrome://extensions
                  </code>{" "}
                  or Menu → Extensions → Manage extensions.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600/15 text-xs font-bold text-violet-600 dark:text-violet-400">
                3
              </span>
              <div>
                <p className="font-medium">Enable Developer mode</p>
                <p className="mt-1 text-muted-foreground">
                  Turn on <strong className="font-medium text-foreground">Developer mode</strong>{" "}
                  (toggle in the top-right on the extensions page).
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600/15 text-xs font-bold text-violet-600 dark:text-violet-400">
                4
              </span>
              <div>
                <p className="font-medium">Load unpacked</p>
                <p className="mt-1 text-muted-foreground">
                  Click <strong className="font-medium text-foreground">Load unpacked</strong> and
                  select that folder — the directory whose <strong className="font-medium text-foreground">
                    immediate
                  </strong>{" "}
                  children include <code className="font-mono text-xs">manifest.json</code>, not the{" "}
                  <code className="font-mono text-xs">.zip</code> and not a folder that only contains
                  another subfolder.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600/15 text-xs font-bold text-violet-600 dark:text-violet-400">
                5
              </span>
              <div>
                <p className="font-medium">Pin the extension (optional)</p>
                <p className="mt-1 text-muted-foreground">
                  Click the puzzle icon in Chrome’s toolbar and pin &quot;reorG Dashboard Link&quot;
                  for quick access while browsing listings.
                </p>
              </div>
            </li>
          </ol>
        </section>

        <section className="rounded-lg border border-border bg-card/40 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ToggleLeft className="h-4 w-4 text-[#C43E3E]" aria-hidden />
            Point the extension at reorG
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Right-click the extension icon → <strong className="text-foreground">Options</strong> (or
            use the link in the popup). Set{" "}
            <strong className="text-foreground">reorG base URL</strong> to:
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <span>
                Production:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {PRODUCTION_ORIGIN}
                </code>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">
                Local development: e.g.{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  http://localhost:3000
                </code>{" "}
                (no trailing slash).
              </span>
            </li>
          </ul>
          <p className="mt-4 text-sm text-muted-foreground">
            For <strong className="text-foreground">eBay</strong>, choose whether listings default to{" "}
            <strong className="text-foreground">TPP</strong> or <strong className="text-foreground">TT</strong>{" "}
            (public eBay URLs do not identify the store). For{" "}
            <strong className="text-foreground">BigCommerce</strong>, you can optionally restrict the
            admin hostname.
          </p>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Using the extension
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
            <li>
              Open a listing on eBay, Shopify admin, or BigCommerce admin (product edit page).
            </li>
            <li>
              Use the purple <strong className="text-foreground">Open in reorG</strong> floating button
              (bottom-right on the listing page), or open the extension popup and click the same label.
            </li>
            <li>
              If you already have a tab on the <strong className="text-foreground">dashboard</strong>, that
              tab is focused and the grid scrolls to the row <strong className="text-foreground">without
              reloading</strong> the dashboard. If the reorG tab was on another page, it navigates to the
              dashboard once.
            </li>
            <li>Stay logged into reorG in Chrome.</li>
          </ul>
        </section>

        <section className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <p>
            Updates: after the developer replaces the extension files, open{" "}
            <code className="font-mono">chrome://extensions</code> and click{" "}
            <strong className="text-foreground">Reload</strong> on reorG Dashboard Link, or remove
            and load unpacked again from a fresh unzip.
          </p>
        </section>

        <p className="text-xs text-muted-foreground">
          More detail: see{" "}
          <code className="rounded bg-muted px-1 font-mono">reorg/chrome-extension/README.md</code> in
          the repository.
        </p>

        <a
          href={PRODUCTION_ORIGIN}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300 cursor-pointer"
        >
          Open reorG production
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}
