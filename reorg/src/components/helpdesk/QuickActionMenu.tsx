"use client";

/**
 * QuickActionMenu — six fixed preset replies the agent can drop into the
 * composer with one click. These are intentionally short, friendly bodies the
 * shop uses every day. Long-form copy lives in regular templates; quick
 * actions are for instant acknowledgements.
 *
 * Each action runs through fillTemplate() so {{first_name}}, {{order_number}}
 * etc. are resolved against the active ticket.
 */

import { useState, useRef, useEffect } from "react";
import { Zap, ChevronDown } from "lucide-react";
import { fillTemplate, type TemplateContext } from "@/lib/helpdesk/template-fill";
import { cn } from "@/lib/utils";

export interface QuickAction {
  id: string;
  label: string;
  body: string;
}

/**
 * Preset library exported so the eDesk-style chip row in Composer can pick
 * the same canonical bodies. Keeping a single source of truth means a fix
 * to "Provide tracking" wording instantly updates both the dropdown and the
 * always-visible chips.
 */
export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: "ack",
    label: "Acknowledge",
    body:
      "Hi {{first_name}}, thanks for reaching out. I'm taking a look at order {{order_number}} now and will get back to you shortly with an update.",
  },
  {
    id: "tracking",
    label: "Provide tracking",
    body:
      "Hi {{first_name}}, your tracking number is {{tracking_number}}. You can follow the package using that number on the carrier's site. Let me know if you have any other questions.",
  },
  {
    id: "delay",
    label: "Apologize delay",
    body:
      "Hi {{first_name}}, I'm sorry for the delay on order {{order_number}}. I'm following up with the warehouse and will update you as soon as I have more information.",
  },
  {
    id: "refund",
    label: "Confirm refund",
    body:
      "Hi {{first_name}}, your refund for order {{order_number}} has been processed. It should appear on your original payment method within 3–5 business days.",
  },
  {
    id: "photos",
    label: "Ask for photos",
    body:
      "Hi {{first_name}}, would you be able to send a few clear photos of the item and packaging? It will help us figure out the best next step. Thank you!",
  },
  {
    id: "close",
    label: "Wrap up",
    body:
      "Hi {{first_name}}, glad we could get that sorted out. If anything else comes up, just reply here and I'll be happy to help. Have a great day!",
  },
];

interface QuickActionMenuProps {
  ctx: TemplateContext;
  onPick: (body: string) => void;
  disabled?: boolean;
}

export function QuickActionMenu({
  ctx,
  onPick,
  disabled,
}: QuickActionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-xs text-foreground hover:bg-surface-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
          open && "bg-surface-2",
        )}
      >
        <Zap className="h-3 w-3" />
        Quick
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-64 rounded-md border border-hairline bg-popover p-2 text-popover-foreground shadow-xl">
          <div className="grid grid-cols-2 gap-1">
            {QUICK_ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => {
                  onPick(fillTemplate(a.body, ctx));
                  setOpen(false);
                }}
                className="rounded-md border border-transparent bg-transparent px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-surface-2 cursor-pointer"
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
