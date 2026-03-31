import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import {
  permanentlyDeleteTasks,
  TaskServiceError,
} from "@/lib/services/tasks";

const cleanupSchema = z.object({
  taskIds: z.array(z.string().trim().min(1)).min(1).max(100),
});

function handleTaskError(error: unknown, scope: string) {
  if (error instanceof TaskServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Cleanup request failed" }, { status: 500 });
}

export async function POST(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = cleanupSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await permanentlyDeleteTasks(parsed.data.taskIds, user);
    return NextResponse.json({ data });
  } catch (error) {
    return handleTaskError(error, "[tasks/cleanup] POST failed");
  }
}
