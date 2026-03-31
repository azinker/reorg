import {
  Prisma,
  TaskActivityType,
  TaskStatus,
  TaskUrgency,
} from "@prisma/client";
import { db } from "@/lib/db";
import {
  TASK_RESTORE_WINDOW_DAYS,
  type TaskDueFilterValue,
  type TaskSortValue,
  type TaskTabValue,
  slugifyTaskCategoryName,
} from "@/lib/tasks";

export class TaskServiceError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "TaskServiceError";
    this.status = status;
  }
}

export type AuthenticatedTaskUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: string;
};

export type TaskListFilters = {
  tab: TaskTabValue;
  search?: string;
  status?: TaskStatus | "all";
  urgency?: TaskUrgency | "all";
  assigneeId?: string | "all" | "unassigned" | "me";
  due?: TaskDueFilterValue;
  categoryId?: string | "all";
  sort?: TaskSortValue;
};

export type CreateTaskInput = {
  title: string;
  notes?: string | null;
  status?: TaskStatus;
  urgency?: TaskUrgency;
  categoryId: string;
  assignedToUserId?: string | null;
  isSharedTeamTask?: boolean;
  dueAt?: Date | null;
};

export type UpdateTaskInput = {
  title?: string;
  notes?: string | null;
  status?: TaskStatus;
  urgency?: TaskUrgency;
  categoryId?: string;
  assignedToUserId?: string | null;
  isSharedTeamTask?: boolean;
  dueAt?: Date | null;
};

const taskInclude = {
  category: true,
  createdBy: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  },
  assignedTo: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  },
  deletedBy: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  },
  activities: {
    orderBy: { createdAt: "desc" },
    take: 12,
    include: {
      actor: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
        },
      },
    },
  },
} satisfies Prisma.TaskInclude;

type TaskWithRelations = Prisma.TaskGetPayload<{
  include: typeof taskInclude;
}>;

type TaskActivityClient = Pick<typeof db, "taskActivity" | "auditLog">;
type TaskCategoryClient = Pick<typeof db, "taskCategory">;

function isAdmin(user: AuthenticatedTaskUser): boolean {
  return user.role === "ADMIN";
}

function displayName(user: { name?: string | null; email?: string | null } | null): string {
  if (!user) return "Unknown user";
  return user.name?.trim() || user.email?.trim() || "Unknown user";
}

