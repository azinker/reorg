"use client";

/**
 * Render inbound message attachments (always shown, regardless of the
 * outbound-attachment feature flag). eBay messages only ever have image
 * URLs; we intentionally do not download/proxy them — buyers' images are
 * served from eBay's own CDN, which is also what the buyer sees in the
 * eBay UI.
 *
 * Validates URLs minimally: must parse, must be http/https. Anything else
 * is rendered as a plain link to avoid mixed-content surprises.
 */

import { useState } from "react";
import { ExternalLink, Image as ImageIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { parseMedia, truncateMid } from "@/lib/helpdesk/attachments";

interface AttachmentsProps {
  rawMedia: unknown;
  /**
   * When true, suppresses the image grid. Use this from any caller that
   * already renders image attachments via a sibling component (e.g. the
   * ThreadView inline-image gallery strip). Without this, images render
   * twice — once at h-32 w-32 in the gallery and once at h-16 w-16 here
   * — which is the exact "duplicate small thumbnails under big previews"
   * Adam reported.
   *
   * Non-image attachments (PDFs, zips, etc.) still render regardless,
   * since nothing else handles those.
   */
  excludeImages?: boolean;
}

export function Attachments({ rawMedia, excludeImages = false }: AttachmentsProps) {
  const [zoomed, setZoomed] = useState<string | null>(null);
  const items = parseMedia(rawMedia);
  if (items.length === 0) return null;

  const images = excludeImages ? [] : items.filter((i) => i.isImage);
  const others = items.filter((i) => !i.isImage);

  // If there's nothing left to render after filtering, bail to avoid
  // emitting an empty wrapper div that adds vertical space below bubbles.
  if (images.length === 0 && others.length === 0) return null;

  return (
    <div className="mt-2 space-y-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img) => (
            <button
              type="button"
              key={img.url}
              onClick={() => setZoomed(img.url)}
              className={cn(
                "group relative h-16 w-16 overflow-hidden rounded border border-hairline bg-surface-2 cursor-pointer transition-colors hover:border-brand/50",
              )}
              title="Click to enlarge"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt="Buyer attachment"
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                  const parent = e.currentTarget.parentElement;
                  if (parent && !parent.querySelector(".broken-fallback")) {
                    const span = document.createElement("span");
                    span.className =
                      "broken-fallback flex h-full w-full items-center justify-center text-[9px] text-muted-foreground";
                    span.textContent = "failed";
                    parent.appendChild(span);
                  }
                }}
              />
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="space-y-1">
          {others.map((o) => (
            <li key={o.url}>
              <a
                href={o.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-hairline bg-surface px-2 py-1 text-[10px] text-foreground transition-colors hover:bg-surface-2"
              >
                <ExternalLink className="h-3 w-3" />
                {truncateMid(o.url, 60)}
              </a>
            </li>
          ))}
        </ul>
      )}

      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomed(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setZoomed(null);
          }}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setZoomed(null);
            }}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 cursor-pointer"
            aria-label="Close attachment viewer"
          >
            <X className="h-4 w-4" />
          </button>
          <div
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
            className="max-h-[90vh] max-w-[90vw]"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={zoomed}
              alt="Buyer attachment"
              className="max-h-[90vh] max-w-[90vw] object-contain"
              referrerPolicy="no-referrer"
            />
            <a
              href={zoomed}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-white/70 hover:text-white"
            >
              <ImageIcon className="h-3 w-3" />
              Open original
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

