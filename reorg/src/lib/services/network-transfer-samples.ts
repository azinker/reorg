import { db } from "@/lib/db";
import {
  buildNetworkTransferRouteLabel,
  getNetworkTransferChannelForApiPath,
  NETWORK_TRANSFER_REQUEST_METHOD_HEADER,
  NETWORK_TRANSFER_REQUEST_PATH_HEADER,
  NETWORK_TRANSFER_REQUEST_START_HEADER,
} from "@/lib/network-transfer-request";
import { headers } from "next/headers";
import { Prisma, type NetworkTransferChannel } from "@prisma/client";
import { z } from "zod";

/** Align with audit log retention guidance (~10 days). */
export const NETWORK_TRANSFER_RETENTION_DAYS = 10;

export type RecordNetworkTransferSampleInput = {
  channel: NetworkTransferChannel;
  label: string;
  bytesEstimate?: number | null;
  durationMs?: number | null;
  metadata?: Record<string, unknown>;
  integrationId?: string | null;
};

export async function recordNetworkTransferSample(
  input: RecordNetworkTransferSampleInput,
): Promise<void> {
  try {
    await db.networkTransferSample.create({
      data: {
        channel: input.channel,
        label: input.label.slice(0, 500),
        bytesEstimate:
          input.bytesEstimate != null && Number.isFinite(input.bytesEstimate)
            ? Math.min(Math.floor(input.bytesEstimate), 2_147_483_647)
            : null,
        durationMs:
          input.durationMs != null && Number.isFinite(input.durationMs)
            ? Math.min(Math.floor(input.durationMs), 2_147_483_647)
            : null,
        metadata: sanitizeMetadata(input.metadata ?? {}) as Prisma.InputJsonValue,
        integrationId: input.integrationId?.trim() || null,
      },
    });
  } catch (err) {
    console.error("[network-transfer-samples] record failed", err);
  }
}

function sanitizeMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null || typeof v === "boolean" || typeof v === "number") {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      out[k] = v.length > 400 ? `${v.slice(0, 400)}...` : v;
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.slice(0, 20);
      continue;
    }
    if (typeof v === "object") {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > 500 ? `${s.slice(0, 500)}...` : (JSON.parse(s) as unknown);
      } catch {
        out[k] = "[object]";
      }
    }
  }
  return out;
}

export function estimateJsonBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}

type CurrentRequestTransferContext = {
  method: string;
  pathname: string;
  routeLabel: string;
  durationMs: number | null;
};

async function getCurrentRequestTransferContext(): Promise<CurrentRequestTransferContext | null> {
  try {
    const requestHeaders = await headers();
    const method = requestHeaders.get(NETWORK_TRANSFER_REQUEST_METHOD_HEADER)?.trim() ?? "";
    const pathname = requestHeaders.get(NETWORK_TRANSFER_REQUEST_PATH_HEADER)?.trim() ?? "";
    if (!pathname.startsWith("/api/")) {
      return null;
    }

    const startedAtRaw = Number(requestHeaders.get(NETWORK_TRANSFER_REQUEST_START_HEADER));
    const durationMs =
      Number.isFinite(startedAtRaw) && startedAtRaw > 0
        ? Math.max(0, Date.now() - startedAtRaw)
        : null;

    return {
      method: method || "GET",
      pathname,
      routeLabel: buildNetworkTransferRouteLabel(method || "GET", pathname),
      durationMs,
    };
  } catch {
    return null;
  }
}

export function queueCurrentRequestJsonResponseSample(input: {
  body: unknown;
  status: number;
  metadata?: Record<string, unknown>;
  integrationId?: string | null;
}): void {
  void (async () => {
    const context = await getCurrentRequestTransferContext();
    if (!context) return;

    await recordNetworkTransferSample({
      channel: getNetworkTransferChannelForApiPath(context.pathname),
      label: context.routeLabel,
      bytesEstimate: estimateJsonBytes(input.body),
      durationMs: context.durationMs,
      integrationId: input.integrationId ?? null,
      metadata: {
        route: context.routeLabel,
        method: context.method,
        pathname: context.pathname,
        status: input.status,
        responseType: "json",
        autoCaptured: true,
        ...input.metadata,
      },
    });
  })();
}

