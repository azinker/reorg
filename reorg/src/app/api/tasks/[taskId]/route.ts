import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { TaskStatus, TaskUrgency } from "@prisma/client";
import { getRequiredSessionUser } from "@/lib/server-auth";
import {
  completeTask,
  reopenTask,
  restoreTask,
  softDeleteTask,
  TaskServiceError,
  updateTask,
} from "@/lib/services/tasks";

const updateSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    title: z.string().trim().min(1).max(200).optional(),
    notes: z.string().max(5000).nullable().optional(),
    status: z.enum(TaskStatus).optional(),
    urgency: z.enum(TaskUrgency).optional(),
    categoryId: z.string().trim().min(1).max(191).optional(),
    assignedToUserId: z.string().trim().max(191).nullable().optional(),
    isSharedTeamTask: z.boolean().optional(),
    dueAt: z.string().datetime().nullable().optional(),
  }),
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("reopen") }),
  z.object({ action: z.literal("delete") }),
  z.object({ action: z.literal("restore") }),
]);

function handleTaskError(error: unknown, scope: string) {
  if (error instanceof TaskServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Task request failed" }, { status: 500 });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { taskId } = await context.params;
    const body = await request.json();
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data =
      parsed.data.action === "update"
        ? await updateTask(taskId, user, {
            title: parsed.data.title,
            notes: parsed.data.notes,
            status: parsed.data.status,
            urgency: parsed.data.urgency,
            categoryId: parsed.data.categoryId,
            assignedToUserId: parsed.data.assignedToUserId,
            isSharedTeamTask: parsed.data.isSharedTeamTask,
            dueAt:
              parsed.data.dueAt === undefined
                ? undefined
                : parsed.data.dueAt
                  ? new Date(parsed.data.dueAt)
                  : null,
          })
        : parsed.data.action === "complete"
          ? await completeTask(taskId, user)
          : parsed.data.action === "reopen"
            ? await reopenTask(taskId, user)
            : parsed.data.action === "delete"
              ? await softDeleteTask(taskId, user)
              : await restoreTask(taskId, user);

    return NextResponse.json({ data });
  } catch (error) {
    return handleTaskError(error, "[tasks/:taskId] PATCH failed");
  }
}
