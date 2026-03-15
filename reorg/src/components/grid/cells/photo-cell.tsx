"use client";

import { useState, useCallback, useEffect } from "react";
import { ImageOff, X } from "lucide-react";

interface PhotoCellProps {
  imageUrl: string | null;
  alt: string;
  imageSource?: string;
}

export function PhotoCell({ imageUrl, alt, imageSource }: PhotoCellProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [imgError, setImgError] = useState(false);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalOpen) setModalOpen(false);
    },
    [modalOpen]
  );

  useEffect(() => {
    if (modalOpen) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [modalOpen, handleKeyDown]);

  if (!imageUrl || imgError) {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded bg-muted">
        <ImageOff className="h-4 w-4 text-muted-foreground/40" />
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        className="relative h-10 w-10 shrink-0 overflow-hidden rounded border border-border transition-opacity hover:opacity-80 cursor-pointer"
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

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setModalOpen(false)}
        >
          <div
            className="relative max-h-[80vh] max-w-[80vw] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setModalOpen(false)}
              className="absolute right-3 top-3 z-10 rounded-full bg-background/80 p-1.5 text-foreground transition-colors hover:bg-background cursor-pointer"
            >
              <X className="h-4 w-4" />
            </button>
            <img
              src={imageUrl}
              alt={alt}
              className="max-h-[75vh] max-w-[75vw] object-contain"
            />
          </div>
        </div>
      )}
    </>
  );
}