export function queueCurrentRequestBinaryResponseSample(input: {
  bytesEstimate: number;
  metadata?: Record<string, unknown>;
  integrationId?: string | null;
  channel?: NetworkTransferChannel;
  label?: string;
}): void {
  void (async () => {
    const context = await getCurrentRequestTransferContext();
    if (!context) return;

    await recordNetworkTransferSample({
      channel: input.channel ?? getNetworkTransferChannelForApiPath(context.pathname),
      label: input.label ?? context.routeLabel,
      bytesEstimate: input.bytesEstimate,
      durationMs: context.durationMs,
      integrationId: input.integrationId ?? null,
      metadata: {
        route: context.routeLabel,
        method: context.method,
        pathname: context.pathname,
        responseType: "binary",
        autoCaptured: true,
        ...input.metadata,
      },
    });
  })();
}

export async function pruneOldNetworkTransferSamples(): Promise<number> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - NETWORK_TRANSFER_RETENTION_DAYS);
  const result = await db.networkTransferSample.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return result.count;
}

const bucketSchema = z.enum(["hour", "day"]);

export type NetworkTransferSeriesBucket = z.infer<typeof bucketSchema>;

export type SeriesRow = {
  bucketStart: string;
  channel: NetworkTransferChannel;
  eventCount: number;
  bytesSum: bigint;
};

const ALL_CHANNELS: NetworkTransferChannel[] = [
  "CLIENT_API_RESPONSE",
  "MARKETPLACE_INBOUND",
  "SYNC_JOB",
  "FORECAST",
  "OTHER",
];

/** Pivot flat series rows into Recharts-friendly points (one key per channel + total). */
export function pivotNetworkTransferSeries(rows: SeriesRow[]): Record<string, string | number>[] {
  const byBucket = new Map<
    string,
    { bucketStart: string; totalBytes: number; counts: Record<string, number> }
  >();
  for (const r of rows) {
    const k = r.bucketStart;
    let slot = byBucket.get(k);
    if (!slot) {
      slot = {
        bucketStart: k,
        totalBytes: 0,
        counts: {},
      };
      byBucket.set(k, slot);
    }
    const bytes = Number(r.bytesSum);
    slot.totalBytes += bytes;
    slot.counts[r.channel] = (slot.counts[r.channel] ?? 0) + bytes;
  }
  const sorted = [...byBucket.keys()].sort();
  return sorted.map((key) => {
    const slot = byBucket.get(key)!;
    const point: Record<string, string | number> = {
      bucketStart: slot.bucketStart,
      totalBytes: slot.totalBytes,
    };
    for (const ch of ALL_CHANNELS) {
      point[ch] = slot.counts[ch] ?? 0;
    }
    return point;
  });
}

export async function getNetworkTransferSeries(params: {
  from: Date;
  to: Date;
  bucket: NetworkTransferSeriesBucket;
  channel?: NetworkTransferChannel | null;
}): Promise<SeriesRow[]> {
  type Row = {
    bucket_start: Date;
    channel: NetworkTransferChannel;
    event_count: bigint;
    bytes_sum: bigint;
  };
  const channelFilter = params.channel
    ? Prisma.sql`AND "channel" = ${params.channel}`
    : Prisma.empty;
  const rows =
    params.bucket === "hour"
      ? await db.$queryRaw<Row[]>`
          SELECT
            date_trunc('hour', "createdAt") AS bucket_start,
            "channel",
            COUNT(*)::bigint AS event_count,
            COALESCE(SUM("bytesEstimate"), 0)::bigint AS bytes_sum
          FROM network_transfer_samples
          WHERE "createdAt" >= ${params.from} AND "createdAt" <= ${params.to}
          ${channelFilter}
          GROUP BY 1, 2
          ORDER BY 1 ASC, 2 ASC
        `
      : await db.$queryRaw<Row[]>`
          SELECT
            date_trunc('day', "createdAt") AS bucket_start,
            "channel",
            COUNT(*)::bigint AS event_count,
            COALESCE(SUM("bytesEstimate"), 0)::bigint AS bytes_sum
          FROM network_transfer_samples
          WHERE "createdAt" >= ${params.from} AND "createdAt" <= ${params.to}
          ${channelFilter}
          GROUP BY 1, 2
          ORDER BY 1 ASC, 2 ASC
        `;
  return rows.map((r) => ({
    bucketStart: r.bucket_start.toISOString(),
    channel: r.channel,
    eventCount: Number(r.event_count),
    bytesSum: r.bytes_sum,
  }));
}

