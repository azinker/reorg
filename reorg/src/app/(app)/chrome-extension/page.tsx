"use client";

import { useState } from "react";
import type { ComponentType } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  PackageSearch,
  Puzzle,
  ToggleLeft,
  Warehouse,
  MapPinned,
} from "lucide-react";
import { cn } from "@/lib/utils";

const PRODUCTION_ORIGIN = "https://reorg.theperfectpart.net";

type ExtensionId = "catalog-link" | "sale-history" | "skuvault" | "tracking-check";

const EXTENSIONS: Array<{
  id: ExtensionId;
  name: string;
  filename: string;
  accent: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  description: string;
  usage: string[];
}> = [
  {
    id: "catalog-link",
    name: "reorG Catalog Link",
    filename: "reorg-chrome-extension.zip",
    accent: "bg-violet-600 text-white hover:bg-violet-700",
    icon: Puzzle,
    description:
      "Jump from eBay, Shopify admin, or BigCommerce admin straight to the matching reorG catalog row.",
    usage: [
      "Open a supported listing page.",
      "Click the floating Open in reorG button or the extension popup.",
      "Set the reorG base URL in extension options if needed.",
    ],
  },
  {
    id: "sale-history",
    name: "THE PERFECT PART - eBay Sold History",
    filename: "tpp-ebay-sold-history-extension.zip",
    accent: "bg-blue-600 text-white hover:bg-blue-700",
    icon: PackageSearch,
    description:
      "Adds sold-history navigation and a last-30-days sales summary to eBay listing and purchase history pages.",
    usage: [
      "Open an eBay listing page.",
      "Use the sold-history controls added by the extension.",
      "Review the purchase-history summary on eBay sold history pages.",
    ],
  },
  {
    id: "skuvault",
    name: "SKUVAULT Quick Adjust",
    filename: "skuvault-quick-adjust-extension.zip",
    accent: "bg-emerald-600 text-white hover:bg-emerald-700",
    icon: Warehouse,
    description:
      "Quick popup for SkuVault SKU lookup plus add/remove quantity in WH3, location 12126.",
    usage: [
      "Stay logged into reorG in Chrome.",
      "Enter a SKU to load current on-hand quantity.",
      "Enter a quantity, then click ADD or REMOVE.",
    ],
  },
  {
    id: "tracking-check",
    name: "Tracking Check Helper",
    filename: "reorg-tracking-check-helper.zip",
    accent: "bg-cyan-700 text-white hover:bg-cyan-800",
    icon: MapPinned,
    description:
      "Creates temporary eBay session text files so Tracking Check can read scan history from your logged-in browser.",
    usage: [
      "Run it in normal Chrome while logged into TPP eBay.",
      "Enable it in Incognito and run it there while logged into TT eBay.",
      "Upload both downloaded .txt files on the Tracking Check page.",
    ],
  },
];

export default function ChromeExtensionPage() {
  const [downloading, setDownloading] = useState<ExtensionId | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function handleDownload(extension: (typeof EXTENSIONS)[number]) {
    setDownloadError(null);
    setDownloading(extension.id);
    try {
      const params = new URLSearchParams({ extension: extension.id });
      const res = await fetch(`/api/chrome-extension/download?${params}`, {
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
      a.download = extension.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="border-b border-border px-6 py-5">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
          <Puzzle className="h-6 w-6 shrink-0 text-[#C43E3E]" aria-hidden />
          Chrome Extensions
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Download and install the internal Chrome extensions used with reorG, eBay, and SkuVault.
        </p>
      </div>

      <div className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
        <section className="grid gap-4 lg:grid-cols-4">
          {EXTENSIONS.map((extension) => {
            const Icon = extension.icon;
            const isDownloading = downloading === extension.id;
            return (
              <article key={extension.id} className="rounded-lg border border-border bg-card/40 p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-md bg-muted p-2">
                    <Icon className="h-5 w-5 text-[#C43E3E]" aria-hidden />
                  </div>
                  <div>
                    <h2 className="text-base font-semibold text-foreground">{extension.name}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{extension.filename}</p>
                  </div>
                </div>
                <p className="mt-4 text-sm text-muted-foreground">{extension.description}</p>
                <button
                  type="button"
                  onClick={() => void handleDownload(extension)}
                  disabled={downloading !== null}
                  className={cn(
                    "mt-5 inline-flex h-10 cursor-pointer items-center gap-2 rounded-md px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    extension.accent,
                  )}
                >
                  {isDownloading ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="h-4 w-4" aria-hidden />
                  )}
                  {isDownloading ? "Preparing..." : "Download ZIP"}
                </button>
              </article>
            );
          })}
        </section>

        {downloadError ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {downloadError}
          </div>
        ) : null}

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Install in Google Chrome
          </h2>
          <ol className="mt-4 grid gap-4 text-sm text-foreground md:grid-cols-2">
            {[
              ["Unzip the download", "Extract the ZIP. Open the extracted location until you see manifest.json in the folder."],
              ["Open Chrome Extensions", "Go to chrome://extensions or Menu > Extensions > Manage extensions."],
              ["Enable Developer mode", "Turn on Developer mode using the toggle in the top-right on the extensions page."],
              ["Load unpacked", "Click Load unpacked and choose the folder whose immediate children include manifest.json."],
              ["Pin the extension", "Click the Chrome puzzle icon and pin whichever extension you use often."],
              ["Allow Incognito when needed", "For Tracking Check Helper, open Details on the extension and turn on Allow in Incognito for the TT browser window."],
              ["Reload after updates", "After downloading a newer ZIP, remove the old unpacked extension or click Reload after replacing files."],
            ].map(([title, body], index) => (
              <li key={title} className="flex gap-3 rounded-lg border border-border bg-card/30 p-4">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-600/15 text-xs font-bold text-violet-600 dark:text-violet-400">
                  {index + 1}
                </span>
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="mt-1 text-muted-foreground">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-lg border border-border bg-card/40 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ToggleLeft className="h-4 w-4 text-[#C43E3E]" aria-hidden />
            Catalog Link settings
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Right-click reorG Catalog Link, open Options, and set the reorG base URL to:
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
                Local development:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  http://localhost:3000
                </code>{" "}
                with no trailing slash.
              </span>
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Using each extension
          </h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-4">
            {EXTENSIONS.map((extension) => (
              <article key={extension.id} className="rounded-lg border border-border bg-card/30 p-4">
                <h3 className="text-sm font-semibold text-foreground">{extension.name}</h3>
                <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted-foreground">
                  {extension.usage.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <p>
            SKUVAULT credentials are never included in the Chrome extension. The popup talks to
            authenticated reorG server routes, and reorG performs the SkuVault API calls.
          </p>
        </section>

        <a
          href={PRODUCTION_ORIGIN}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-violet-600 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
        >
          Open reorG production
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
    </div>
  );
}
