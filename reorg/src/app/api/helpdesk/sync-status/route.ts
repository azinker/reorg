import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { helpdeskFlagsSnapshot } from "@/lib/helpdesk/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [checkpoints, lastTickAt, lastOutcome, lastSummary] = await Promise.all([
    db.helpdeskSyncCheckpoint.findMany({
      orderBy: { updatedAt: "desc" },
    }),
    db.appSetting.findUnique({ where: { key: "helpdesk_poll_last_tick_at" } }),
    db.appSetting.findUnique({ where: { key: "helpdesk_poll_last_outcome" } }),
    db.appSetting.findUnique({ where: { key: "helpdesk_poll_last_summary" } }),
  ]);

  const integrationIds = Array.from(new Set(checkpoints.map((c) => c.integrationId)));
  const integrations = integrationIds.length
    ? await db.integration.findMany({
        where: { id: { in: integrationIds } },
        select: { id: true, label: true, platform: true, enabled: true },
      })
    : [];
  const integrationMap = new Map(integrations.map((i) => [i.id, i]));

  return NextResponse.json({
    data: {
      flags: helpdeskFlagsSnapshot(),
      lastTickAt: (lastTickAt?.value as string | undefined) ?? null,
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