function restoreWindowCutoff(now = new Date()): Date {
  return new Date(now.getTime() - TASK_RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function hasTaskEditPermission(
  task: Pick<TaskWithRelations, "createdByUserId" | "assignedToUserId">,
  user: AuthenticatedTaskUser,
) {
  return (
    isAdmin(user) ||
    task.createdByUserId === user.id ||
    task.assignedToUserId === user.id
  );
}

function hasDeletedVisibility(
  task: Pick<TaskWithRelations, "createdByUserId">,
  user: AuthenticatedTaskUser,
) {
  return isAdmin(user) || task.createdByUserId === user.id;
}

function hasRestorePermission(
  task: Pick<TaskWithRelations, "createdByUserId" | "assignedToUserId">,
  user: AuthenticatedTaskUser,
) {
  return (
    isAdmin(user) ||
    task.createdByUserId === user.id ||
    task.assignedToUserId === user.id
  );
}

function requireTaskPermission(condition: boolean, message: string, status = 403) {
  if (!condition) {
    throw new TaskServiceError(message, status);
  }
}

function normalizeSearch(search?: string): string | undefined {
  const value = search?.trim();
  return value ? value : undefined;
}

function buildTabVisibilityWhere(
  tab: TaskTabValue,
  user: AuthenticatedTaskUser,
): Prisma.TaskWhereInput {
  if (tab === "deleted") {
    return isAdmin(user)
      ? { deletedAt: { not: null } }
      : {
          deletedAt: { not: null },
          createdByUserId: user.id,
        };
  }

  if (tab === "cleanup") {
    requireTaskPermission(
      isAdmin(user),
      "Only admins can review permanently deletable tasks.",
    );

    return {
      deletedAt: { lte: restoreWindowCutoff() },
    };
  }

  const sharedVisibility: Prisma.TaskWhereInput[] = [
    { createdByUserId: user.id },
    { assignedToUserId: user.id },
    { isSharedTeamTask: true },
  ];

  if (tab === "completed") {
    return {
      deletedAt: null,
      status: TaskStatus.COMPLETED,
      OR: sharedVisibility,
    };
  }

  return {
    deletedAt: null,
    status: { not: TaskStatus.COMPLETED },
    OR: sharedVisibility,
  };
}

function buildTaskFiltersWhere(
  filters: TaskListFilters,
  user: AuthenticatedTaskUser,
): Prisma.TaskWhereInput {
  const andConditions: Prisma.TaskWhereInput[] = [
    buildTabVisibilityWhere(filters.tab, user),
  ];

  if (filters.tab !== "cleanup") {
    if (filters.status && filters.status !== "all") {
      andConditions.push({ status: filters.status });
    }

    if (filters.urgency && filters.urgency !== "all") {
      andConditions.push({ urgency: filters.urgency });
    }

    if (filters.assigneeId && filters.assigneeId !== "all") {
      if (filters.assigneeId === "unassigned") {
        andConditions.push({ assignedToUserId: null });
      } else if (filters.assigneeId === "me") {
        andConditions.push({ assignedToUserId: user.id });
      } else {
        andConditions.push({ assignedToUserId: filters.assigneeId });
      }
    }

    if (filters.categoryId && filters.categoryId !== "all") {
      andConditions.push({ categoryId: filters.categoryId });
    }
  }

  const dueFilter = filters.due ?? "all";
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  if (dueFilter === "overdue") {
    andConditions.push({ dueAt: { not: null, lt: now } });
  } else if (dueFilter === "today") {
    andConditions.push({ dueAt: { gte: startOfToday, lt: endOfToday } });
  } else if (dueFilter === "upcoming") {
    andConditions.push({ dueAt: { gte: endOfToday } });
  } else if (dueFilter === "none") {
    andConditions.push({ dueAt: null });
  }

  const search = normalizeSearch(filters.search);
  if (search) {
    andConditions.push({
      OR: [
        { title: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
        { category: { name: { contains: search, mode: "insensitive" } } },
      ],
    });
  }

  return { AND: andConditions };
}

function urgencyRank(urgency: TaskUrgency): number {
  switch (urgency) {
    case TaskUrgency.CRITICAL:
      return 0;
    case TaskUrgency.HIGH:
      return 1;
    case TaskUrgency.MEDIUM:
      return 2;
    case TaskUrgency.LOW:
      return 3;
    default:
      return 4;
  }
}

function compareNullableDateAsc(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function compareNullableDateDesc(a: Date | null, b: Date | null): number {
  if (a && b) return b.getTime() - a.getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

function sortTasks(tasks: TaskWithRelations[], filters: TaskListFilters): TaskWithRelations[] {
  const now = Date.now();
  const sort = filters.sort ?? "default";

  return [...tasks].sort((a, b) => {
    if (filters.tab === "deleted") {
      return compareNullableDateDesc(a.deletedAt ?? null, b.deletedAt ?? null);
    }

    if (filters.tab === "cleanup") {
      return compareNullableDateAsc(a.deletedAt ?? null, b.deletedAt ?? null);
    }

    if (filters.tab === "completed") {
      if (sort === "createdAt") return b.createdAt.getTime() - a.createdAt.getTime();
      if (sort === "updatedAt") return b.updatedAt.getTime() - a.updatedAt.getTime();
      if (sort === "urgency") {
        return (
          urgencyRank(a.urgency) - urgencyRank(b.urgency) ||
          compareNullableDateDesc(a.completedAt ?? null, b.completedAt ?? null)
        );
      }
      if (sort === "dueAt") {
        return (
          compareNullableDateAsc(a.dueAt ?? null, b.dueAt ?? null) ||
          compareNullableDateDesc(a.completedAt ?? null, b.completedAt ?? null)
        );
      }

      return compareNullableDateDesc(a.completedAt ?? null, b.completedAt ?? null);
    }

    if (sort === "createdAt") {
      return b.createdAt.getTime() - a.createdAt.getTime();
    }

    if (sort === "updatedAt") {
      return b.updatedAt.getTime() - a.updatedAt.getTime();
    }

    if (sort === "urgency") {
      return (
        urgencyRank(a.urgency) - urgencyRank(b.urgency) ||
        compareNullableDateAsc(a.dueAt ?? null, b.dueAt ?? null) ||
        b.updatedAt.getTime() - a.updatedAt.getTime()
      );
    }

    if (sort === "dueAt") {
      return (
        compareNullableDateAsc(a.dueAt ?? null, b.dueAt ?? null) ||
        urgencyRank(a.urgency) - urgencyRank(b.urgency) ||
        b.updatedAt.getTime() - a.updatedAt.getTime()
      );
    }

    const aOverdue = a.dueAt != null && a.dueAt.getTime() < now;
    const bOverdue = b.dueAt != null && b.dueAt.getTime() < now;

    if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

    return (
      urgencyRank(a.urgency) - urgencyRank(b.urgency) ||
      compareNullableDateAsc(a.dueAt ?? null, b.dueAt ?? null) ||
      b.updatedAt.getTime() - a.updatedAt.getTime() ||
      b.createdAt.getTime() - a.createdAt.getTime()
    );
  });
}

function serializeTask(task: TaskWithRelations, viewer: AuthenticatedTaskUser) {
  const deletedUntil =
    task.deletedAt == null
      ? null
      : new Date(
          task.deletedAt.getTime() + TASK_RESTORE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
        );

  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    urgency: task.urgency,
    isSharedTeamTask: task.isSharedTeamTask,
    dueAt: task.dueAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString() ?? null,
    deletedAt: task.deletedAt?.toISOString() ?? null,
    deletedUntil: deletedUntil?.toISOString() ?? null,
    restoredAt: task.restoredAt?.toISOString() ?? null,
    category: {
      id: task.category.id,
      name: task.category.name,
      isActive: task.category.isActive,
      sortOrder: task.category.sortOrder,
    },
    createdBy: {
      id: task.createdBy.id,
      name: displayName(task.createdBy),
      email: task.createdBy.email,
      role: task.createdBy.role,
    },
    assignedTo: task.assignedTo
      ? {
          id: task.assignedTo.id,
          name: displayName(task.assignedTo),
          email: task.assignedTo.email,
          role: task.assignedTo.role,
        }
      : null,
    deletedBy: task.deletedBy
      ? {
          id: task.deletedBy.id,
          name: displayName(task.deletedBy),
          email: task.deletedBy.email,
          role: task.deletedBy.role,
        }
      : null,
    permissions: {
      canEdit: hasTaskEditPermission(task, viewer),
      canDelete: hasTaskEditPermission(task, viewer),
      canRestore:
        task.deletedAt != null &&
        hasRestorePermission(task, viewer) &&
        task.deletedAt.getTime() > restoreWindowCutoff().getTime(),
      canViewDeleted: task.deletedAt != null && hasDeletedVisibility(task, viewer),
    },
    activity: [...task.activities]
      .reverse()
      .map((entry) => ({
        id: entry.id,
        type: entry.type,
        details: entry.details,
        createdAt: entry.createdAt.toISOString(),
        actor: entry.actor
          ? {
              id: entry.actor.id,
              name: displayName(entry.actor),
              email: entry.actor.email,
              role: entry.actor.role,
            }
          : null,
      })),
  };
}

async function recordTaskActivity(
  tx: TaskActivityClient,
  input: {
    taskId: string;
    actorUserId: string;
    type: TaskActivityType;
    details?: Prisma.InputJsonValue;
  },
) {
  await tx.taskActivity.create({
    data: {
      taskId: input.taskId,
      actorUserId: input.actorUserId,
      type: input.type,
      details: input.details ?? {},
    },
  });
}

async function recordTaskAudit(
  tx: TaskActivityClient,
  input: {
    userId: string;
    action: string;
    entityType?: string;
    entityId?: string;
    details?: Prisma.InputJsonValue;
  },
) {
  await tx.auditLog.create({
    data: {
      userId: input.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      details: input.details ?? {},
    },
  });
}

async function ensureAssignableUser(userId: string | null | undefined) {
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true },
  });
  if (!user) {
    throw new TaskServiceError("Selected assignee was not found.", 400);
  }
  return user.id;
}

async function ensureUsableCategory(categoryId: string, existingCategoryId?: string) {
  const category = await db.taskCategory.findUnique({
    where: { id: categoryId },
    select: {
      id: true,
      name: true,
      isActive: true,
    },
  });

  if (!category) {
    throw new TaskServiceError("Selected category was not found.", 400);
  }

  if (!category.isActive && category.id !== existingCategoryId) {
    throw new TaskServiceError(
      "Disabled categories can stay on existing tasks, but cannot be assigned to new tasks.",
      400,
    );
  }

  return category;
}

async function getTaskForMutation(taskId: string) {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: taskInclude,
  });

  if (!task) {
    throw new TaskServiceError("Task not found.", 404);
  }

  return task;
}

