"use client";

import { useEffect, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { Copy, Check } from "lucide-react";
import { copySvgElementImage } from "@/lib/client-clipboard";

interface UpcCellProps {
  upc: string | null;
}

function CopyNotice({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span className="absolute -top-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-2 py-0.5 text-[10px] font-medium text-background shadow-lg">
      Copied!
    </span>
  );
}

export function UpcCell({ upc }: UpcCellProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [copied, setCopied] = useState(false);
  const [imageCopied, setImageCopied] = useState(false);

  useEffect(() => {
    if (!svgRef.current) return;

    if (!upc) {
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
    if (upc.length === 12) format = "UPC";
    else if (upc.length === 13) format = "EAN13";

    try {
      JsBarcode(svgRef.current, upc, { ...opts, format });
    } catch {
      try {
        JsBarcode(svgRef.current!, upc, { ...opts, format: "CODE128" });
      } catch {
        if (svgRef.current) svgRef.current.innerHTML = "";
      }
    }
  }, [upc]);

  function handleCopy() {
    if (!upc) return;
    navigator.clipboard.writeText(upc);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleCopyImage() {
    if (!upc || !svgRef.current) return;
    try {
      await copySvgElementImage(svgRef.current);
      setImageCopied(true);
      setTimeout(() => setImageCopied(false), 1500);
    } catch (error) {
      console.error("[upc-cell] failed to copy barcode image", error);
    }
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
        aria-label={upc ? `UPC barcode: ${upc}` : "No UPC available"}
      />
      {upc ? (
        <div className="flex items-center gap-1">
          <span className="font-mono text-xs font-medium text-foreground select-all">{upc}</span>
          <button
            onClick={handleCopy}
            className="rounded p-0.5 text-muted-foreground/40 transition-colors hover:text-foreground cursor-pointer"
            title="Copy UPC"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          </button>
        </div>
      ) : (
        <span className="text-[10px] font-medium text-muted-foreground/40 italic">No UPC</span>
      )}
    </div>
  );
}
