import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { TaskStatus, TaskUrgency } from "@prisma/client";
import { getRequiredSessionUser } from "@/lib/server-auth";
import {
  createTask,
  getTaskPageData,
  TaskServiceError,
} from "@/lib/services/tasks";
import {
  TASK_DUE_FILTER_VALUES,
  TASK_SORT_VALUES,
  TASK_TAB_VALUES,
} from "@/lib/tasks";

const listQuerySchema = z.object({
  tab: z.enum(TASK_TAB_VALUES).default("open"),
  search: z.string().trim().max(200).optional(),
  status: z.union([z.enum(TaskStatus), z.literal("all")]).default("all"),
  urgency: z.union([z.enum(TaskUrgency), z.literal("all")]).default("all"),
  assigneeId: z.string().trim().max(191).optional(),
  due: z.enum(TASK_DUE_FILTER_VALUES).default("all"),
  categoryId: z.string().trim().max(191).optional(),
  sort: z.enum(TASK_SORT_VALUES).default("default"),
});

const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(5000).nullable().optional(),
  status: z.enum(TaskStatus).optional(),
  urgency: z.enum(TaskUrgency).optional(),
  categoryId: z.string().trim().min(1).max(191),
  assignedToUserId: z.string().trim().max(191).nullable().optional(),
  isSharedTeamTask: z.boolean().optional(),
  dueAt: z.string().datetime().nullable().optional(),
});

function handleTaskError(error: unknown, scope: string) {
  if (error instanceof TaskServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Task request failed" }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const parsed = listQuerySchema.safeParse({
      tab: request.nextUrl.searchParams.get("tab") ?? undefined,
      search: request.nextUrl.searchParams.get("search") ?? undefined,
      status: request.nextUrl.searchParams.get("status") ?? undefined,
      urgency: request.nextUrl.searchParams.get("urgency") ?? undefined,
      assigneeId: request.nextUrl.searchParams.get("assigneeId") ?? undefined,
      due: request.nextUrl.searchParams.get("due") ?? undefined,
      categoryId: request.nextUrl.searchParams.get("categoryId") ?? undefined,
      sort: request.nextUrl.searchParams.get("sort") ?? undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await getTaskPageData(user, parsed.data);
    return NextResponse.json({ data });
  } catch (error) {
    return handleTaskError(error, "[tasks] GET failed");
  }
}

export async function POST(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = createTaskSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await createTask(user, {
      ...parsed.data,
      dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
    });

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleTaskError(error, "[tasks] POST failed");
  }
}