function buildUpdatedTaskPayload(
  task: TaskWithRelations,
  input: UpdateTaskInput,
): {
  data: Prisma.TaskUpdateInput;
  changes: Array<{ field: string; from: string | null; to: string | null }>;
} {
  const data: Prisma.TaskUpdateInput = {};
  const changes: Array<{ field: string; from: string | null; to: string | null }> = [];

  if (input.title !== undefined) {
    const next = input.title.trim();
    if (!next) {
      throw new TaskServiceError("Task title is required.", 400);
    }
    if (next !== task.title) {
      data.title = next;
      changes.push({ field: "title", from: task.title, to: next });
    }
  }

  if (input.notes !== undefined) {
    const nextNotes = input.notes?.trim() ? input.notes : null;
    if ((task.notes ?? null) !== nextNotes) {
      data.notes = nextNotes;
      changes.push({ field: "notes", from: task.notes ?? null, to: nextNotes });
    }
  }

  if (input.status !== undefined && input.status !== task.status) {
    data.status = input.status;
    changes.push({ field: "status", from: task.status, to: input.status });

    if (input.status === TaskStatus.COMPLETED) {
      data.completedAt = new Date();
    } else if (task.status === TaskStatus.COMPLETED) {
      data.completedAt = null;
    }
  }

  if (input.urgency !== undefined && input.urgency !== task.urgency) {
    data.urgency = input.urgency;
    changes.push({ field: "urgency", from: task.urgency, to: input.urgency });
  }

  if (input.categoryId !== undefined && input.categoryId !== task.categoryId) {
    data.category = { connect: { id: input.categoryId } };
    changes.push({
      field: "categoryId",
      from: task.categoryId,
      to: input.categoryId,
    });
  }

  if (input.assignedToUserId !== undefined) {
    const nextAssigned = input.assignedToUserId ?? null;
    if ((task.assignedToUserId ?? null) !== nextAssigned) {
      data.assignedTo =
        nextAssigned == null ? { disconnect: true } : { connect: { id: nextAssigned } };
      changes.push({
        field: "assignedToUserId",
        from: task.assignedToUserId ?? null,
        to: nextAssigned,
      });
    }
  }

  if (
    input.isSharedTeamTask !== undefined &&
    input.isSharedTeamTask !== task.isSharedTeamTask
  ) {
    data.isSharedTeamTask = input.isSharedTeamTask;
    changes.push({
      field: "isSharedTeamTask",
      from: task.isSharedTeamTask ? "true" : "false",
      to: input.isSharedTeamTask ? "true" : "false",
    });
  }

  if (input.dueAt !== undefined) {
    const nextDueAt = input.dueAt ?? null;
    const currentDueAt = task.dueAt ?? null;
    const changed = currentDueAt?.getTime() !== nextDueAt?.getTime();

    if (changed) {
      data.dueAt = nextDueAt;
      changes.push({
        field: "dueAt",
        from: currentDueAt?.toISOString() ?? null,
        to: nextDueAt?.toISOString() ?? null,
      });
    }
  }

  return { data, changes };
}

