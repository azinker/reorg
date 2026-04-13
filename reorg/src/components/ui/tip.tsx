import type { ReactNode } from "react";

export function Tip({
  children,
  text,
  side = "top",
}: {
  children: ReactNode;
  text: string;
  side?: "top" | "bottom";
}) {
  if (side === "bottom") {
    return (
      <div className="group/tip relative inline-flex">
        {children}
        <div className="pointer-events-none absolute left-1/2 top-full z-[100] mt-2 w-60 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-lg transition-opacity duration-200 group-hover/tip:opacity-100">
          <div
            className="absolute bottom-full left-1/2 -translate-x-1/2 border-[6px] border-transparent border-b-border"
            aria-hidden
          />
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="group/tip relative inline-flex">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-[100] mb-2.5 w-60 -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground opacity-0 shadow-lg transition-opacity duration-200 group-hover/tip:opacity-100">
        {text}
        <div
          className="absolute left-1/2 top-full -translate-x-1/2 border-[5px] border-transparent border-t-border"
          aria-hidden
        />
      </div>
    </div>
  );
}
