import { NextResponse, type NextRequest } from "next/server";
import { getRequiredSessionUser } from "@/lib/server-auth";
import {
  createTaskCategory,
  TaskServiceError,
} from "@/lib/services/tasks";
import { z } from "zod";

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

function handleTaskError(error: unknown, scope: string) {
  if (error instanceof TaskServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  console.error(scope, error);
  return NextResponse.json({ error: "Category request failed" }, { status: 500 });
}

export async function POST(request: NextRequest) {
  const user = await getRequiredSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = createCategorySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const data = await createTaskCategory(user, parsed.data);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    return handleTaskError(error, "[tasks/categories] POST failed");
  }
}