export async function getTaskPageData(
  user: AuthenticatedTaskUser,
  filters: TaskListFilters,
) {
  const where = buildTaskFiltersWhere(filters, user);
  const openCountWhere = buildTabVisibilityWhere("open", user);
  const completedCountWhere = buildTabVisibilityWhere("completed", user);
  const deletedCountWhere = buildTabVisibilityWhere("deleted", user);
  const cleanupCountWhere = isAdmin(user)
    ? buildTabVisibilityWhere("cleanup", user)
    : null;

  const [tasks, categories, users, openCount, completedCount, deletedCount, cleanupCount] =
    await Promise.all([
      db.task.findMany({
        where,
        include: taskInclude,
      }),
      db.taskCategory.findMany({
        include: {
          _count: {
            select: {
              tasks: true,
            },
          },
        },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      db.user.findMany({
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
        },
        orderBy: [{ name: "asc" }, { email: "asc" }],
      }),
      db.task.count({ where: openCountWhere }),
      db.task.count({ where: completedCountWhere }),
      db.task.count({ where: deletedCountWhere }),
      cleanupCountWhere ? db.task.count({ where: cleanupCountWhere }) : Promise.resolve(0),
    ]);

  return {
    currentUser: {
      id: user.id,
      name: displayName(user),
      email: user.email ?? "",
      role: user.role,
    },
    canManageCategories: isAdmin(user),
    canCleanupDeleted: isAdmin(user),
    restoreWindowDays: TASK_RESTORE_WINDOW_DAYS,
    counts: {
      open: openCount,
      completed: completedCount,
      deleted: deletedCount,
      cleanup: cleanupCount,
    },
    tasks: sortTasks(tasks, filters).map((task) => serializeTask(task, user)),
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      sortOrder: category.sortOrder,
      isActive: category.isActive,
      taskCount: category._count.tasks,
    })),
    users: users.map((member) => ({
      id: member.id,
      name: displayName(member),
      email: member.email,
      role: member.role,
    })),
  };
}

