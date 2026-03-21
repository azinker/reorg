import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassEnabled } from "@/lib/app-env";
import { db } from "@/lib/db";
import { PLATFORM_FULL, PLATFORM_SHORT } from "@/lib/grid-types";
import { classifyPushFailure } from "@/lib/push-failure";
import type { Platform } from "@prisma/client";

type FailedResultRow = {
  stagedChangeId: string | null;
  masterRowId: string;
  marketplaceListingId: string;
  platform: Platform;
  listingId: string;
  field: string;
  oldValue: number | string | null;
  newValue: number | string;
  success: boolean;
  error?: string;
};

function formatFieldLabel(field: string) {
  if (field === "salePrice") return "Sale Price";
  if (field === "adRate") return "Promoted General Ad Rate";
  if (field === "upc") return "UPC";
  return field;
}

function formatValue(field: string, value: number | string | null) {
  if (value == null) return "N/A";
  if (field === "upc") return String(value);
  if (field === "adRate") return `${(Number(value) * 100).toFixed(1)}%`;
  return `$${Number(value).toFixed(2)}`;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id && !isAuthBypassEnabled()) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pushJobs = await db.pushJob.findMany({
    where: {
      dryRun: false,
      createdAt: {
        gte: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14),
      },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const candidateFailures: Array<{
    pushJobId: string;
    failedAt: string;
    result: FailedResultRow;
  }> = [];

  for (const job of pushJobs) {
    const result = (job.result as Record<string, unknown> | null) ?? {};
    const results = Array.isArray(result.results) ? (result.results as FailedResultRow[]) : [];
    for (const entry of results) {
      if (entry.success === false) {
        candidateFailures.push({
          pushJobId: job.id,
          failedAt: job.completedAt?.toISOString() ?? job.createdAt.toISOString(),
          result: entry,
        });
      }
    }
  }

  const stagedIds = [
    ...new Set(
      candidateFailures
        .map((entry) => entry.result.stagedChangeId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];
  const listingIds = [
    ...new Set(
      candidateFailures
        .map((entry) => entry.result.marketplaceListingId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ),
  ];

  const [stagedChanges, listings] = await Promise.all([
    stagedIds.length > 0
      ? db.stagedChange.findMany({
          where: { id: { in: stagedIds } },
          select: { id: true, status: true },
        })
      : Promise.resolve([]),
    listingIds.length > 0
      ? db.marketplaceListing.findMany({
          where: { id: { in: listingIds } },
          select: {
            id: true,
            sku: true,
            platformVariantId: true,
            title: true,
            masterRowId: true,
            masterRow: { select: { sku: true, title: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const stagedStatusById = new Map(stagedChanges.map((change) => [change.id, change.status]));
  const listingById = new Map(listings.map((listing) => [listing.id, listing]));
  const seen = new Set<string>();

  const failures = candidateFailures.flatMap((entry) => {
    const result = entry.result;
    const retryKey =
      result.stagedChangeId ??
      `${result.platform}:${result.marketplaceListingId}:${result.field}:${result.newValue}`;

    if (seen.has(retryKey)) return [];
    seen.add(retryKey);

    if (result.stagedChangeId) {
      const stagedStatus = stagedStatusById.get(result.stagedChangeId);
      if (stagedStatus && stagedStatus !== "STAGED") return [];
    }

    const listing = listingById.get(result.marketplaceListingId);
    const sku = listing?.masterRow?.sku ?? listing?.sku ?? "Unknown SKU";
    const title = listing?.masterRow?.title ?? listing?.title ?? sku;
    const platformVariantId = listing?.platformVariantId ?? null;
    const failureHelp = classifyPushFailure(
      result.error ?? "Push failed.",
      PLATFORM_FULL[result.platform] ?? PLATFORM_SHORT[result.platform] ?? result.platform,
    );

    return [
      {
        retryKey,
        pushJobId: entry.pushJobId,
        failedAt: entry.failedAt,
        sku,
        title,
        platform: result.platform,
        platformLabel: PLATFORM_FULL[result.platform] ?? PLATFORM_SHORT[result.platform] ?? result.platform,
        listingId: result.listingId,
        platformVariantId,
        field: result.field,
        fieldLabel: formatFieldLabel(result.field),
        oldValue: result.oldValue,
        newValue: result.newValue,
        oldDisplay: formatValue(result.field, result.oldValue),
        newDisplay: formatValue(result.field, result.newValue),
        error: result.error ?? "Push failed.",
        failureCategory: failureHelp.category,
        failureSummary: failureHelp.summary,
        recommendedAction: failureHelp.recommendedAction,
        stagedChangeId: result.stagedChangeId,
        masterRowId: result.masterRowId || listing?.masterRowId || "",
        marketplaceListingId: result.marketplaceListingId,
      },
    ];
  });

  return NextResponse.json({
    data: {
      count: failures.length,
      failures,
    },
  });
}
