"use client";

import { useState } from "react";
import { Info } from "lucide-react";

interface HeaderTooltipProps {
  text: string;
}

export function HeaderTooltip({ text }: HeaderTooltipProps) {
  const [show, setShow] = useState(false);

  return (
    <span className="relative inline-flex">
      <span
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        className="ml-1 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/30 text-muted-foreground/40 transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground/80 cursor-help"
        tabIndex={0}
        role="img"
        aria-label="Info"
      >
        <Info className="h-2.5 w-2.5" />
      </span>
      {show && (
        <div className="absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-normal">
          <div className="w-56 rounded-lg border border-border bg-popover px-3 py-2 text-center text-[11px] font-normal normal-case tracking-normal text-popover-foreground shadow-xl">
            {text}
          </div>
        </div>
      )}
    </span>
  );
}
