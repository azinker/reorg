"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskCategoryOption } from "@/components/tasks/types";

export function TaskCategoriesModal({
  open,
  categories,
  saving,
  error,
  onClose,
  onCreate,
  onUpdate,
}: {
  open: boolean;
  categories: TaskCategoryOption[];
  saving: boolean;
  error: string;
  onClose: () => void;
  onCreate: (name: string) => Promise<void> | void;
  onUpdate: (
    categoryId: string,
    payload: { name?: string; isActive?: boolean; positionIndex?: number },
  ) => Promise<void> | void;
}) {
  const [newName, setNewName] = useState("");
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;

    setRenameDrafts(
      Object.fromEntries(categories.map((category) => [category.id, category.name])),
    );
  }, [categories, open]);

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

  const orderedCategories = useMemo(
    () => [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [categories],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative z-10 flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Task Categories</h2>
            <p className="text-sm text-muted-foreground">
              Admin-only category management with safe disable and manual ordering.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close category manager"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-border px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Add a new category"
              className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
            />
            <button
              type="button"
              onClick={() => {
                const name = newName.trim();
                if (!name) return;
                void onCreate(name);
                setNewName("");
              }}
              disabled={saving}
              className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add category
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error ? (
            <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="space-y-3">
            {orderedCategories.map((category, index) => (
              <div
                key={category.id}
                className={cn(
                  "rounded-xl border px-4 py-4",
                  category.isActive
                    ? "border-border bg-background/70"
                    : "border-amber-500/30 bg-amber-500/10",
                )}
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Position {index + 1}
                      </span>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          category.isActive
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                            : "border-amber-500/30 bg-amber-500/10 text-amber-200",
                        )}
                      >
                        {category.isActive ? "Active" : "Disabled"}
                      </span>
                      <span className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                        {category.taskCount} task{category.taskCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <input
                      value={renameDrafts[category.id] ?? category.name}
                      onChange={(event) =>
                        setRenameDrafts((current) => ({
                          ...current,
                          [category.id]: event.target.value,
                        }))
                      }
                      className="w-full rounded-lg border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void onUpdate(category.id, { positionIndex: index - 1 })}
                      disabled={saving || index === 0}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ArrowUp className="h-4 w-4" />
                      Up
                    </button>
                    <button
                      type="button"
                      onClick={() => void onUpdate(category.id, { positionIndex: index + 1 })}
                      disabled={saving || index === orderedCategories.length - 1}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <ArrowDown className="h-4 w-4" />
                      Down
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void onUpdate(category.id, {
                          name: (renameDrafts[category.id] ?? category.name).trim(),
                        })
                      }
                      disabled={saving}
                      className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Save name
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void onUpdate(category.id, { isActive: !category.isActive })
                      }
                      disabled={saving}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                        category.isActive
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20"
                          : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
                      )}
                    >
                      {category.isActive ? "Disable" : "Enable"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