export async function createTask(user: AuthenticatedTaskUser, input: CreateTaskInput) {
  const title = input.title.trim();
  if (!title) {
    throw new TaskServiceError("Task title is required.", 400);
  }

  await ensureUsableCategory(input.categoryId);
  const assignedToUserId = await ensureAssignableUser(input.assignedToUserId);
  const status = input.status ?? TaskStatus.OPEN;
  const urgency = input.urgency ?? TaskUrgency.MEDIUM;
  const completedAt = status === TaskStatus.COMPLETED ? new Date() : null;

  const created = await db.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        title,
        notes: input.notes?.trim() ? input.notes : null,
        status,
        urgency,
        categoryId: input.categoryId,
        createdByUserId: user.id,
        assignedToUserId,
        isSharedTeamTask: Boolean(input.isSharedTeamTask),
        dueAt: input.dueAt ?? null,
        completedAt,
      },
      include: taskInclude,
    });

    await recordTaskActivity(tx, {
      taskId: task.id,
      actorUserId: user.id,
      type: TaskActivityType.CREATED,
      details: {
        status: task.status,
        urgency: task.urgency,
        categoryId: task.categoryId,
        assignedToUserId: task.assignedToUserId,
        isSharedTeamTask: task.isSharedTeamTask,
        dueAt: task.dueAt?.toISOString() ?? null,
      },
    });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_created",
      entityType: "task",
      entityId: task.id,
      details: {
        title: task.title,
        status: task.status,
        urgency: task.urgency,
        categoryId: task.categoryId,
        assignedToUserId: task.assignedToUserId,
        isSharedTeamTask: task.isSharedTeamTask,
      },
    });

    return task;
  });

  return serializeTask(created, user);
}

