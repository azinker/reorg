import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getRequiredSessionUser } from "@/lib/server-auth";
import {
  TaskServiceError,
  updateTaskCategory,
} from "@/lib/services/tasks";

const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isActive: z.boolean().optional(),
  positionIndex: z.number().int().min(0).optional(),
});

function handleTaskError(error: unknown, scope: string) {
  if (error instanceof TaskServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Category request failed" }, { status: 500 });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ categoryId: string }> },
) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { categoryId } = await context.params;
    const body = await request.json();
    const parsed = updateCategorySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await updateTaskCategory(categoryId, user, parsed.data);
    return NextResponse.json({ data });
  } catch (error) {
    return handleTaskError(error, "[tasks/categories/:categoryId] PATCH failed");
  }
}
