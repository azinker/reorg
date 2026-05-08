import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const APP_SETTINGS_KEY = "appSettings";
const ADMIN_SETTING_KEYS = new Set([
  "global_write_lock",
  "live_push_enabled",
  "helpdesk_safe_mode",
]);
const ADMIN_APP_SETTING_FIELDS = [
  "globalWriteLock",
  "livePushEnabled",
  "helpdeskSafeMode",
] as const;

const putSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripAdminAppSettingFields(value: unknown) {
  if (!isRecord(value)) return value;
  const nextValue = { ...value };
  for (const field of ADMIN_APP_SETTING_FIELDS) {
    delete nextValue[field];
  }
  return nextValue;
}

export async function GET(request: NextRequest) {
  try {
    const session = await auth();
    const isAdmin = session?.user?.role === "ADMIN";
    const key = request.nextUrl.searchParams.get("key");

    if (key) {
      if (!isAdmin && ADMIN_SETTING_KEYS.has(key)) {
        return NextResponse.json(
          { error: "Only admins can view safety controls." },
          { status: 403 },
        );
      }
      const setting = await db.appSetting.findUnique({ where: { key } });
      if (!isAdmin && key === APP_SETTINGS_KEY) {
        return NextResponse.json({
          data: setting ? stripAdminAppSettingFields(setting.value) : null,
        });
      }
      return NextResponse.json({ data: setting ? setting.value : null });
    }

    const all = await db.appSetting.findMany();
    const map: Record<string, unknown> = {};
    for (const s of all) {
      if (!isAdmin && ADMIN_SETTING_KEYS.has(s.key)) continue;
      map[s.key] =
        !isAdmin && s.key === APP_SETTINGS_KEY
          ? stripAdminAppSettingFields(s.value)
          : s.value;
    }
    return NextResponse.json({ data: map });
  } catch (error) {
    console.error("[settings] Failed to fetch", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = putSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { key } = parsed.data;
    let { value } = parsed.data;
    const isAdmin = session.user.role === "ADMIN";

    if (!isAdmin && ADMIN_SETTING_KEYS.has(key)) {
      return NextResponse.json(
        { error: "Only admins can update safety controls." },
        { status: 403 },
      );
    }

    if (!isAdmin && key === APP_SETTINGS_KEY && isRecord(value)) {
      const existing = await db.appSetting.findUnique({ where: { key } });
      const existingValue = isRecord(existing?.value) ? existing.value : {};
      const nextValue = { ...value };
      for (const field of ADMIN_APP_SETTING_FIELDS) {
        if (field in existingValue) {
          nextValue[field] = existingValue[field];
        } else {
          delete nextValue[field];
        }
      }
      value = nextValue;
    }

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