export async function updateTask(
  taskId: string,
  user: AuthenticatedTaskUser,
  input: UpdateTaskInput,
) {
  const existing = await getTaskForMutation(taskId);
  requireTaskPermission(
    hasTaskEditPermission(existing, user),
    "You do not have permission to edit this task.",
  );
  requireTaskPermission(existing.deletedAt == null, "Deleted tasks cannot be edited.", 400);

  if (input.categoryId) {
    await ensureUsableCategory(input.categoryId, existing.categoryId);
  }
  if (input.assignedToUserId !== undefined) {
    await ensureAssignableUser(input.assignedToUserId);
  }

  const { data, changes } = buildUpdatedTaskPayload(existing, input);
  if (changes.length === 0) {
    return serializeTask(existing, user);
  }

  const updated = await db.$transaction(async (tx) => {
    const task = await tx.task.update({
      where: { id: taskId },
      data,
      include: taskInclude,
    });

    const statusChange = changes.find((change) => change.field === "status");
    const nonStatusChanges = changes.filter((change) => change.field !== "status");

    if (statusChange?.to === TaskStatus.COMPLETED) {
      await recordTaskActivity(tx, {
        taskId,
        actorUserId: user.id,
        type: TaskActivityType.COMPLETED,
        details: nonStatusChanges.length > 0 ? { changes: nonStatusChanges } : {},
      });
    } else if (statusChange && statusChange.from === TaskStatus.COMPLETED) {
      await recordTaskActivity(tx, {
        taskId,
        actorUserId: user.id,
        type: TaskActivityType.REOPENED,
        details: nonStatusChanges.length > 0 ? { changes: nonStatusChanges } : {},
      });
    }

    if (nonStatusChanges.length > 0 || !statusChange) {
      await recordTaskActivity(tx, {
        taskId,
        actorUserId: user.id,
        type: TaskActivityType.UPDATED,
        details: { changes: nonStatusChanges.length > 0 ? nonStatusChanges : changes },
      });
    }

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_updated",
      entityType: "task",
      entityId: taskId,
      details: { changes },
    });

    return task;
  });

  return serializeTask(updated, user);
}

export async function completeTask(taskId: string, user: AuthenticatedTaskUser) {
  const existing = await getTaskForMutation(taskId);
  requireTaskPermission(
    hasTaskEditPermission(existing, user),
    "You do not have permission to complete this task.",
  );
  requireTaskPermission(existing.deletedAt == null, "Deleted tasks cannot be completed.", 400);

  if (existing.status === TaskStatus.COMPLETED) {
    return serializeTask(existing, user);
  }

  const completed = await db.$transaction(async (tx) => {
    const now = new Date();
    const task = await tx.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.COMPLETED,
        completedAt: now,
      },
      include: taskInclude,
    });

    await recordTaskActivity(tx, {
      taskId,
      actorUserId: user.id,
      type: TaskActivityType.COMPLETED,
      details: {},
    });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_completed",
      entityType: "task",
      entityId: taskId,
      details: {},
    });

    return task;
  });

  return serializeTask(completed, user);
}

export async function reopenTask(taskId: string, user: AuthenticatedTaskUser) {
  const existing = await getTaskForMutation(taskId);
  requireTaskPermission(
    hasTaskEditPermission(existing, user),
    "You do not have permission to reopen this task.",
  );
  requireTaskPermission(existing.deletedAt == null, "Deleted tasks cannot be reopened.", 400);

  if (existing.status !== TaskStatus.COMPLETED) {
    return serializeTask(existing, user);
  }

  const reopened = await db.$transaction(async (tx) => {
    const task = await tx.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.OPEN,
        completedAt: null,
      },
      include: taskInclude,
    });

    await recordTaskActivity(tx, {
      taskId,
      actorUserId: user.id,
      type: TaskActivityType.REOPENED,
      details: {},
    });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_reopened",
      entityType: "task",
      entityId: taskId,
      details: {},
    });

    return task;
  });

  return serializeTask(reopened, user);
}

