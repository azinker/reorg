"use client";

/**
 * Inline picker for help-desk templates. Shows a small dropdown listing shared
 * + personal templates, filtered by language, with a search box and shortcut
 * column. Selecting a template fires `onPick(filledBody)` with placeholders
 * resolved against the current ticket context.
 */

import {
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, FileText, Search, Loader2, ChevronDown } from "lucide-react";
import {
  fillTemplate,
  findUnfilledPlaceholders,
  type TemplateContext,
} from "@/lib/helpdesk/template-fill";
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

interface RankedTemplate {
  template: TemplateRow;
  score: number;
  matchLabel: string;
}

interface TemplatePickerProps {
  ctx: TemplateContext;
  /** Called with the placeholder-filled body when the agent picks a template. */
  onPick: (body: string) => void;
  disabled?: boolean;
}

const AVAILABLE_SNIPPETS = [
  "{{first_name}}",
  "{{buyer_name}}",
  "{{buyer_username}}",
  "{{order_number}}",
  "{{item_title}}",
  "{{tracking_number}}",
  "{{store_name}}",
];

export function TemplatePicker({ ctx, onPick, disabled }: TemplatePickerProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeButtonRef = useRef<HTMLButtonElement | null>(null);

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

  const ranked = useMemo(() => {
    const q = search.trim();
    if (!q) {
      return items.map((template) => ({
        template,
        score: 0,
        matchLabel: "",
      }));
    }
    return items
      .map((template) => rankTemplate(template, q))
      .filter((result): result is RankedTemplate => result !== null)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.template.name.localeCompare(b.template.name, undefined, {
          sensitivity: "base",
        });
      });
  }, [items, search]);
  const filtered = useMemo(
    () => ranked.map((result) => result.template),
    [ranked],
  );

  useEffect(() => {
    if (filtered.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !filtered.some((t) => t.id === activeId)) {
      setActiveId(filtered[0]?.id ?? null);
    }
  }, [activeId, filtered]);

  const activeTemplate = useMemo(
    () => filtered.find((t) => t.id === activeId) ?? filtered[0] ?? null,
    [activeId, filtered],
  );
  const activePreview = activeTemplate
    ? fillTemplate(activeTemplate.bodyText, ctx)
    : "";
  const activeSearchResult = useMemo(
    () => ranked.find((result) => result.template.id === activeTemplate?.id) ?? null,
    [activeTemplate?.id, ranked],
  );
  const missingSnippets = activePreview
    ? findUnfilledPlaceholders(activePreview)
    : [];

  useEffect(() => {
    if (!open) return;
    activeButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeId, open]);

  function pickTemplate(t: TemplateRow) {
    const filled = fillTemplate(t.bodyText, ctx);
    onPick(filled);
    setOpen(false);
  }

  function moveActive(delta: number) {
    if (filtered.length === 0) return;
    const index = activeId
      ? filtered.findIndex((template) => template.id === activeId)
      : -1;
    const nextIndex =
      index === -1
        ? delta > 0
          ? 0
          : filtered.length - 1
        : (index + delta + filtered.length) % filtered.length;
    setActiveId(filtered[nextIndex]?.id ?? null);
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
      return;
    }
    if (e.key === "Enter" && activeTemplate) {
      e.preventDefault();
      pickTemplate(activeTemplate);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() =>
          setOpen((v) => {
            const next = !v;
            if (next) setSearch("");
            return next;
          })
        }
        disabled={disabled}
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border border-indigo-500/35 bg-indigo-500/10 px-2 text-xs text-indigo-700 shadow-sm transition-colors hover:border-indigo-500/55 hover:bg-indigo-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/30 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer dark:text-indigo-300",
          open && "bg-indigo-500/20",
        )}
      >
        <FileText className="h-3 w-3" />
        Templates
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-[min(56rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-hairline bg-popover text-popover-foreground shadow-2xl shadow-black/30">
          <div className="flex items-center gap-2 border-b border-hairline px-2 py-1.5">
            <Search className="h-3 w-3 text-foreground/55" />
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search templates…"
              className="flex-1 bg-transparent text-xs text-foreground placeholder:text-foreground/55 focus:outline-none"
            />
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {filtered.length}/{items.length}
            </span>
          </div>
          <div
            className="grid grid-cols-[minmax(0,1fr)_18rem] overflow-hidden"
            style={{ height: "min(32rem, calc(100vh - 9rem))" }}
          >
            <div className="min-h-0 overflow-y-auto overscroll-contain py-1">
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
                ranked.map(({ template: t, matchLabel }, index) => (
                  <button
                    key={t.id}
                    ref={activeTemplate?.id === t.id ? activeButtonRef : null}
                    type="button"
                    onMouseEnter={() => setActiveId(t.id)}
                    onFocus={() => setActiveId(t.id)}
                    onClick={() => pickTemplate(t)}
                    className={cn(
                      "flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/30 cursor-pointer",
                      activeTemplate?.id === t.id && "bg-surface-2/80",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 break-words text-[13px] font-semibold leading-4 text-foreground">
                          {t.name}
                        </span>
                        {t.shortcut && (
                          <code className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-foreground/70">
                            {t.shortcut}
                          </code>
                        )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      {t.isShared ? (
                        <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300">
                          Shared
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                          Mine
                        </span>
                      )}
                      {t.language && (
                        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-foreground/60">
                          {t.language}
                        </span>
                      )}
                      {search.trim() && (
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                            index === 0
                              ? "bg-brand-muted text-brand"
                              : "bg-surface-2 text-foreground/60",
                          )}
                        >
                          {index === 0 ? "Best match" : matchLabel}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-foreground/75">
                      {t.bodyText.slice(0, 120)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex min-h-0 flex-col border-l border-hairline bg-card/70 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Preview
              </p>
              {activeTemplate ? (
                <>
                  <p className="mt-1 text-sm font-semibold leading-5 text-foreground">
                    {activeTemplate.name}
                  </p>
                  {search.trim() && activeSearchResult ? (
                    <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-brand">
                      {activeSearchResult.matchLabel}
                    </p>
                  ) : null}
                  <div className="mt-2 min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap rounded-md border border-hairline bg-surface px-2 py-2 text-[11px] leading-5 text-foreground">
                    {activePreview}
                  </div>
                  {missingSnippets.length > 0 ? (
                    <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        Missing: {missingSnippets.map((s) => `{{${s}}}`).join(", ")}
                      </span>
                    </div>
                  ) : null}
                  <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
                    Snippets: {AVAILABLE_SNIPPETS.join(", ")}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                  Hover a template to preview it. Available snippets:{" "}
                  {AVAILABLE_SNIPPETS.join(", ")}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function rankTemplate(template: TemplateRow, query: string): RankedTemplate | null {
  const candidates = [
    { label: "Shortcut", value: template.shortcut, weight: 130, allowBodyFuzzy: false },
    { label: "Name", value: template.name, weight: 115, allowBodyFuzzy: false },
    { label: "Description", value: template.description, weight: 70, allowBodyFuzzy: false },
    { label: "Body", value: template.bodyText, weight: 32, allowBodyFuzzy: true },
  ];
  let best: RankedTemplate | null = null;
  for (const candidate of candidates) {
    const score = scoreText(candidate.value ?? "", query, candidate);
    if (score == null) continue;
    const result = {
      template,
      score,
      matchLabel: `${candidate.label} match`,
    };
    if (!best || result.score > best.score) best = result;
  }
  return best;
}

function scoreText(
  value: string,
  query: string,
  options: { weight: number; allowBodyFuzzy: boolean },
): number | null {
  const text = normalizeSearchText(value);
  const q = normalizeSearchText(query);
  if (!text || !q) return null;

  const queryTokens = tokenizeSearchText(q);
  const textTokens = tokenizeSearchText(text);
  if (queryTokens.length === 0 || textTokens.length === 0) return null;

  if (text === q) return options.weight + 120;
  if (text.startsWith(q)) return options.weight + 110;
  if (text.includes(` ${q}`)) return options.weight + 100;
  if (q.length >= 3 && text.includes(q)) return options.weight + 82;

  const acronym = textTokens.map((token) => token[0]).join("");
  const compactText = text.replace(/\s+/g, "");
  const compactQuery = q.replace(/\s+/g, "");
  if (compactQuery.length >= 2 && acronym.startsWith(compactQuery)) {
    return options.weight + 98;
  }
  if (compactQuery.length >= 3 && acronym.includes(compactQuery)) {
    return options.weight + 88;
  }
  if (compactQuery.length >= 3 && compactText.startsWith(compactQuery)) {
    return options.weight + 86;
  }

  const tokenScore = scoreTokenSet(queryTokens, textTokens, options.allowBodyFuzzy);
  if (tokenScore == null) return null;
  return options.weight + tokenScore;
}

function scoreTokenSet(
  queryTokens: string[],
  textTokens: string[],
  allowBodyFuzzy: boolean,
): number | null {
  let total = 0;
  for (const queryToken of queryTokens) {
    let best = 0;
    for (const textToken of textTokens) {
      best = Math.max(best, scoreToken(queryToken, textToken, allowBodyFuzzy));
    }
    if (best === 0) return null;
    total += best;
  }
  return Math.round((total / queryTokens.length) * 78);
}

function scoreToken(
  queryToken: string,
  textToken: string,
  allowBodyFuzzy: boolean,
): number {
  if (queryToken === textToken) return 1;
  if (textToken.startsWith(queryToken)) return 0.95;
  if (queryToken.length >= 3 && textToken.includes(queryToken)) return 0.78;

  const typoBudget =
    queryToken.length >= 7 ? 2 : queryToken.length >= 4 ? 1 : 0;
  if (typoBudget > 0 && levenshteinDistance(queryToken, textToken) <= typoBudget) {
    return 0.72;
  }

  if (!allowBodyFuzzy && queryToken.length >= 3 && isSubsequence(queryToken, textToken)) {
    return 0.52;
  }

  return 0;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenizeSearchText(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

function isSubsequence(query: string, value: string): boolean {
  let index = 0;
  for (const char of query) {
    index = value.indexOf(char, index);
    if (index === -1) return false;
    index += 1;
  }
  return true;
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  const current = Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j] ?? 0;
  }

  return previous[b.length] ?? 3;
}
