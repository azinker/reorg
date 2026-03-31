"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, RotateCcw, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TASK_STATUS_LABELS,
  TASK_STATUS_VALUES,
  TASK_URGENCY_LABELS,
  TASK_URGENCY_VALUES,
} from "@/lib/tasks";
import type {
  TaskCategoryOption,
  TaskEditorFormState,
  TaskRecord,
  TaskUserOption,
} from "@/components/tasks/types";

function splitDueAt(dueAt: string | null) {
  if (!dueAt) {
    return { dueDate: "", dueTime: "" };
  }

  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime())) {
    return { dueDate: "", dueTime: "" };
  }

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");

  return {
    dueDate: `${year}-${month}-${day}`,
    dueTime: dueAt.includes("T") ? `${hours}:${minutes}` : "",
  };
}

function defaultForm(
  task: TaskRecord | null,
  categories: TaskCategoryOption[],
  currentUser: TaskUserOption,
): TaskEditorFormState {
  const fallbackCategory =
    categories.find((category) => category.isActive)?.id ??
    categories[0]?.id ??
    "";

  if (!task) {
    return {
      title: "",
      notes: "",
      status: "OPEN",
      urgency: "MEDIUM",
      categoryId: fallbackCategory,
      assignedToUserId: currentUser.id,
      isSharedTeamTask: false,
      dueDate: "",
      dueTime: "",
    };
  }

  const { dueDate, dueTime } = splitDueAt(task.dueAt);
  return {
    title: task.title,
    notes: task.notes ?? "",
    status: task.status,
    urgency: task.urgency,
    categoryId: task.category.id,
    assignedToUserId: task.assignedTo?.id ?? "",
    isSharedTeamTask: task.isSharedTeamTask,
    dueDate,
    dueTime,
  };
}

