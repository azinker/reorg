"use client";

import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ClipboardList,
  Filter,
  Loader2,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TASK_DUE_FILTER_VALUES,
  TASK_SORT_VALUES,
  TASK_STATUS_LABELS,
  TASK_STATUS_VALUES,
  TASK_URGENCY_LABELS,
  TASK_URGENCY_VALUES,
  type TaskTabValue,
} from "@/lib/tasks";
import { TaskEditorModal } from "@/components/tasks/task-editor-modal";
import { TaskCategoriesModal } from "@/components/tasks/task-categories-modal";
import type {
  TaskEditorFormState,
  TaskFiltersState,
  TaskPageData,
  TaskRecord,
} from "@/components/tasks/types";
import { PageTour } from "@/components/onboarding/page-tour";
import { PAGE_TOUR_STEPS } from "@/components/onboarding/page-tour-steps";

const DEFAULT_FILTERS: TaskFiltersState = {
  tab: "open",
  search: "",
  status: "all",
  urgency: "all",
  assigneeId: "all",
  due: "all",
  categoryId: "all",
  sort: "default",
};

const TAB_LABELS: Record<TaskTabValue, string> = {
  open: "Open",
  completed: "Completed",
  deleted: "Recently Deleted",
  cleanup: "Expired Cleanup",
};

