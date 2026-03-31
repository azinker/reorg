export const TASK_STATUS_VALUES = [
  "OPEN",
  "IN_PROGRESS",
  "BLOCKED",
  "COMPLETED",
] as const;

export const TASK_URGENCY_VALUES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

export const TASK_TAB_VALUES = [
  "open",
  "completed",
  "deleted",
  "cleanup",
] as const;

export const TASK_DUE_FILTER_VALUES = [
  "all",
  "overdue",
  "today",
  "upcoming",
  "none",
] as const;

export const TASK_SORT_VALUES = [
  "default",
  "dueAt",
  "urgency",
  "createdAt",
  "updatedAt",
] as const;

export const TASK_ACTIVITY_TYPE_VALUES = [
  "CREATED",
  "UPDATED",
  "COMPLETED",
  "REOPENED",
  "DELETED",
  "RESTORED",
] as const;

export type TaskStatusValue = (typeof TASK_STATUS_VALUES)[number];
export type TaskUrgencyValue = (typeof TASK_URGENCY_VALUES)[number];
export type TaskTabValue = (typeof TASK_TAB_VALUES)[number];
export type TaskDueFilterValue = (typeof TASK_DUE_FILTER_VALUES)[number];
export type TaskSortValue = (typeof TASK_SORT_VALUES)[number];
export type TaskActivityTypeValue = (typeof TASK_ACTIVITY_TYPE_VALUES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatusValue, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Blocked",
  COMPLETED: "Completed",
};

export const TASK_URGENCY_LABELS: Record<TaskUrgencyValue, string> = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
  CRITICAL: "Critical",
};

export const TASK_ACTIVITY_LABELS: Record<TaskActivityTypeValue, string> = {
  CREATED: "Created",
  UPDATED: "Updated",
  COMPLETED: "Completed",
  REOPENED: "Reopened",
  DELETED: "Deleted",
  RESTORED: "Restored",
};

export const TASK_RESTORE_WINDOW_DAYS = 30;

export const INITIAL_TASK_CATEGORIES = [
  { id: "taskcat_operations", name: "Operations", slug: "operations", sortOrder: 0 },
  { id: "taskcat_inventory", name: "Inventory", slug: "inventory", sortOrder: 1 },
  { id: "taskcat_pricing", name: "Pricing", slug: "pricing", sortOrder: 2 },
  { id: "taskcat_listings", name: "Listings", slug: "listings", sortOrder: 3 },
  { id: "taskcat_purchasing", name: "Purchasing", slug: "purchasing", sortOrder: 4 },
  { id: "taskcat_customer_service", name: "Customer Service", slug: "customer-service", sortOrder: 5 },
  { id: "taskcat_warehouse", name: "Warehouse", slug: "warehouse", sortOrder: 6 },
  { id: "taskcat_admin", name: "Admin", slug: "admin", sortOrder: 7 },
  { id: "taskcat_other", name: "Other", slug: "other", sortOrder: 8 },
  { id: "taskcat_reshipping", name: "Reshipping", slug: "reshipping", sortOrder: 9 },
] as const;

export function slugifyTaskCategoryName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function getTaskRestoreDeadline(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + TASK_RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

export function isTaskRestoreExpired(deletedAt: Date, now = new Date()): boolean {
  return getTaskRestoreDeadline(deletedAt).getTime() <= now.getTime();
}
