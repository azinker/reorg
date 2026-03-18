import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { updateManagedUserProfile } from "@/lib/services/user-admin";

const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  password: z.string().min(8).max(200).optional(),
});

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = updateMeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (!parsed.data.name && !parsed.data.password) {
      return NextResponse.json(
        { error: "Nothing to update." },
        { status: 400 },
      );
    }

    const updated = await updateManagedUserProfile({
      userId: session.user.id,
      name: parsed.data.name,
      password: parsed.data.password,
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("[users/me] Failed to update current user", error);
    return NextResponse.json(
      { error: "Failed to update user profile" },
      { status: 500 },
    );
  }
}