function formatDateTime(value: string | null) {
  if (!value) return "None";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDate(value: string | null) {
  if (!value) return "No due date";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function buildDueAtIso(form: TaskEditorFormState) {
  if (!form.dueDate) return null;
  if (!form.dueTime) return new Date(`${form.dueDate}T12:00:00`).toISOString();
  return new Date(`${form.dueDate}T${form.dueTime}:00`).toISOString();
}

function taskIsOverdue(task: TaskRecord) {
  return (
    task.status !== "COMPLETED" &&
    !task.deletedAt &&
    task.dueAt != null &&
    new Date(task.dueAt).getTime() < Date.now()
  );
}

function urgencyTone(urgency: TaskRecord["urgency"]) {
  if (urgency === "CRITICAL") return "border-red-500/30 bg-red-500/10 text-red-200";
  if (urgency === "HIGH") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (urgency === "MEDIUM") return "border-sky-500/30 bg-sky-500/10 text-sky-200";
  return "border-border bg-background text-muted-foreground";
}

function statusTone(status: TaskRecord["status"]) {
  if (status === "COMPLETED") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
  if (status === "BLOCKED") return "border-red-500/30 bg-red-500/10 text-red-200";
  if (status === "IN_PROGRESS") return "border-primary/30 bg-primary/10 text-primary";
  return "border-border bg-background text-muted-foreground";
}

async function parseJsonResponse(response: Response) {
  const json = (await response.json()) as { error?: string; data?: unknown };
  if (!response.ok) {
    throw new Error(json.error ?? "Request failed");
  }
  return json.data;
}

export default function TasksPage() {
  const [filters, setFilters] = useState<TaskFiltersState>(DEFAULT_FILTERS);
  const deferredSearch = useDeferredValue(filters.search);
  const [data, setData] = useState<TaskPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [banner, setBanner] = useState<{ type: "success" | "error"; message: string } | null>(
    null,
  );
  const [quickAddTitle, setQuickAddTitle] = useState("");
  const [quickAddCategoryId, setQuickAddCategoryId] = useState("");
  const [quickAddUrgency, setQuickAddUrgency] = useState<TaskRecord["urgency"]>("MEDIUM");
  const [quickAddMode, setQuickAddMode] = useState<"mine" | "team">("mine");
  const [quickAddSaving, setQuickAddSaving] = useState(false);
  const [editorTask, setEditorTask] = useState<TaskRecord | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [categorySaving, setCategorySaving] = useState(false);
  const [categoryError, setCategoryError] = useState("");
  const [cleanupSelection, setCleanupSelection] = useState<string[]>([]);

  useEffect(() => {
    let ignore = false;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({
          tab: filters.tab,
          status: filters.status,
          urgency: filters.urgency,
          due: filters.due,
          sort: filters.sort,
        });

        if (deferredSearch.trim()) params.set("search", deferredSearch.trim());
        if (filters.assigneeId !== "all") params.set("assigneeId", filters.assigneeId);
        if (filters.categoryId !== "all") params.set("categoryId", filters.categoryId);

        const response = await fetch(`/api/tasks?${params.toString()}`, {
          cache: "no-store",
        });
        const nextData = (await parseJsonResponse(response)) as TaskPageData;
        if (ignore) return;

        setData(nextData);
        setCleanupSelection((current) =>
          current.filter((taskId) => nextData.tasks.some((task) => task.id === taskId)),
        );

        if (!quickAddCategoryId) {
          const activeCategory = nextData.categories.find((category) => category.isActive);
          setQuickAddCategoryId(activeCategory?.id ?? nextData.categories[0]?.id ?? "");
        }
      } catch (loadError) {
        if (!ignore) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load tasks");
        }
      } finally {
        if (!ignore) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, [
    deferredSearch,
    filters.assigneeId,
    filters.categoryId,
    filters.due,
    filters.sort,
    filters.status,
    filters.tab,
    filters.urgency,
    quickAddCategoryId,
  ]);

  useEffect(() => {
    if (!banner) return undefined;
    const timer = window.setTimeout(() => setBanner(null), 5000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const visibleTabs = useMemo(() => {
    if (!data?.canCleanupDeleted) {
      return ["open", "completed", "deleted"] as TaskTabValue[];
    }
    return ["open", "completed", "deleted", "cleanup"] as TaskTabValue[];
  }, [data?.canCleanupDeleted]);

  async function refreshCurrentView() {
    const params = new URLSearchParams({
      tab: filters.tab,
      status: filters.status,
      urgency: filters.urgency,
      due: filters.due,
      sort: filters.sort,
    });
    if (deferredSearch.trim()) params.set("search", deferredSearch.trim());
    if (filters.assigneeId !== "all") params.set("assigneeId", filters.assigneeId);
    if (filters.categoryId !== "all") params.set("categoryId", filters.categoryId);

    const response = await fetch(`/api/tasks?${params.toString()}`, { cache: "no-store" });
    const nextData = (await parseJsonResponse(response)) as TaskPageData;
    setData(nextData);
    setCleanupSelection([]);
  }

  async function handleQuickAdd() {
    if (!data) return;
    if (!quickAddTitle.trim()) {
      setBanner({ type: "error", message: "Add a task title first." });
      return;
    }

    setQuickAddSaving(true);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: quickAddTitle.trim(),
          categoryId: quickAddCategoryId,
          urgency: quickAddUrgency,
          assignedToUserId: quickAddMode === "mine" ? data.currentUser.id : null,
          isSharedTeamTask: quickAddMode === "team",
        }),
      });
      await parseJsonResponse(response);
      setQuickAddTitle("");
      setBanner({ type: "success", message: "Task added." });
      await refreshCurrentView();
    } catch (saveError) {
      setBanner({
        type: "error",
        message: saveError instanceof Error ? saveError.message : "Failed to create task",
      });
    } finally {
      setQuickAddSaving(false);
    }
  }

  async function submitEditor(form: TaskEditorFormState) {
    setEditorSaving(true);
    setEditorError("");

    try {
      const payload = {
        title: form.title.trim(),
        notes: form.notes || null,
        status: form.status,
        urgency: form.urgency,
        categoryId: form.categoryId,
        assignedToUserId: form.assignedToUserId || null,
        isSharedTeamTask: form.isSharedTeamTask,
        dueAt: buildDueAtIso(form),
      };

      const response = editorTask
        ? await fetch(`/api/tasks/${editorTask.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "update", ...payload }),
          })
        : await fetch("/api/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      await parseJsonResponse(response);
      setEditorOpen(false);
      setEditorTask(null);
      setBanner({
        type: "success",
        message: editorTask ? "Task updated." : "Task created.",
      });
      await refreshCurrentView();
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : "Failed to save task");
    } finally {
      setEditorSaving(false);
    }
  }

  async function runTaskAction(taskId: string, action: "complete" | "reopen" | "delete" | "restore") {
    setEditorSaving(true);
    setEditorError("");
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await parseJsonResponse(response);
      setBanner({
        type: "success",
        message:
          action === "complete"
            ? "Task completed."
            : action === "reopen"
              ? "Task reopened."
              : action === "restore"
                ? "Task restored."
                : "Task moved to Recently Deleted.",
      });
      setEditorOpen(false);
      setEditorTask(null);
      await refreshCurrentView();
    } catch (actionError) {
      const message =
        actionError instanceof Error ? actionError.message : "Task action failed";
      setEditorError(message);
      setBanner({ type: "error", message });
    } finally {
      setEditorSaving(false);
    }
  }

  async function handleCategoryCreate(name: string) {
    setCategorySaving(true);
    setCategoryError("");
    try {
      const response = await fetch("/api/tasks/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await parseJsonResponse(response);
      setBanner({ type: "success", message: "Category added." });
      await refreshCurrentView();
    } catch (categoryCreateError) {
      setCategoryError(
        categoryCreateError instanceof Error
          ? categoryCreateError.message
          : "Failed to create category",
      );
    } finally {
      setCategorySaving(false);
    }
  }

  async function handleCategoryUpdate(
    categoryId: string,
    payload: { name?: string; isActive?: boolean; positionIndex?: number },
  ) {
    setCategorySaving(true);
    setCategoryError("");
    try {
      const response = await fetch(`/api/tasks/categories/${categoryId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await parseJsonResponse(response);
      setBanner({ type: "success", message: "Category updated." });
      await refreshCurrentView();
    } catch (categoryUpdateError) {
      setCategoryError(
        categoryUpdateError instanceof Error
          ? categoryUpdateError.message
          : "Failed to update category",
      );
    } finally {
      setCategorySaving(false);
    }
  }

  async function handleCleanup() {
    if (cleanupSelection.length === 0) {
      setBanner({ type: "error", message: "Select at least one expired task to purge." });
      return;
    }

    setCategorySaving(true);
    try {
      const response = await fetch("/api/tasks/cleanup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskIds: cleanupSelection }),
      });
      const result = (await parseJsonResponse(response)) as { deletedCount: number };
      setBanner({
        type: "success",
        message: `${result.deletedCount} expired task${result.deletedCount === 1 ? "" : "s"} permanently deleted.`,
      });
      await refreshCurrentView();
    } catch (cleanupError) {
      setBanner({
        type: "error",
        message: cleanupError instanceof Error ? cleanupError.message : "Cleanup failed",
      });
    } finally {
      setCategorySaving(false);
    }
  }

  const activeCategories = data?.categories.filter((category) => category.isActive) ?? [];
  const tasks = data?.tasks ?? [];

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div data-tour="tasks-header">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Personal work, assigned work, and shared team tasks in one operational queue.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data?.canManageCategories ? (
            <button
              type="button"
              onClick={() => setCategoriesOpen(true)}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Settings2 className="h-4 w-4" />
              Manage Categories
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setEditorTask(null);
              setEditorError("");
              setEditorOpen(true);
            }}
            className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Task
          </button>
        </div>
      </div>

      {banner ? (
        <div
          className={cn(
            "mb-5 rounded-lg border px-4 py-3 text-sm",
            banner.type === "success"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/30 bg-red-500/10 text-red-200",
          )}
        >
          {banner.message}
        </div>
      ) : null}

      <section
        data-tour="tasks-quick-add"
        className="mb-5 rounded-2xl border border-border bg-card p-4"
      >
        <div className="mb-4 flex items-center gap-2">
          <ClipboardList className="h-5 w-5 text-[#C43E3E]" />
          <div>
            <h2 className="text-base font-semibold text-foreground">Quick add</h2>
            <p className="text-sm text-muted-foreground">
              Capture it fast now, then open the full editor if it needs more detail.
            </p>
          </div>
        </div>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_220px_180px_240px_auto]">
          <input
            value={quickAddTitle}
            onChange={(event) => setQuickAddTitle(event.target.value)}
            placeholder="Add a task title"
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
          />
          <select
            value={quickAddCategoryId}
            onChange={(event) => setQuickAddCategoryId(event.target.value)}
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
          >
            {activeCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <select
            value={quickAddUrgency}
            onChange={(event) =>
              setQuickAddUrgency(event.target.value as TaskRecord["urgency"])
            }
            className="w-full rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
          >
            {TASK_URGENCY_VALUES.map((urgency) => (
              <option key={urgency} value={urgency}>
                {TASK_URGENCY_LABELS[urgency]}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setQuickAddMode("mine")}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer",
                quickAddMode === "mine"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              My task
            </button>
            <button
              type="button"
              onClick={() => setQuickAddMode("team")}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer",
                quickAddMode === "team"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              Team task
            </button>
          </div>
          <button
            type="button"
            onClick={() => void handleQuickAdd()}
            disabled={quickAddSaving || !quickAddCategoryId}
            className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {quickAddSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Add
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card" data-tour="tasks-filters">
        <div className="border-b border-border px-4 py-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap gap-2">
              {visibleTabs.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() =>
                    startTransition(() =>
                      setFilters((current) => ({
                        ...current,
                        tab,
                        status: tab === "completed" ? "all" : current.status,
                      })),
                    )
                  }
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors",
                    filters.tab === tab
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:text-foreground",
                  )}
                >
                  {TAB_LABELS[tab]}
                  <span className="rounded-full bg-background/70 px-2 py-0.5 text-xs">
                    {data?.counts[tab] ?? 0}
                  </span>
                </button>
              ))}
            </div>

            {filters.tab === "cleanup" ? (
              <button
                type="button"
                onClick={() => void handleCleanup()}
                disabled={categorySaving || cleanupSelection.length === 0}
                className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Permanently Delete Selected
              </button>
            ) : null}
          </div>
        </div>

        <div className="border-b border-border px-4 py-4">
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.4fr)_repeat(6,minmax(0,1fr))]">
            <label className="relative">
              <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <input
                value={filters.search}
                onChange={(event) =>
                  startTransition(() =>
                    setFilters((current) => ({ ...current, search: event.target.value })),
                  )
                }
                placeholder="Search title, notes, or category"
                className="w-full rounded-xl border border-input bg-background py-2.5 pl-9 pr-3 text-sm text-foreground outline-none"
              />
            </label>
            <select
              value={filters.status}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  status: event.target.value as TaskFiltersState["status"],
                }))
              }
              className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
            >
              <option value="all">All statuses</option>
              {TASK_STATUS_VALUES.map((status) => (
                <option key={status} value={status}>
                  {TASK_STATUS_LABELS[status]}
                </option>
              ))}
            </select>
            <select
              value={filters.urgency}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  urgency: event.target.value as TaskFiltersState["urgency"],
                }))
              }
              className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
            >
              <option value="all">All urgency</option>
              {TASK_URGENCY_VALUES.map((urgency) => (
                <option key={urgency} value={urgency}>
                  {TASK_URGENCY_LABELS[urgency]}
                </option>
              ))}
            </select>
            <select
              value={filters.assigneeId}
              onChange={(event) =>
                setFilters((current) => ({ ...current, assigneeId: event.target.value }))
              }
              className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
            >
              <option value="all">All assignees</option>
              <option value="me">Assigned to me</option>
              <option value="unassigned">Unassigned</option>
              {data?.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
            <select
              value={filters.due}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  due: event.target.value as TaskFiltersState["due"],
                }))
              }
              className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
            >
              {TASK_DUE_FILTER_VALUES.map((value) => (
                <option key={value} value={value}>
                  {value === "all"
                    ? "All due dates"
                    : value === "none"
                      ? "No due date"
                      : value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
            <select
              value={filters.categoryId}
              onChange={(event) =>
                setFilters((current) => ({ ...current, categoryId: event.target.value }))
              }
              className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
            >
              <option value="all">All categories</option>
              {data?.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <select
              value={filters.sort}
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  sort: event.target.value as TaskFiltersState["sort"],
                }))
              }
              className="rounded-xl border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
            >
              {TASK_SORT_VALUES.map((sortValue) => (
                <option key={sortValue} value={sortValue}>
                  {sortValue === "default"
                    ? "Operational default"
                    : sortValue === "dueAt"
                      ? "Due date"
                      : sortValue === "createdAt"
                        ? "Created date"
                        : sortValue === "updatedAt"
                          ? "Updated date"
                          : "Urgency"}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="px-4 py-4" data-tour="tasks-list">
          {error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-4 text-sm text-red-200">
              {error}
            </div>
          ) : loading && !data ? (
            <div className="rounded-xl border border-border bg-background/60 px-4 py-10 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-3 h-5 w-5 animate-spin" />
              Loading tasks...
            </div>
          ) : tasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-12 text-center">
              <Filter className="mx-auto mb-3 h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">Nothing matches this view yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Try adjusting the filters, or add a new task above.
              </p>
            </div>
          ) : (
            <>
              <div className="hidden overflow-x-auto lg:block">
                <table className="w-full min-w-[980px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      {filters.tab === "cleanup" ? <th className="px-3 py-2 font-medium">Pick</th> : null}
                      <th className="px-3 py-2 font-medium">Task</th>
                      <th className="px-3 py-2 font-medium">Category</th>
                      <th className="px-3 py-2 font-medium">Assignee</th>
                      <th className="px-3 py-2 font-medium">Due</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Urgency</th>
                      <th className="px-3 py-2 font-medium">Updated</th>
                      <th className="px-3 py-2 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((task) => {
                      const overdue = taskIsOverdue(task);
                      return (
                        <tr
                          key={task.id}
                          className={cn(
                            "border-b border-border/60 align-top last:border-b-0",
                            overdue && "bg-red-500/5",
                          )}
                        >
                          {filters.tab === "cleanup" ? (
                            <td className="px-3 py-3">
                              <input
                                type="checkbox"
                                checked={cleanupSelection.includes(task.id)}
                                onChange={(event) =>
                                  setCleanupSelection((current) =>
                                    event.target.checked
                                      ? [...current, task.id]
                                      : current.filter((id) => id !== task.id),
                                  )
                                }
                                className="h-4 w-4 cursor-pointer rounded border-input"
                              />
                            </td>
                          ) : null}
                          <td className="px-3 py-3">
                            <div className="flex items-start gap-3">
                              {filters.tab === "open" || filters.tab === "completed" ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void runTaskAction(
                                      task.id,
                                      task.status === "COMPLETED" ? "reopen" : "complete",
                                    )
                                  }
                                  className={cn(
                                    "mt-0.5 inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border transition-colors",
                                    task.status === "COMPLETED"
                                      ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                                      : "border-border bg-background text-transparent hover:text-muted-foreground",
                                  )}
                                  aria-label={
                                    task.status === "COMPLETED" ? "Reopen task" : "Complete task"
                                  }
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                </button>
                              ) : null}
                              <button
                                type="button"
                                onClick={() => {
                                  setEditorTask(task);
                                  setEditorError("");
                                  setEditorOpen(true);
                                }}
                                className="cursor-pointer text-left"
                              >
                                <div className="font-medium text-foreground">{task.title}</div>
                                <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                  <span>{task.isSharedTeamTask ? "Shared team task" : "Personal task"}</span>
                                  <span>Created by {task.createdBy.name}</span>
                                  {overdue ? <span className="text-red-300">Overdue</span> : null}
                                </div>
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-muted-foreground">{task.category.name}</td>
                          <td className="px-3 py-3 text-muted-foreground">
                            {task.assignedTo?.name ?? "Unassigned"}
                          </td>
                          <td className="px-3 py-3">
                            <div className={cn(overdue && "font-medium text-red-200")}>
                              {formatShortDate(task.dueAt)}
                            </div>
                            {task.deletedUntil && filters.tab === "deleted" ? (
                              <div className="mt-1 text-xs text-muted-foreground">
                                Restore until {formatShortDate(task.deletedUntil)}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-3 py-3">
                            <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", statusTone(task.status))}>
                              {TASK_STATUS_LABELS[task.status]}
                            </span>
                          </td>
                          <td className="px-3 py-3">
                            <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", urgencyTone(task.urgency))}>
                              {TASK_URGENCY_LABELS[task.urgency]}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-muted-foreground">
                            {formatDateTime(task.updatedAt)}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <div className="flex justify-end gap-2">
                              {filters.tab === "deleted" ? (
                                <button
                                  type="button"
                                  onClick={() => void runTaskAction(task.id, "restore")}
                                  disabled={!task.permissions.canRestore}
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  Restore
                                </button>
                              ) : filters.tab !== "cleanup" ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void runTaskAction(
                                      task.id,
                                      task.status === "COMPLETED" ? "reopen" : "complete",
                                    )
                                  }
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                                >
                                  {task.status === "COMPLETED" ? "Reopen" : "Complete"}
                                </button>
                              ) : null}
                              {filters.tab !== "deleted" && filters.tab !== "cleanup" ? (
                                <button
                                  type="button"
                                  onClick={() => void runTaskAction(task.id, "delete")}
                                  className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-200 transition-colors hover:bg-red-500/20"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                  Delete
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid gap-3 lg:hidden">
                {tasks.map((task) => {
                  const overdue = taskIsOverdue(task);
                  return (
                    <div
                      key={task.id}
                      className={cn(
                        "rounded-xl border p-4",
                        overdue
                          ? "border-red-500/30 bg-red-500/5"
                          : "border-border bg-background/60",
                      )}
                    >
                      <div className="mb-3 flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          {filters.tab === "cleanup" ? (
                            <input
                              type="checkbox"
                              checked={cleanupSelection.includes(task.id)}
                              onChange={(event) =>
                                setCleanupSelection((current) =>
                                  event.target.checked
                                    ? [...current, task.id]
                                    : current.filter((id) => id !== task.id),
                                )
                              }
                              className="mt-1 h-4 w-4 cursor-pointer rounded border-input"
                            />
                          ) : null}
                          <button
                            type="button"
                            onClick={() => {
                              setEditorTask(task);
                              setEditorError("");
                              setEditorOpen(true);
                            }}
                            className="cursor-pointer text-left"
                          >
                            <div className="font-medium text-foreground">{task.title}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {task.isSharedTeamTask ? "Shared team task" : "Personal task"}
                            </div>
                          </button>
                        </div>
                        <span className={cn("rounded-full border px-2.5 py-1 text-[11px] font-medium", urgencyTone(task.urgency))}>
                          {TASK_URGENCY_LABELS[task.urgency]}
                        </span>
                      </div>

                      <div className="grid gap-2 text-sm text-muted-foreground">
                        <div>Category: {task.category.name}</div>
                        <div>Assignee: {task.assignedTo?.name ?? "Unassigned"}</div>
                        <div className={cn(overdue && "font-medium text-red-200")}>
                          Due: {formatShortDate(task.dueAt)}
                        </div>
                        <div>Updated: {formatDateTime(task.updatedAt)}</div>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-2">
                        {filters.tab === "deleted" ? (
                          <button
                            type="button"
                            onClick={() => void runTaskAction(task.id, "restore")}
                            disabled={!task.permissions.canRestore}
                            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <RotateCcw className="h-4 w-4" />
                            Restore
                          </button>
                        ) : filters.tab !== "cleanup" ? (
                          <button
                            type="button"
                            onClick={() =>
                              void runTaskAction(
                                task.id,
                                task.status === "COMPLETED" ? "reopen" : "complete",
                              )
                            }
                            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            {task.status === "COMPLETED" ? <RotateCcw className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
                            {task.status === "COMPLETED" ? "Reopen" : "Complete"}
                          </button>
                        ) : null}
                        {filters.tab !== "deleted" && filters.tab !== "cleanup" ? (
                          <button
                            type="button"
                            onClick={() => void runTaskAction(task.id, "delete")}
                            className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/20"
                          >
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </section>

      {data ? (
        <>
          <TaskEditorModal
            open={editorOpen}
            task={editorTask}
            categories={data.categories}
            users={data.users}
            currentUser={data.currentUser}
            saving={editorSaving}
            error={editorError}
            onClose={() => {
              setEditorOpen(false);
              setEditorTask(null);
              setEditorError("");
            }}
            onSubmit={submitEditor}
            onComplete={() => (editorTask ? runTaskAction(editorTask.id, "complete") : Promise.resolve())}
            onReopen={() => (editorTask ? runTaskAction(editorTask.id, "reopen") : Promise.resolve())}
            onDelete={() => (editorTask ? runTaskAction(editorTask.id, "delete") : Promise.resolve())}
            onRestore={() => (editorTask ? runTaskAction(editorTask.id, "restore") : Promise.resolve())}
          />

          <TaskCategoriesModal
            open={categoriesOpen}
            categories={data.categories}
            saving={categorySaving}
            error={categoryError}
            onClose={() => {
              setCategoriesOpen(false);
              setCategoryError("");
            }}
            onCreate={handleCategoryCreate}
            onUpdate={handleCategoryUpdate}
          />
        </>
      ) : null}

      <PageTour page="tasks" steps={PAGE_TOUR_STEPS.tasks} ready />
    </div>
  );
}