const listSampleInclude = {
  integration: { select: { id: true, platform: true, label: true } as const },
} as const;

export type NetworkTransferSampleListRow = Prisma.NetworkTransferSampleGetPayload<{
  include: typeof listSampleInclude;
}>;

export async function listNetworkTransferSamples(params: {
  from: Date;
  to: Date;
  limit: number;
  page: number;
  channel?: NetworkTransferChannel | null;
}): Promise<{ items: NetworkTransferSampleListRow[]; totalPages: number; page: number }> {
  const take = Math.min(Math.max(params.limit, 1), 200);
  const page = Math.max(1, params.page);
  const where = {
    createdAt: { gte: params.from, lte: params.to },
    ...(params.channel ? { channel: params.channel } : {}),
  };
  const total = await db.networkTransferSample.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / take));
  const items = await db.networkTransferSample.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * take,
    take,
    include: listSampleInclude,
  });
  return { items, totalPages, page };
}

export function recordSyncJobNetworkSample(opts: {
  integrationId: string;
  platform: string;
  syncJobId: string;
  status: "COMPLETED" | "FAILED";
  itemsProcessed: number;
  itemsCreated?: number;
  itemsUpdated?: number;
  durationMs: number;
}): void {
  void recordNetworkTransferSample({
    channel: "SYNC_JOB",
    label: `${opts.platform} sync ${opts.status === "COMPLETED" ? "completed" : "failed"}`,
    durationMs: opts.durationMs,
    integrationId: opts.integrationId,
    metadata: {
      syncJobId: opts.syncJobId,
      status: opts.status,
      itemsProcessed: opts.itemsProcessed,
      itemsCreated: opts.itemsCreated ?? null,
      itemsUpdated: opts.itemsUpdated ?? null,
    },
  });
}

export async function getTotalsByChannel(params: {
  from: Date;
  to: Date;
  channel?: NetworkTransferChannel | null;
}): Promise<{ channel: NetworkTransferChannel; eventCount: number; bytesSum: number }[]> {
  const rows = await db.networkTransferSample.groupBy({
    by: ["channel"],
    where: {
      createdAt: { gte: params.from, lte: params.to },
      ...(params.channel ? { channel: params.channel } : {}),
    },
    _count: { id: true },
    _sum: { bytesEstimate: true },
  });
  return rows.map((r) => ({
    channel: r.channel,
    eventCount: r._count.id,
    bytesSum: r._sum.bytesEstimate ?? 0,
  }));
}

export function parseNetworkTransferQuery(searchParams: URLSearchParams): {
  from: Date;
  to: Date;
  bucket: NetworkTransferSeriesBucket;
  channelFilter: NetworkTransferChannel | null;
} {
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromParam = searchParams.get("from");
  const toParam = searchParams.get("to");
  const from = fromParam ? new Date(fromParam) : defaultFrom;
  const to = toParam ? new Date(toParam) : now;
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error("Invalid from/to date");
  }
  const rangeMs = to.getTime() - from.getTime();
  const defaultBucket: NetworkTransferSeriesBucket =
    rangeMs > 14 * 24 * 60 * 60 * 1000 ? "day" : "hour";
  const bucketParsed = bucketSchema.safeParse(searchParams.get("bucket") ?? defaultBucket);
  const bucket = bucketParsed.success ? bucketParsed.data : defaultBucket;
  const ch = searchParams.get("channel");
  const channelFilter =
    ch && ["CLIENT_API_RESPONSE", "MARKETPLACE_INBOUND", "SYNC_JOB", "FORECAST", "OTHER"].includes(ch)
      ? (ch as NetworkTransferChannel)
      : null;
  return { from, to, bucket, channelFilter };
}
