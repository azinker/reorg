"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  FileText,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TemplateLanguage = "en" | "es";

interface TemplateRow {
  id: string;
  name: string;
  bodyText: string;
  isShared: boolean;
  isActive: boolean;
  shortcut: string | null;
  language: TemplateLanguage | null;
  description: string | null;
  sortOrder: number;
  isMine: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TemplateDraft {
  id: string | null;
  name: string;
  bodyText: string;
  isActive: boolean;
  shortcut: string;
  language: TemplateLanguage | "";
  description: string;
}

const EMPTY_DRAFT: TemplateDraft = {
  id: null,
  name: "",
  bodyText: "",
  isActive: true,
  shortcut: "",
  language: "en",
  description: "",
};

const SNIPPETS = [
  { token: "{{buyer_name}}", label: "Delivery full name" },
  { token: "{{buyer_username}}", label: "eBay username" },
  { token: "{{first_name}}", label: "Delivery first name" },
  { token: "{{order_number}}", label: "Order number" },
  { token: "{{item_id}}", label: "Item ID" },
  { token: "{{item_title}}", label: "Item title" },
  { token: "{{tracking_number}}", label: "Tracking number" },
  { token: "{{store_name}}", label: "Store name" },
] as const;

export default function HelpdeskTemplatesPage() {
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  async function loadTemplates(selectId?: string | null) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/helpdesk/templates?includeInactive=1", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Templates ${res.status}`);
      const json = (await res.json()) as { data?: TemplateRow[] };
      const rows = (json.data ?? []).slice().sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      );
      setTemplates(rows);
      const selected =
        rows.find((t) => t.id === selectId) ??
        (draft.id ? rows.find((t) => t.id === draft.id) : null) ??
        rows[0] ??
        null;
      setDraft(selected ? rowToDraft(selected) : EMPTY_DRAFT);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTemplates(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return templates;
    return templates.filter((t) =>
      fuzzyMatch(
        [t.name, t.shortcut, t.description, t.bodyText].filter(Boolean).join(" "),
        q,
      ),
    );
  }, [templates, search]);

  function updateDraft(patch: Partial<TemplateDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }));
    setSuccess(null);
    setError(null);
  }

  function insertSnippet(token: string) {
    const input = textareaRef.current;
    const prefix = input ? draft.bodyText.slice(0, input.selectionStart) : draft.bodyText;
    const suffix = input ? draft.bodyText.slice(input.selectionEnd) : "";
    const next = `${prefix}${token}${suffix}`;
    updateDraft({ bodyText: next });
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const pos = prefix.length + token.length;
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  }

  async function saveTemplate() {
    const name = draft.name.trim();
    const bodyText = draft.bodyText.trim();
    if (!name || !bodyText) {
      setError("Template name and message content are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        bodyText,
        isShared: true,
        isActive: draft.isActive,
        shortcut: draft.shortcut.trim() ? draft.shortcut.trim() : null,
        language: draft.language || null,
        description: draft.description.trim() ? draft.description.trim() : null,
      };
      const res = await fetch(
        draft.id ? `/api/helpdesk/templates/${draft.id}` : "/api/helpdesk/templates",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof json.error === "string" ? json.error : `Save failed (${res.status})`,
        );
      }
      const json = (await res.json()) as { data?: { id?: string } };
      const id = json.data?.id ?? draft.id ?? null;
      setSuccess("Template saved.");
      await loadTemplates(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function removeTemplate() {
    if (!draft.id) return;
    const ok = window.confirm("Remove this template from the active library?");
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/helpdesk/templates/${draft.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Remove failed (${res.status})`);
      setSuccess("Template removed.");
      await loadTemplates(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-background text-foreground">
      <div className="border-b border-hairline bg-card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              href="/help-desk"
              className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Help Desk
            </Link>
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-brand" />
              <h1 className="text-lg font-semibold">Templates</h1>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDraft(EMPTY_DRAFT)}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-hairline bg-surface px-3 text-sm font-medium text-foreground hover:bg-surface-2 cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            New template
          </button>
        </div>
      </div>

      <div className="grid min-h-[calc(100vh-8.5rem)] grid-cols-1 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <aside className="border-r border-hairline bg-card/60">
          <div className="border-b border-hairline p-3">
            <div className="flex h-9 items-center gap-2 rounded-md border border-hairline bg-surface px-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="max-h-[calc(100vh-12rem)] overflow-y-auto p-2">
            {loading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No templates found.
              </p>
            ) : (
              <ul className="space-y-1">
                {filtered.map((template) => (
                  <li key={template.id}>
                    <button
                      type="button"
                      onClick={() => setDraft(rowToDraft(template))}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors cursor-pointer",
                        draft.id === template.id
                          ? "bg-brand-muted text-brand"
                          : "hover:bg-surface-2",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1 h-2 w-2 shrink-0 rounded-full",
                          template.isActive ? "bg-emerald-500" : "bg-muted",
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {template.name}
                        </span>
                        <span className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">
                          {template.description || template.bodyText}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className="min-w-0 p-5">
          <div className="mx-auto max-w-5xl">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">
                  {draft.id ? "Edit shared template" : "Create shared template"}
                </h2>
                <p className="text-xs text-muted-foreground">
                  These templates appear in the composer Templates menu for every agent.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {success ? (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-300">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {success}
                  </span>
                ) : null}
                {draft.id ? (
                  <button
                    type="button"
                    onClick={removeTemplate}
                    disabled={saving}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-rose-500/35 bg-rose-500/10 px-3 text-xs font-medium text-rose-700 hover:bg-rose-500/15 disabled:opacity-50 dark:text-rose-300 cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={saveTemplate}
                  disabled={saving}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand px-3 text-xs font-semibold text-brand-foreground hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </button>
              </div>
            </div>

            {error ? (
              <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </div>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <section className="rounded-lg border border-hairline bg-card p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Template name">
                    <input
                      value={draft.name}
                      onChange={(e) => updateDraft({ name: e.target.value })}
                      className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm outline-none focus:border-brand/50"
                      placeholder="Damaged item follow-up"
                    />
                  </Field>
                  <Field label="Shortcut / search alias">
                    <input
                      value={draft.shortcut}
                      onChange={(e) => updateDraft({ shortcut: e.target.value })}
                      className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm outline-none focus:border-brand/50"
                      placeholder="/damage"
                    />
                  </Field>
                  <Field label="Language">
                    <select
                      value={draft.language}
                      onChange={(e) =>
                        updateDraft({
                          language: e.target.value as TemplateLanguage | "",
                        })
                      }
                      className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm outline-none focus:border-brand/50"
                    >
                      <option value="">Any</option>
                      <option value="en">English</option>
                      <option value="es">Spanish</option>
                    </select>
                  </Field>
                  <Field label="Status">
                    <button
                      type="button"
                      onClick={() => updateDraft({ isActive: !draft.isActive })}
                      className={cn(
                        "inline-flex h-9 w-full items-center justify-center rounded-md border px-3 text-sm font-medium transition-colors cursor-pointer",
                        draft.isActive
                          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-hairline bg-surface text-muted-foreground hover:bg-surface-2",
                      )}
                    >
                      {draft.isActive ? "Active" : "Inactive"}
                    </button>
                  </Field>
                </div>

                <Field label="Description" className="mt-3">
                  <input
                    value={draft.description}
                    onChange={(e) => updateDraft({ description: e.target.value })}
                    className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm outline-none focus:border-brand/50"
                    placeholder="When to use this template"
                  />
                </Field>

                <Field label="Message content" className="mt-3">
                  <textarea
                    ref={textareaRef}
                    value={draft.bodyText}
                    onChange={(e) => updateDraft({ bodyText: e.target.value })}
                    rows={13}
                    className="w-full resize-y rounded-md border border-hairline bg-surface px-3 py-2 text-sm leading-6 outline-none focus:border-brand/50"
                    placeholder="Hi {{first_name}},"
                  />
                </Field>
              </section>

              <aside className="rounded-lg border border-hairline bg-card p-4">
                <h3 className="text-sm font-semibold">Available snippets</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Click a snippet to insert it at the cursor.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {SNIPPETS.map((snippet) => (
                    <button
                      key={snippet.token}
                      type="button"
                      onClick={() => insertSnippet(snippet.token)}
                      className="inline-flex flex-col rounded-md border border-hairline bg-surface px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-surface-2 hover:text-foreground cursor-pointer"
                      title={snippet.label}
                    >
                      <span className="font-medium text-foreground">{snippet.token}</span>
                      <span>{snippet.label}</span>
                    </button>
                  ))}
                </div>
                <div className="mt-4 rounded-md border border-hairline bg-surface p-3">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Shared library
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Templates saved here are team shared. Inactive templates stay
                    in this manager but do not appear in the composer picker.
                  </p>
                </div>
              </aside>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function rowToDraft(row: TemplateRow): TemplateDraft {
  return {
    id: row.id,
    name: row.name,
    bodyText: row.bodyText,
    isActive: row.isActive,
    shortcut: row.shortcut ?? "",
    language:
      row.language === "en" || row.language === "es" ? row.language : "en",
    description: row.description ?? "",
  };
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
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
