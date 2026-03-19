"use client";

import { useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import {
  copyImageFromUrl,
  copyRenderedImageElement,
  getImageProxyUrl,
} from "@/lib/client-clipboard";

interface PhotoCellProps {
  imageUrl: string | null;
  alt: string;
  imageSource?: string;
  rowId: string;
  expandedPhotoId: string | null;
  onToggleExpand: (rowId: string | null) => void;
}

export function PhotoCell({ imageUrl, alt, imageSource, rowId, expandedPhotoId, onToggleExpand }: PhotoCellProps) {
  const [imgError, setImgError] = useState(false);
  const [copiedImage, setCopiedImage] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const isExpanded = expandedPhotoId === rowId;
  const displayImageUrl = useMemo(() => (imageUrl ? getImageProxyUrl(imageUrl) : null), [imageUrl]);

  async function handleCopyImage() {
    if (!imageUrl) return;
    try {
      const imageElement = imageRef.current;
      if (imageElement && imageElement.complete && imageElement.naturalWidth > 0) {
        await copyRenderedImageElement(imageElement);
      } else {
        await copyImageFromUrl(imageUrl);
      }
      setCopiedImage(true);
      window.setTimeout(() => setCopiedImage(false), 1500);
    } catch (error) {
      console.error("[photo-cell] failed to copy image", error);
    }
  }

  if (!imageUrl || imgError) {
    return (
      <div className="flex h-24 w-24 items-center justify-center rounded border border-border/50 bg-muted/50">
        <ImageOff className="h-8 w-8 text-muted-foreground/30" />
      </div>
    );
  }

  return (
    <button
      onClick={() => onToggleExpand(isExpanded ? null : rowId)}
      className="relative h-24 w-24 shrink-0 cursor-pointer overflow-hidden rounded border border-border transition-all hover:ring-2 hover:ring-ring/50"
      title="Left click to enlarge. Right click to copy image."
      onMouseDown={(e) => {
        if (e.button === 2) {
          e.preventDefault();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void handleCopyImage();
      }}
    >
      <img
        ref={imageRef}
        src={displayImageUrl ?? imageUrl}
        alt={alt}
        className="h-full w-full object-cover"
        onError={() => setImgError(true)}
        onContextMenu={(e) => {
          e.preventDefault();
          void handleCopyImage();
        }}
      />
      {copiedImage && (
        <span className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded bg-foreground px-2 py-0.5 text-[10px] font-medium text-background shadow-lg">
          Image copied
        </span>
      )}
      {imageSource && imageSource !== "master" && (
        <span className="absolute bottom-0 right-0 rounded-tl bg-amber-500/80 px-0.5 text-[8px] font-bold text-white">
          FB
        </span>
      )}
    </button>
  );
}

interface PhotoOverlayProps {
  imageUrl: string;
  alt: string;
  onClose: () => void;
}

export function PhotoOverlay({ imageUrl, alt, onClose }: PhotoOverlayProps) {
  const [copiedImage, setCopiedImage] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const displayImageUrl = useMemo(() => getImageProxyUrl(imageUrl), [imageUrl]);

  async function handleCopyImage() {
    try {
      const imageElement = imageRef.current;
      if (imageElement && imageElement.complete && imageElement.naturalWidth > 0) {
        await copyRenderedImageElement(imageElement);
      } else {
        await copyImageFromUrl(imageUrl);
      }
      setCopiedImage(true);
      window.setTimeout(() => setCopiedImage(false), 1500);
    } catch (error) {
      console.error("[photo-overlay] failed to copy image", error);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="relative max-h-[60vh] max-w-[500px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-background/90 text-foreground shadow transition-colors hover:bg-background cursor-pointer"
          title="Close (Esc)"
        >
          <span className="text-sm font-bold">&times;</span>
        </button>
        <img
          ref={imageRef}
          src={displayImageUrl}
          alt={alt}
          className="max-h-[55vh] w-full object-contain"
          onMouseDown={(e) => {
            if (e.button === 2) {
              e.preventDefault();
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            void handleCopyImage();
          }}
        />
        {copiedImage && (
          <div className="absolute left-1/2 top-12 z-10 -translate-x-1/2 rounded bg-foreground px-2.5 py-1 text-[11px] font-medium text-background shadow-lg">
            Image copied
          </div>
        )}
        <div className="border-t border-border bg-card/95 px-4 py-2">
          <p className="truncate text-xs text-muted-foreground">{alt}</p>
        </div>
      </div>
    </div>
  );
}
