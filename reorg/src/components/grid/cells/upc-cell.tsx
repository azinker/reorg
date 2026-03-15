"use client";

import { useEffect, useRef } from "react";
import JsBarcode from "jsbarcode";

interface UpcCellProps {
  upc: string | null;
}

export function UpcCell({ upc }: UpcCellProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !upc) return;

    let format = "CODE128";
    if (upc.length === 12) format = "UPC";
    else if (upc.length === 13) format = "EAN13";

    try {
      JsBarcode(svgRef.current, upc, {
        format,
        width: 1.2,
        height: 30,
        displayValue: false,
        margin: 2,
        background: "transparent",
        lineColor: "currentColor",
      });
    } catch {
      if (svgRef.current) svgRef.current.innerHTML = "";
    }
  }, [upc]);

  if (!upc) {
    return (
      <div className="flex h-full items-center">
        <span className="text-[11px] text-muted-foreground/50 italic">No UPC</span>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center gap-0.5 text-foreground"
      onContextMenu={(e) => {
        e.preventDefault();
        navigator.clipboard.writeText(upc);
      }}
      title={`Right-click to copy: ${upc}`}
    >
      <svg ref={svgRef} className="h-[30px] w-full max-w-[100px]" />
      <span className="font-mono text-[10px] text-muted-foreground select-all">{upc}</span>
    </div>
  );
}
