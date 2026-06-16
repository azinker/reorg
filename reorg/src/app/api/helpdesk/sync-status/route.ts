import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { helpdeskFlagsSnapshotAsync } from "@/lib/helpdesk/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function newestIsoDate(values: Array<Date | string | null | undefined>): string | null {
  let newest: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!newest || date > newest) newest = date;
  }
  return newest?.toISOString() ?? null;
}

export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [checkpoints, lastTickAt, lastOutcome, lastSummary, flags] = await Promise.all([
    db.helpdeskSyncCheckpoint.findMany({
      orderBy: { updatedAt: "desc" },
    }),
    db.appSetting.findUnique({ where: { key: "helpdesk_poll_last_tick_at" } }),
    db.appSetting.findUnique({ where: { key: "helpdesk_poll_last_outcome" } }),
    db.appSetting.findUnique({ where: { key: "helpdesk_poll_last_summary" } }),
    helpdeskFlagsSnapshotAsync(),
  ]);

  const integrationIds = Array.from(new Set(checkpoints.map((c) => c.integrationId)));
  const integrations = integrationIds.length
    ? await db.integration.findMany({
        where: { id: { in: integrationIds } },
        select: { id: true, label: true, platform: true, enabled: true },
      })
    : [];
  const integrationMap = new Map(integrations.map((i) => [i.id, i]));

  // Surface the *actual* backfill window so the header badge shows the
  // real value (2 / 7 / 60 days etc.) instead of a hardcoded string. This
  // reads the same env var the sync uses (HELPDESK_BACKFILL_DAYS), with
  // a 60-day default to match the sync's fallback.
  const backfillDays = Number.parseInt(
    process.env.HELPDESK_BACKFILL_DAYS ?? "60",
    10,
  ) || 60;
  const lastCheckpointActivityAt = newestIsoDate(
    checkpoints.flatMap((c) => [c.updatedAt, c.lastFullSyncAt]),
  );
  const effectiveLastTickAt =
    newestIsoDate([
      (lastTickAt?.value as string | undefined) ?? null,
      lastCheckpointActivityAt,
    ]) ?? null;

  return NextResponse.json({
    data: {
      flags,
      backfillDays,
      // The poll-status app_setting is useful for summaries, but a deploy or
      // alternate worker can leave it stale while checkpoints continue moving.
      // The header should reflect the newest confirmed Help Desk sync activity.
      lastTickAt: effectiveLastTickAt,
      lastOutcome: (lastOutcome?.value as string | undefined) ?? null,
      lastSummary: lastSummary?.value ?? null,
      checkpoints: checkpoints.map((c) => ({
        integrationId: c.integrationId,
        integrationLabel: integrationMap.get(c.integrationId)?.label ?? null,
        platform: integrationMap.get(c.integrationId)?.platform ?? null,
        folder: c.folder,
        lastWatermark: c.lastWatermark,
        lastFullSyncAt: c.lastFullSyncAt,
        backfillCursor: c.backfillCursor,
        backfillDone: c.backfillDone,
        updatedAt: c.updatedAt,
      })),
    },
  });
}
