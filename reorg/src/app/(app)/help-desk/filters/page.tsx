"use client";

/**
 * Filters management page (/help-desk/filters)
 *
 * Lists every Help Desk filter and lets ADMINs:
 *   - toggle enabled/disabled
 *   - edit name + conditions + action
 *   - run a filter retroactively over the inbox
 *   - delete user-created filters (system filters can only be disabled)
 *   - run the global "auto-resolve answered tickets" maintenance job
 *
 * The filter shape mirrors `@/lib/helpdesk/filters` exactly. Conditions are a
 * list of { field, op, value } rules joined by ALL/ANY; actions move the
 * matching ticket to a folder (archived / spam / resolved / inbox).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Plus,
  Loader2,
  Play,
  Pencil,
  Trash2,
  Save,
  X,
  CheckCircle2,
  Sparkles,
  Lock,
  Power,
} from "lucide-react";
import type {
  FilterAction,
  FilterActionFolder,
  FilterConditions,
  FilterField,
  FilterOp,
} from "@/lib/helpdesk/filters";

interface FilterRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  isSystem: boolean;
  sortOrder: number;
  conditions: FilterConditions;
  action: FilterAction;
  lastRunAt: string | null;
  lastRunHits: number;
  totalHits: number;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string | null; email: string | null } | null;
}

const FIELD_LABEL: Record<FilterField, string> = {
  subject: "Subject",
  body: "Message body",
  buyer_username: "Buyer username",
  from_name: "Sender name",
};
const OP_LABEL: Record<FilterOp, string> = {
  contains: "contains",
  equals: "is exactly",
  starts_with: "starts with",
  ends_with: "ends with",
  regex: "matches regex",
};
const FOLDER_LABEL: Record<FilterActionFolder, string> = {
  archived: "Archive",
  spam: "Mark as spam",
  resolved: "Mark resolved",
  inbox: "Move to inbox",
  cancel_requests: "Move to Cancel Requests",
};

/**
 * Inline help text shown under the action picker so the agent knows exactly
 * what each "Then…" choice does to a matching ticket. Keeps the UI honest
 * about side-effects (Archive removes from open folders, Spam sets the
 * spam flag, etc.) without needing a separate docs page.
 */
const ACTION_HELP: Record<FilterActionFolder, string> = {
  archived:
    "Moves matching tickets to the Archived folder. They no longer appear in All Tickets, New, To Do, Waiting, or Cancel Requests.",
  spam:
    "Marks matching tickets as Spam. They move to the Spam folder and are excluded from every other folder.",
  resolved:
    "Marks matching tickets as Resolved. They move to the Resolved folder. Use this for confirmation messages that need no agent reply.",
  inbox:
    "Brings matching tickets back into the inbox (status NEW). Useful when another filter has hidden them and you want to undo it for a subset.",
  cancel_requests:
    "Routes matching tickets to the Cancel Requests folder. They are HIDDEN from All Tickets, New, To Do, Waiting, Pre-sales, My Tickets, Unassigned, and Mentioned — but their status (NEW/TO_DO/WAITING) is preserved so they're still actionable.",
};

function emptyDraft(): FilterRow {
  return {
    id: "",
    name: "",
    description: "",
    enabled: true,
    isSystem: false,
    sortOrder: 100,
    conditions: { match: "ALL", rules: [{ field: "subject", op: "contains", value: "" }] },
    action: { type: "MOVE_TO_FOLDER", folder: "archived" },
    lastRunAt: null,
    lastRunHits: 0,
    totalHits: 0,
    createdAt: "",
    updatedAt: "",
    createdBy: null,
  };
}

