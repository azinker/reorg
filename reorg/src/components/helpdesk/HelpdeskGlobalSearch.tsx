"use client";

/**
 * Slim global-search input rendered at the top of every Help Desk
 * sub-page (filters, dashboard, profile, global-settings).
 *
 * Why this exists:
 *   The full {@link HelpdeskHeader} only mounts on the main /help-desk
 *   route. Agents kept asking why typing a buyer username on, say, the
 *   filters page didn't take them to the search results — so we
 *   redirect them with a router.push to /help-desk?q=<value>. The main
 *   client picks up the `?q=` param and seeds its inbox search. From a
 *   keyboard's perspective this is identical to landing on /help-desk
 *   and typing in the centered header search.
 *
 * Behaviour intentionally mirrors HelpdeskHeader:
 *   - Submits on Enter.
 *   - Submits on blur if the value changed.
 *   - Esc clears the input.
 *   - Empty submit just navigates back to /help-desk with no query.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search, X } from "lucide-react";

export function HelpdeskGlobalSearch() {
  const router = useRouter();
  const [value, setValue] = useState("");

  function go(q: string) {
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      router.push("/help-desk");
    } else {
      router.push(`/help-desk?q=${encodeURIComponent(trimmed)}`);
    }
  }

  return (
    <div className="relative w-full max-w-xl">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        // type="text" (NOT "search") — `type=search` paints the browser's
        // own clear (×) button, which doubles up with our custom one.
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            go(value);
          } else if (e.key === "Escape" && value.length > 0) {
            setValue("");
          }
        }}
        placeholder="Search by buyer username or eBay Order ID"
        className="h-10 w-full rounded-md border border-hairline bg-surface pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand/40 focus:outline-none focus:ring-2 focus:ring-brand/20"
        aria-label="Search Help Desk inbox"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={() => setValue("")}
          className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground cursor-pointer"
          title="Clear"
          aria-label="Clear"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
