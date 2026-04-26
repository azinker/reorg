"use client";

/**
 * Inline picker for help-desk templates. Shows a small dropdown listing shared
 * + personal templates, filtered by language, with a search box and shortcut
 * column. Selecting a template fires `onPick(filledBody)` with placeholders
 * resolved against the current ticket context.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search, Loader2, ChevronDown } from "lucide-react";
import { fillTemplate, type TemplateContext } from "@/lib/helpdesk/template-fill";
import { cn } from "@/lib/utils";

interface TemplateRow {
  id: string;
  name: string;
  bodyText: string;
  isShared: boolean;
  isMine: boolean;
  shortcut: string | null;
  language: string | null;
  description: string | null;
}

interface TemplatePickerProps {
  ctx: TemplateContext;
  /** Called with the placeholder-filled body when the agent picks a template. */
  onPick: (body: string) => void;
  disabled?: boolean;
}

export function TemplatePicker({ ctx, onPick, disabled }: TemplatePickerProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  // Refresh on every open so newly created shared templates are available
  // without a full Help Desk reload.
  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    fetch("/api/helpdesk/templates", { cache: "no-store", signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Templates ${r.status}`);
        return r.json() as Promise<{ data: TemplateRow[] }>;
      })
      .then((j) =>
        setItems(
          (j.data ?? []).slice().sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
          ),
        ),
      )
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((t) =>
      fuzzyMatch(
        [t.name, t.shortcut, t.description, t.bodyText].filter(Boolean).join(" "),
        q,
      ),
    );
  }, [items, search]);

  function pickTemplate(t: TemplateRow) {
    const filled = fillTemplate(t.bodyText, ctx);
    onPick(filled);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-xs text-foreground shadow-sm transition-colors hover:border-brand/35 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
          open && "bg-surface-2",
        )}
      >
        <FileText className="h-3 w-3" />
        Templates
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-80 overflow-hidden rounded-md border border-hairline bg-popover text-popover-foreground shadow-2xl shadow-black/30">
          <div className="flex items-center gap-2 border-b border-hairline px-2 py-1.5">
            <Search className="h-3 w-3 text-foreground/55" />
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates…"
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-foreground/55 focus:outline-none"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {loading && (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && error && (
              <div className="px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</div>
            )}
            {!loading && !error && filtered.length === 0 && (
              <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                {search
                  ? "No templates match."
                  : "No templates yet — add one in Settings."}
              </div>
            )}
            {!loading &&
              filtered.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30 cursor-pointer"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">
                        {t.name}
                      </span>
                      {t.isShared ? (
                        <span className="rounded bg-blue-500/20 px-1 text-[9px] uppercase tracking-wider text-blue-700 dark:text-blue-300">
                          Shared
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-500/20 px-1 text-[9px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                          Mine
                        </span>
                      )}
                      {t.language && (
                        <span className="rounded bg-surface-2 px-1 text-[9px] uppercase tracking-wider text-foreground/60">
                          {t.language}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-foreground/65">
                      {t.bodyText.slice(0, 120)}
                    </p>
                  </div>
                  {t.shortcut && (
                    <code className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-foreground/60">
                      {t.shortcut}
                    </code>
                  )}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function fuzzyMatch(value: string, query: string): boolean {
  const haystack = value.toLowerCase();
  let index = 0;
  for (const char of query.toLowerCase()) {
    index = haystack.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}