function formatTimestamp(value: string | null) {
  if (!value) return "Not set";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function TaskEditorModal({
  open,
  task,
  categories,
  users,
  currentUser,
  saving,
  error,
  onClose,
  onSubmit,
  onComplete,
  onReopen,
  onDelete,
  onRestore,
}: {
  open: boolean;
  task: TaskRecord | null;
  categories: TaskCategoryOption[];
  users: TaskUserOption[];
  currentUser: TaskUserOption;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (form: TaskEditorFormState) => Promise<void> | void;
  onComplete: () => Promise<void> | void;
  onReopen: () => Promise<void> | void;
  onDelete: () => Promise<void> | void;
  onRestore: () => Promise<void> | void;
}) {
  const [form, setForm] = useState<TaskEditorFormState>(() =>
    defaultForm(task, categories, currentUser),
  );

  useEffect(() => {
    if (!open) return;

    setForm(defaultForm(task, categories, currentUser));
  }, [categories, currentUser, open, task]);

  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const categoryOptions = useMemo(() => {
    return categories.filter(
      (category) => category.isActive || category.id === form.categoryId,
    );
  }, [categories, form.categoryId]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {task ? "Task Details" : "Create Task"}
            </h2>
            <p className="text-sm text-muted-foreground">
              Keep it lightweight, assign clearly, and stage the rest here if needed.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close task editor"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1.3fr)_360px]">
          <div className="min-h-0 overflow-y-auto px-5 py-5">
            <div className="grid gap-4">
              <label className="space-y-2">
                <span className="text-sm font-medium text-foreground">Title</span>
                <input
                  value={form.title}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="What needs to happen?"
                  className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                />
              </label>

              <label className="space-y-2">
                <span className="text-sm font-medium text-foreground">Notes</span>
                <textarea
                  value={form.notes}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, notes: event.target.value }))
                  }
                  rows={7}
                  placeholder="Plain-text notes, handoff details, blockers, or checklist context."
                  className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm font-medium text-foreground">Status</span>
                  <select
                    value={form.status}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        status: event.target.value as TaskEditorFormState["status"],
                      }))
                    }
                    className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                  >
                    {TASK_STATUS_VALUES.map((status) => (
                      <option key={status} value={status}>
                        {TASK_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-foreground">Urgency</span>
                  <select
                    value={form.urgency}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        urgency: event.target.value as TaskEditorFormState["urgency"],
                      }))
                    }
                    className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                  >
                    {TASK_URGENCY_VALUES.map((urgency) => (
                      <option key={urgency} value={urgency}>
                        {TASK_URGENCY_LABELS[urgency]}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-foreground">Category</span>
                  <select
                    value={form.categoryId}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, categoryId: event.target.value }))
                    }
                    className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                  >
                    {categoryOptions.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.name}
                        {category.isActive ? "" : " (Disabled)"}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-medium text-foreground">Assignee</span>
                  <select
                    value={form.assignedToUserId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        assignedToUserId: event.target.value,
                      }))
                    }
                    className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                  >
                    <option value="">Unassigned</option>
                    {users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_160px]">
                <div className="rounded-xl border border-border bg-background/60 p-4">
                  <div className="mb-3 text-sm font-medium text-foreground">Visibility</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          isSharedTeamTask: false,
                          assignedToUserId: current.assignedToUserId || currentUser.id,
                        }))
                      }
                      className={cn(
                        "rounded-lg border px-3 py-3 text-left text-sm transition-colors cursor-pointer",
                        !form.isSharedTeamTask
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <div className="font-medium">My task</div>
                      <div className="mt-1 text-xs">
                        Personal list by default and easy to assign back to yourself.
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          isSharedTeamTask: true,
                        }))
                      }
                      className={cn(
                        "rounded-lg border px-3 py-3 text-left text-sm transition-colors cursor-pointer",
                        form.isSharedTeamTask
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <div className="font-medium">Shared team task</div>
                      <div className="mt-1 text-xs">
                        Shows up in the team view so others can see and pick it up.
                      </div>
                    </button>
                  </div>
                </div>

                <div className="grid gap-3">
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-foreground">Due date</span>
                    <input
                      type="date"
                      value={form.dueDate}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, dueDate: event.target.value }))
                      }
                      className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                    />
                  </label>
                  <label className="space-y-2">
                    <span className="text-sm font-medium text-foreground">Time</span>
                    <input
                      type="time"
                      value={form.dueTime}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, dueTime: event.target.value }))
                      }
                      className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>

          <aside className="min-h-0 overflow-y-auto border-t border-border bg-background/35 px-5 py-5 lg:border-l lg:border-t-0">
            <div className="space-y-5">
              <section className="rounded-xl border border-border bg-card/80 p-4">
                <h3 className="text-sm font-semibold text-foreground">Timeline</h3>
                <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                  <div>Created: {formatTimestamp(task?.createdAt ?? null)}</div>
                  <div>Updated: {formatTimestamp(task?.updatedAt ?? null)}</div>
                  <div>Completed: {formatTimestamp(task?.completedAt ?? null)}</div>
                  {task?.deletedAt ? <div>Deleted: {formatTimestamp(task.deletedAt)}</div> : null}
                  {task?.deletedUntil ? (
                    <div>Restore until: {formatTimestamp(task.deletedUntil)}</div>
                  ) : null}
                </div>
              </section>

              <section className="rounded-xl border border-border bg-card/80 p-4">
                <h3 className="text-sm font-semibold text-foreground">Activity</h3>
                <div className="mt-3 space-y-3">
                  {task?.activity.length ? (
                    task.activity.map((entry) => (
                      <div key={entry.id} className="rounded-lg border border-border/70 bg-background/70 p-3">
                        <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                          {entry.type.replace(/_/g, " ")}
                        </div>
                        <div className="mt-1 text-sm text-foreground">
                          {entry.actor?.name ?? "System"}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatTimestamp(entry.createdAt)}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      Activity will appear here as the task changes.
                    </div>
                  )}
                </div>
              </section>
            </div>
          </aside>
        </div>

        <div className="border-t border-border px-5 py-4">
          {error ? (
            <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {task ? (
                task.deletedAt ? (
                  <button
                    type="button"
                    onClick={() => void onRestore()}
                    disabled={saving || !task.permissions.canRestore}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Restore
                  </button>
                ) : task.status === "COMPLETED" ? (
                  <button
                    type="button"
                    onClick={() => void onReopen()}
                    disabled={saving}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCcw className="h-4 w-4" />
                    Reopen
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void onComplete()}
                    disabled={saving}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Complete
                  </button>
                )
              ) : null}

              {task && !task.deletedAt ? (
                <button
                  type="button"
                  onClick={() => void onDelete()}
                  disabled={saving || !task.permissions.canDelete}
                  className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </button>
              ) : null}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onSubmit(form)}
                disabled={saving || Boolean(task?.deletedAt)}
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {task ? "Save changes" : "Create task"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
