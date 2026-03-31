import type {
  TaskActivityTypeValue,
  TaskDueFilterValue,
  TaskSortValue,
  TaskStatusValue,
  TaskTabValue,
  TaskUrgencyValue,
} from "@/lib/tasks";

export type TaskUserOption = {
  id: string;
  name: string;
  email: string;
  role: string;
};

export type TaskCategoryOption = {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  isActive: boolean;
  taskCount: number;
};

export type TaskActivityEntry = {
  id: string;
  type: TaskActivityTypeValue;
  details: unknown;
  createdAt: string;
  actor: TaskUserOption | null;
};

export type TaskRecord = {
  id: string;
  title: string;
  notes: string | null;
  status: TaskStatusValue;
  urgency: TaskUrgencyValue;
  isSharedTeamTask: boolean;
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  deletedUntil: string | null;
  restoredAt: string | null;
  category: {
    id: string;
    name: string;
    isActive: boolean;
    sortOrder: number;
  };
  createdBy: TaskUserOption;
  assignedTo: TaskUserOption | null;
  deletedBy: TaskUserOption | null;
  permissions: {
    canEdit: boolean;
    canDelete: boolean;
    canRestore: boolean;
    canViewDeleted: boolean;
  };
  activity: TaskActivityEntry[];
};

export type TaskPageData = {
  currentUser: TaskUserOption;
  canManageCategories: boolean;
  canCleanupDeleted: boolean;
  restoreWindowDays: number;
  counts: Record<TaskTabValue, number>;
  tasks: TaskRecord[];
  categories: TaskCategoryOption[];
  users: TaskUserOption[];
};

export type TaskFiltersState = {
  tab: TaskTabValue;
  search: string;
  status: TaskStatusValue | "all";
  urgency: TaskUrgencyValue | "all";
  assigneeId: string;
  due: TaskDueFilterValue;
  categoryId: string;
  sort: TaskSortValue;
};

export type TaskEditorFormState = {
  title: string;
  notes: string;
  status: TaskStatusValue;
  urgency: TaskUrgencyValue;
  categoryId: string;
  assignedToUserId: string;
  isSharedTeamTask: boolean;
  dueDate: string;
  dueTime: string;
};
