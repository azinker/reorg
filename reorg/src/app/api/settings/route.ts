import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const putSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

export async function GET(request: NextRequest) {
  try {
    const key = request.nextUrl.searchParams.get("key");

    if (key) {
      const setting = await db.appSetting.findUnique({ where: { key } });
      return NextResponse.json({ data: setting ? setting.value : null });
    }

    const all = await db.appSetting.findMany();
    const map: Record<string, unknown> = {};
    for (const s of all) map[s.key] = s.value;
    return NextResponse.json({ data: map });
  } catch (error) {
    console.error("[settings] Failed to fetch", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = putSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { key, value } = parsed.data;

    await db.appSetting.upsert({
      where: { key },
      create: { key, value: value as never },
      update: { value: value as never },
    });

    return NextResponse.json({ data: { key, value } });
  } catch (error) {
    console.error("[settings] Failed to update", error);
    return NextResponse.json({ error: "Failed to update setting" }, { status: 500 });
  }
}
