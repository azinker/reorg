"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";

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
  const isExpanded = expandedPhotoId === rowId;

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
      className="relative h-24 w-24 shrink-0 overflow-hidden rounded border border-border transition-all hover:ring-2 hover:ring-ring/50 cursor-pointer"
    >
      <img
        src={imageUrl}
        alt={alt}
        className="h-full w-full object-cover"
        onError={() => setImgError(true)}
      />
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
          src={imageUrl}
          alt={alt}
          className="max-h-[55vh] w-full object-contain"
          onContextMenu={(e) => {
            // Allow native right-click for "save image as"
          }}
        />
        <div className="border-t border-border bg-card/95 px-4 py-2">
          <p className="truncate text-xs text-muted-foreground">{alt}</p>
        </div>
      </div>
    </div>
  );
}
