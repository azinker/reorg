import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { ONBOARDING_PAGES, onboardingFlagKey, type OnboardingPageKey } from "@/lib/onboarding-pages";

const ONBOARDING_KEY_PREFIX = "onboarding:";

function keyForUser(userId: string) {
  return `${ONBOARDING_KEY_PREFIX}${userId}`;
}

const pageEnum = z.enum(ONBOARDING_PAGES);
const putSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete"), page: pageEnum }),
  z.object({ action: z.literal("reset"), page: pageEnum }),
  z.object({ action: z.literal("reset_all") }),
]);

type OnboardingState = Partial<Record<`${OnboardingPageKey}TourSeen`, boolean>>;

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ data: null, useLocalFallback: true });
    }

    const row = await db.appSetting.findUnique({
      where: { key: keyForUser(session.user.id) },
    });

    const value = (row?.value as OnboardingState | null) ?? null;
    const normalized: OnboardingState = {};
    for (const p of ONBOARDING_PAGES) {
      const key = onboardingFlagKey(p) as `${OnboardingPageKey}TourSeen`;
      normalized[key] = Boolean(value?.[key]);
    }
    return NextResponse.json({
      data: normalized,
      useLocalFallback: false,
    });
  } catch (error) {
    console.error("[onboarding] GET failed", error);
    return NextResponse.json({ error: "Failed to load onboarding state" }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const key = keyForUser(session.user.id);
    const existing = await db.appSetting.findUnique({ where: { key } });
    const prev = (existing?.value as OnboardingState | null) ?? {};
    const next: OnboardingState = { ...prev };
    if (parsed.data.action === "reset_all") {
      for (const p of ONBOARDING_PAGES) {
        const key = onboardingFlagKey(p) as `${OnboardingPageKey}TourSeen`;
        next[key] = false;
      }
    } else {
      const key = onboardingFlagKey(parsed.data.page) as `${OnboardingPageKey}TourSeen`;
      next[key] = parsed.data.action === "complete";
    }

    await db.appSetting.upsert({
      where: { key },
      create: { key, value: next as never },
      update: { value: next as never },
    });

    return NextResponse.json({ data: next });
  } catch (error) {
    console.error("[onboarding] PUT failed", error);
    return NextResponse.json({ error: "Failed to update onboarding state" }, { status: 500 });
  }
}
