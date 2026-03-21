"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CopyValueProps {
  value: string;
  children: React.ReactNode;
  className?: string;
}

export function CopyValue({ value, children, className }: CopyValueProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span className={`group/copy relative inline-flex min-w-0 items-center gap-1 ${className ?? ""}`}>
      {children}
      <button
        onClick={handleCopy}
        className="shrink-0 rounded p-0.5 text-muted-foreground/0 transition-all group-hover/copy:text-muted-foreground/40 hover:!text-foreground cursor-pointer"
        title="Copy to clipboard"
      >
        {copied ? (
          <Check className="h-3 w-3 text-emerald-400" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </button>
      {copied && (
        <span className="absolute -top-5 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap rounded bg-foreground px-1.5 py-0.5 text-[9px] font-medium text-background shadow-lg">
          Copied!
        </span>
      )}
    </span>
  );
}