export async function softDeleteTask(taskId: string, user: AuthenticatedTaskUser) {
  const existing = await getTaskForMutation(taskId);
  requireTaskPermission(
    hasTaskEditPermission(existing, user),
    "You do not have permission to delete this task.",
  );

  if (existing.deletedAt) {
    return serializeTask(existing, user);
  }

  const deleted = await db.$transaction(async (tx) => {
    const now = new Date();
    const task = await tx.task.update({
      where: { id: taskId },
      data: {
        deletedAt: now,
        deletedByUserId: user.id,
      },
      include: taskInclude,
    });

    await recordTaskActivity(tx, {
      taskId,
      actorUserId: user.id,
      type: TaskActivityType.DELETED,
      details: {},
    });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_deleted",
      entityType: "task",
      entityId: taskId,
      details: {},
    });

    return task;
  });

  return serializeTask(deleted, user);
}

export async function restoreTask(taskId: string, user: AuthenticatedTaskUser) {
  const existing = await getTaskForMutation(taskId);
  requireTaskPermission(existing.deletedAt != null, "Task is not deleted.", 400);
  const deletedAt = existing.deletedAt;
  if (!deletedAt) {
    throw new TaskServiceError("Task is not deleted.", 400);
  }
  requireTaskPermission(
    hasRestorePermission(existing, user),
    "You do not have permission to restore this task.",
  );
  requireTaskPermission(
    deletedAt.getTime() > restoreWindowCutoff().getTime(),
    "This task is past the 30-day restore window.",
    400,
  );

  const restored = await db.$transaction(async (tx) => {
    const now = new Date();
    const task = await tx.task.update({
      where: { id: taskId },
      data: {
        deletedAt: null,
        deletedByUserId: null,
        restoredAt: now,
      },
      include: taskInclude,
    });

    await recordTaskActivity(tx, {
      taskId,
      actorUserId: user.id,
      type: TaskActivityType.RESTORED,
      details: {},
    });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_restored",
      entityType: "task",
      entityId: taskId,
      details: {},
    });

    return task;
  });

  return serializeTask(restored, user);
}

export async function permanentlyDeleteTasks(
  taskIds: string[],
  user: AuthenticatedTaskUser,
) {
  requireTaskPermission(
    isAdmin(user),
    "Only admins can permanently delete expired tasks.",
  );

  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) {
    throw new TaskServiceError("Select at least one task to permanently delete.", 400);
  }

  const eligible = await db.task.findMany({
    where: {
      id: { in: ids },
      deletedAt: { lte: restoreWindowCutoff() },
    },
    select: {
      id: true,
      title: true,
    },
  });

  if (eligible.length === 0) {
    throw new TaskServiceError("No selected tasks are eligible for permanent deletion.", 400);
  }

  await db.$transaction(async (tx) => {
    await tx.task.deleteMany({
      where: {
        id: { in: eligible.map((task) => task.id) },
      },
    });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_permanently_deleted",
      entityType: "task",
      details: {
        taskIds: eligible.map((task) => task.id),
        taskTitles: eligible.map((task) => task.title),
      },
    });
  });

  return {
    deletedCount: eligible.length,
    deletedIds: eligible.map((task) => task.id),
  };
}

