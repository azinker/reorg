import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import {
  getNetworkTransferSeries,
  getTopCostDrivers,
  getTotalsByChannel,
  listNetworkTransferSamples,
  NETWORK_TRANSFER_RETENTION_DAYS,
  parseNetworkTransferQuery,
  pivotNetworkTransferSeries,
  rollUpAndPruneSamples,
} from "@/lib/services/network-transfer-samples";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { rolledUp, pruned } = await rollUpAndPruneSamples();
    const sp = request.nextUrl.searchParams;
    const { from, to, bucket, channelFilter } = parseNetworkTransferQuery(sp);
    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);

    const [seriesRows, totalsByChannel, listResult, topCostDrivers] = await Promise.all([
      getNetworkTransferSeries({ from, to, bucket, channel: channelFilter }),
      getTotalsByChannel({ from, to, channel: channelFilter }),
      listNetworkTransferSamples({
        from,
        to,
        limit: 50,
        page,
        channel: channelFilter,
      }),
      getTopCostDrivers({ from, to, limit: 25 }),
    ]);

    const chartSeries = pivotNetworkTransferSeries(seriesRows);

    return NextResponse.json({
      data: {
        retentionDays: NETWORK_TRANSFER_RETENTION_DAYS,
        prunedCount: pruned,
        rolledUpCount: rolledUp,
        range: { from: from.toISOString(), to: to.toISOString(), bucket },
        chartSeries,
        seriesRows: seriesRows.map((r) => ({
          bucketStart: r.bucketStart,
          channel: r.channel,
          eventCount: r.eventCount,
          bytesSum: Number(r.bytesSum),
        })),
        totalsByChannel,
        topCostDrivers,
        samples: listResult.items.map((s) => ({
          id: s.id,
          createdAt: s.createdAt.toISOString(),
          channel: s.channel,
          label: s.label,
          bytesEstimate: s.bytesEstimate,
          durationMs: s.durationMs,
          metadata: s.metadata,
          integration: s.integration
            ? { id: s.integration.id, platform: s.integration.platform, label: s.integration.label }
            : null,
        })),
        pagination: {
          page: listResult.page,
          totalPages: listResult.totalPages,
        },
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load network transfer data";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