export default function HelpdeskFiltersPage() {
  const [filters, setFilters] = useState<FilterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editing, setEditing] = useState<FilterRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [autoResolveBusy, setAutoResolveBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/helpdesk/filters", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { data: FilterRow[] };
      setFilters(j.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load filters");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function flash(msg: string) {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 2500);
  }

  async function toggleEnabled(f: FilterRow) {
    setBusyId(f.id);
    try {
      const res = await fetch(`/api/helpdesk/filters/${f.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !f.enabled }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? j?.error ?? `Toggle failed (${res.status})`);
      }
      await load();
      flash(`Filter ${!f.enabled ? "enabled" : "disabled"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusyId(null);
    }
  }

  async function runFilter(f: FilterRow) {
    setBusyId(f.id);
    try {
      const res = await fetch(`/api/helpdesk/filters/${f.id}/run`, {
        method: "POST",
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? j?.error ?? `Run failed (${res.status})`);
      }
      const j = (await res.json()) as { data: { scanned: number; matched: number } };
      await load();
      flash(`Scanned ${j.data.scanned} messages, matched ${j.data.matched}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteFilter(f: FilterRow) {
    if (!confirm(`Delete filter "${f.name}"? Tickets it has already moved will stay where they are.`)) return;
    setBusyId(f.id);
    try {
      const res = await fetch(`/api/helpdesk/filters/${f.id}`, { method: "DELETE" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? j?.error ?? `Delete failed (${res.status})`);
      }
      await load();
      flash(`Filter "${f.name}" deleted.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  async function saveDraft(draft: FilterRow) {
    setBusyId(draft.id || "_new");
    try {
      const cleanedRules = draft.conditions.rules.filter((r) => r.value.trim().length > 0);
      if (cleanedRules.length === 0) {
        throw new Error("Add at least one rule with a value.");
      }
      const payload = {
        name: draft.name.trim(),
        description: draft.description?.trim() || null,
        enabled: draft.enabled,
        sortOrder: draft.sortOrder,
        conditions: { match: draft.conditions.match, rules: cleanedRules },
        action: draft.action,
      };
      const url = draft.id
        ? `/api/helpdesk/filters/${draft.id}`
        : `/api/helpdesk/filters`;
      const method = draft.id ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? j?.error ?? `Save failed (${res.status})`);
      }
      setEditing(null);
      await load();
      flash(`Filter ${draft.id ? "updated" : "created"}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusyId(null);
    }
  }

  async function autoResolve() {
    setAutoResolveBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/helpdesk/auto-resolve`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error?.message ?? j?.error ?? `Run failed (${res.status})`);
      }
      const j = (await res.json()) as { data: { scanned: number; resolved: number } };
      flash(`Scanned ${j.data.scanned} open tickets, marked ${j.data.resolved} resolved.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Auto-resolve failed");
    } finally {
      setAutoResolveBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/help-desk"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Help Desk
        </Link>
        {/* Search field intentionally omitted on this sub-page — agents
            should jump back to the main inbox to search the conversation
            list. (Confused agents kept typing here looking for a filter
            search; the field is now only on the main /help-desk view.) */}
      </div>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Filters</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Inbox rules. When a new message matches your conditions, the
            ticket is moved automatically (archive, spam, resolved, or back to
            inbox). Filters run live on every sync, and you can also run them
            once over the existing inbox.
          </p>
          <p className="mt-2 max-w-2xl text-xs text-muted-foreground/80">
            <span className="font-semibold text-foreground/80">System filters</span>{" "}
            (marked with the Sparkles badge) are built-in and always on — they
            keep the inbox clean by routing things like cancellation requests
            to their own folder. You can disable them but not delete them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={autoResolve}
            disabled={autoResolveBusy}
            className="inline-flex items-center gap-2 rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-foreground/90 hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
            title="Mark every open ticket whose last message is from an agent as Resolved."
          >
            {autoResolveBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Auto-resolve answered
          </button>
          <button
            type="button"
            onClick={() => setEditing(emptyDraft())}
            className="inline-flex items-center gap-2 rounded-md bg-brand px-3 py-2 text-xs font-medium text-brand-foreground shadow-sm hover:opacity-90 cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" /> New filter
          </button>
        </div>
      </header>

      {error ? (
        <div className="mb-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {success}
        </div>
      ) : null}

      {loading ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filters.length === 0 ? (
        <div className="rounded-xl border border-dashed border-hairline bg-surface p-8 text-center text-sm text-muted-foreground">
          No filters yet. Create one to start sorting messages automatically.
        </div>
      ) : (
        <ul className="space-y-2">
          {filters.map((f) => (
            <li
              key={f.id}
              className="rounded-xl border border-hairline bg-card p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{f.name}</h3>
                    {f.isSystem ? (
                      <span
                        className="inline-flex items-center gap-1 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-700 dark:text-sky-300"
                        title="Built-in filter. Can be disabled but not deleted."
                      >
                        <Sparkles className="h-2.5 w-2.5" /> System
                      </span>
                    ) : null}
                    {!f.enabled ? (
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Disabled
                      </span>
                    ) : null}
                  </div>
                  {f.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">{f.description}</p>
                  ) : null}
                  <ConditionsSummary conditions={f.conditions} />
                  <ActionSummary action={f.action} />
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span>Total hits: {f.totalHits}</span>
                    {f.lastRunAt ? (
                      <span>
                        Last run: {new Date(f.lastRunAt).toLocaleString()} (matched {f.lastRunHits})
                      </span>
                    ) : (
                      <span>Never run on demand</span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={busyId === f.id}
                      onClick={() => toggleEnabled(f)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] text-foreground/90 hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                      title={f.enabled ? "Disable" : "Enable"}
                    >
                      <Power className="h-3 w-3" />
                      {f.enabled ? "On" : "Off"}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === f.id}
                      onClick={() => runFilter(f)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] text-foreground/90 hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                      title="Run this filter once over the existing inbox."
                    >
                      {busyId === f.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                      Run
                    </button>
                    <button
                      type="button"
                      disabled={busyId === f.id}
                      onClick={() => setEditing(f)}
                      className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] text-foreground/90 hover:bg-surface-2 disabled:opacity-50 cursor-pointer"
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                    {!f.isSystem ? (
                      <button
                        type="button"
                        disabled={busyId === f.id}
                        onClick={() => deleteFilter(f)}
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-red-500/20 bg-red-500/10 px-2 text-[11px] text-red-700 dark:text-red-300 hover:bg-red-500/15 disabled:opacity-50 cursor-pointer"
                      >
                        <Trash2 className="h-3 w-3" /> Delete
                      </button>
                    ) : (
                      <span
                        className="inline-flex h-7 items-center gap-1 rounded-md border border-hairline bg-surface px-2 text-[11px] text-muted-foreground"
                        title="System filters can only be disabled, never deleted."
                      >
                        <Lock className="h-3 w-3" />
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing ? (
        <FilterEditor
          draft={editing}
          onChange={setEditing}
          onClose={() => setEditing(null)}
          onSave={saveDraft}
          busy={busyId === (editing.id || "_new")}
        />
      ) : null}
    </div>
  );
}

function ConditionsSummary({ conditions }: { conditions: FilterConditions }) {
  const joiner = conditions.match === "ALL" ? "AND" : "OR";
  return (
    <div className="mt-2 rounded-md bg-surface px-3 py-2 text-xs">
      <div className="font-semibold text-muted-foreground">
        When a message matches{" "}
        <span className="text-foreground/90">{conditions.match}</span> of:
      </div>
      <ul className="mt-1 space-y-0.5">
        {conditions.rules.map((r, i) => (
          <li key={i} className="text-foreground/80">
            <span className="text-muted-foreground">{i > 0 ? `${joiner} ` : ""}</span>
            <span className="font-medium">{FIELD_LABEL[r.field] ?? r.field}</span>{" "}
            <span className="text-muted-foreground">{OP_LABEL[r.op] ?? r.op}</span>{" "}
            <span className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px]">
              {r.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActionSummary({ action }: { action: FilterAction }) {
  return (
    <div className="mt-2 rounded-md bg-surface px-3 py-2 text-xs">
      <div>
        <span className="font-semibold text-muted-foreground">Then: </span>
        <span className="text-foreground/90">
          {FOLDER_LABEL[action.folder] ?? action.folder}
        </span>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground/80">
        {ACTION_HELP[action.folder] ?? ""}
      </p>
    </div>
  );
}

interface EditorProps {
  draft: FilterRow;
  onChange: (d: FilterRow) => void;
  onClose: () => void;
  onSave: (d: FilterRow) => Promise<void>;
  busy: boolean;
}

function FilterEditor({ draft, onChange, onClose, onSave, busy }: EditorProps) {
  const isNew = !draft.id;

  function setRule(idx: number, patch: Partial<FilterConditions["rules"][number]>) {
    const rules = draft.conditions.rules.map((r, i) =>
      i === idx ? { ...r, ...patch } : r,
    );
    onChange({ ...draft, conditions: { ...draft.conditions, rules } });
  }
  function addRule() {
    onChange({
      ...draft,
      conditions: {
        ...draft.conditions,
        rules: [
          ...draft.conditions.rules,
          { field: "subject", op: "contains", value: "" },
        ],
      },
    });
  }
  function removeRule(idx: number) {
    if (draft.conditions.rules.length <= 1) return;
    onChange({
      ...draft,
      conditions: {
        ...draft.conditions,
        rules: draft.conditions.rules.filter((_, i) => i !== idx),
      },
    });
  }

  const canSave = useMemo(
    () =>
      draft.name.trim().length > 0 &&
      draft.conditions.rules.some((r) => r.value.trim().length > 0),
    [draft],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 sm:p-8"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-full w-full max-w-2xl overflow-y-auto rounded-xl border border-hairline bg-popover shadow-2xl">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">
            {isNew ? "New filter" : `Edit "${draft.name}"`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-surface-2 hover:text-foreground cursor-pointer"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Name
            </label>
            <input
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm text-foreground focus:border-brand/40 focus:outline-none"
              placeholder="Archive shipped notifications"
              disabled={draft.isSystem}
            />
            {draft.isSystem ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                System filter — name cannot be changed.
              </p>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Description (optional)
            </label>
            <input
              value={draft.description ?? ""}
              onChange={(e) => onChange({ ...draft, description: e.target.value })}
              className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm text-foreground focus:border-brand/40 focus:outline-none"
              placeholder="Why this filter exists"
            />
          </div>

          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Match
              </span>
              <select
                value={draft.conditions.match}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    conditions: {
                      ...draft.conditions,
                      match: e.target.value as "ALL" | "ANY",
                    },
                  })
                }
                className="h-7 rounded-md border border-hairline bg-surface px-2 text-xs text-foreground focus:outline-none cursor-pointer"
              >
                <option value="ALL">ALL of the rules</option>
                <option value="ANY">ANY of the rules</option>
              </select>
            </div>
            <div className="space-y-2">
              {draft.conditions.rules.map((r, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-hairline bg-surface p-2"
                >
                  <select
                    value={r.field}
                    onChange={(e) => setRule(i, { field: e.target.value as FilterField })}
                    className="h-8 rounded-md border border-hairline bg-surface px-2 text-xs text-foreground focus:outline-none cursor-pointer"
                  >
                    {Object.entries(FIELD_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <select
                    value={r.op}
                    onChange={(e) => setRule(i, { op: e.target.value as FilterOp })}
                    className="h-8 rounded-md border border-hairline bg-surface px-2 text-xs text-foreground focus:outline-none cursor-pointer"
                  >
                    {Object.entries(OP_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                  <input
                    value={r.value}
                    onChange={(e) => setRule(i, { value: e.target.value })}
                    placeholder="value"
                    className="h-8 flex-1 min-w-[160px] rounded-md border border-hairline bg-surface px-2 text-xs text-foreground focus:border-brand/40 focus:outline-none"
                  />
                  <label
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"
                    title="When checked, 'Hello' will not match 'hello'. Leave unchecked for the usual case-insensitive match."
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(r.caseSensitive)}
                      onChange={(e) =>
                        setRule(i, { caseSensitive: e.target.checked })
                      }
                      className="accent-brand"
                    />
                    Match case
                  </label>
                  <button
                    type="button"
                    onClick={() => removeRule(i)}
                    disabled={draft.conditions.rules.length <= 1}
                    className="rounded p-1 text-muted-foreground hover:bg-surface-2 hover:text-red-700 dark:text-red-300 disabled:opacity-30 cursor-pointer"
                    title="Remove rule"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addRule}
              className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <Plus className="h-3 w-3" /> Add rule
            </button>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Then
            </label>
            <select
              value={draft.action.folder}
              onChange={(e) =>
                onChange({
                  ...draft,
                  action: {
                    ...draft.action,
                    folder: e.target.value as FilterActionFolder,
                  },
                })
              }
              className="h-9 w-full rounded-md border border-hairline bg-surface px-3 text-sm text-foreground focus:outline-none cursor-pointer"
            >
              {Object.entries(FOLDER_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {ACTION_HELP[draft.action.folder] ?? ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-3">
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
                className="accent-brand"
              />
              Enabled
            </label>
            <label
              className="inline-flex items-center gap-2 text-xs text-muted-foreground"
              title="Filters run from lowest sort order to highest. Leave at 100 unless you need a specific filter to run before another."
            >
              Run order
              <input
                type="number"
                min={0}
                max={9999}
                value={draft.sortOrder}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    sortOrder: Number(e.target.value) || 0,
                  })
                }
                className="h-7 w-16 rounded-md border border-hairline bg-surface px-2 text-xs text-foreground focus:outline-none"
              />
              <span className="text-[10px] text-muted-foreground/70">
                (lower runs first)
              </span>
            </label>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-surface-2 cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave(draft)}
            disabled={!canSave || busy}
            className="inline-flex items-center gap-2 rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm hover:opacity-90 disabled:opacity-50 cursor-pointer"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {isNew ? "Create filter" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