export async function createTaskCategory(
  user: AuthenticatedTaskUser,
  input: { name: string },
) {
  requireTaskPermission(isAdmin(user), "Only admins can create task categories.");

  const name = input.name.trim();
  if (!name) {
    throw new TaskServiceError("Category name is required.", 400);
  }

  const slug = slugifyTaskCategoryName(name);
  if (!slug) {
    throw new TaskServiceError("Category name must include letters or numbers.", 400);
  }

  const existing = await db.taskCategory.findUnique({ where: { slug } });
  if (existing) {
    throw new TaskServiceError("A category with that name already exists.", 409);
  }

  const created = await db.$transaction(async (tx) => {
    const last = await tx.taskCategory.findFirst({
      orderBy: [{ sortOrder: "desc" }],
      select: { sortOrder: true },
    });

    const category = await tx.taskCategory.create({
      data: {
        name,
        slug,
        sortOrder: (last?.sortOrder ?? -1) + 1,
        isActive: true,
      },
    });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_category_created",
      entityType: "task_category",
      entityId: category.id,
      details: {
        name: category.name,
        slug: category.slug,
      },
    });

    return category;
  });

  return created;
}

async function normalizeCategorySortOrder(
  tx: TaskCategoryClient,
  orderedIds: string[],
) {
  await Promise.all(
    orderedIds.map((id, index) =>
      tx.taskCategory.update({
        where: { id },
        data: { sortOrder: index },
      }),
    ),
  );
}

export async function updateTaskCategory(
  categoryId: string,
  user: AuthenticatedTaskUser,
  input: {
    name?: string;
    isActive?: boolean;
    positionIndex?: number;
  },
) {
  requireTaskPermission(isAdmin(user), "Only admins can manage task categories.");

  const category = await db.taskCategory.findUnique({
    where: { id: categoryId },
  });
  if (!category) {
    throw new TaskServiceError("Category not found.", 404);
  }

  const updates: Prisma.TaskCategoryUpdateInput = {};
  const details: Record<string, Prisma.InputJsonValue> = {};

  if (input.name !== undefined) {
    const nextName = input.name.trim();
    if (!nextName) {
      throw new TaskServiceError("Category name is required.", 400);
    }

    const nextSlug = slugifyTaskCategoryName(nextName);
    if (!nextSlug) {
      throw new TaskServiceError("Category name must include letters or numbers.", 400);
    }

    const conflict = await db.taskCategory.findFirst({
      where: {
        id: { not: categoryId },
        slug: nextSlug,
      },
      select: { id: true },
    });
    if (conflict) {
      throw new TaskServiceError("A category with that name already exists.", 409);
    }

    if (nextName !== category.name) {
      updates.name = nextName;
      updates.slug = nextSlug;
      details.name = { from: category.name, to: nextName };
    }
  }

  if (input.isActive !== undefined && input.isActive !== category.isActive) {
    updates.isActive = input.isActive;
    details.isActive = { from: category.isActive, to: input.isActive };
  }

  const updated = await db.$transaction(async (tx) => {
    if (input.positionIndex !== undefined) {
      const categories = await tx.taskCategory.findMany({
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true },
      });
      const currentIndex = categories.findIndex((entry) => entry.id === categoryId);
      const targetIndex = Math.max(
        0,
        Math.min(input.positionIndex, categories.length - 1),
      );

      if (currentIndex !== -1 && currentIndex !== targetIndex) {
        const reordered = [...categories];
        const [moved] = reordered.splice(currentIndex, 1);
        reordered.splice(targetIndex, 0, moved);
        await normalizeCategorySortOrder(
          tx,
          reordered.map((entry) => entry.id),
        );
        details.positionIndex = { from: currentIndex, to: targetIndex };
      }
    }

    const nextCategory =
      Object.keys(updates).length > 0
        ? await tx.taskCategory.update({
            where: { id: categoryId },
            data: updates,
          })
        : await tx.taskCategory.findUniqueOrThrow({
            where: { id: categoryId },
          });

    await recordTaskAudit(tx, {
      userId: user.id,
      action: "task_category_updated",
      entityType: "task_category",
      entityId: categoryId,
      details: details as Prisma.InputJsonValue,
    });

    return nextCategory;
  });

  return updated;
}
