import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type UndoRequestBody = {
  auditLogId?: string;
};

type StagedUpcSnapshot = {
  marketplaceListingId: string | null;
  stagedValue: string;
  liveValue: string | null;
};

type ImportUndoOperation =
  | {
      kind: "restore_existing";
      masterRowId: string;
      sku: string;
      previousValues: {
        title: string | null;
        weight: string | null;
        weightOz: number | null;
        supplierCost: number | null;
        supplierShipping: number | null;
        notes: string | null;
      };
      previousStagedUpcChanges: StagedUpcSnapshot[];
    }
  | {
      kind: "delete_created";
      masterRowId: string;
      sku: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseUndoOperations(value: unknown): ImportUndoOperation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is ImportUndoOperation =>
      !!entry &&
      typeof entry === "object" &&
      ("kind" in entry) &&
      ((entry as { kind?: string }).kind === "restore_existing" ||
        (entry as { kind?: string }).kind === "delete_created"),
  );
}

async function getSystemUser() {
  let user = await db.user.findFirst({ where: { role: "ADMIN" } });
  if (!user) {
    user = await db.user.create({
      data: {
        email: "system@reorg.internal",
        name: "System",
        role: "ADMIN",
      },
    });
  }
  return user;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as UndoRequestBody;
    const auditLogId = typeof body.auditLogId === "string" ? body.auditLogId.trim() : "";

    if (!auditLogId) {
      return NextResponse.json({ error: "Missing audit log id." }, { status: 400 });
    }

    const auditLog = await db.auditLog.findUnique({
      where: { id: auditLogId },
      select: {
        id: true,
        details: true,
        action: true,
        entityId: true,
      },
    });

    if (!auditLog || auditLog.action !== "import_completed") {
      return NextResponse.json({ error: "Import audit log not found." }, { status: 404 });
    }

    const details = asRecord(auditLog.details) ?? {};
    if (details.undoAppliedAt) {
      return NextResponse.json({ error: "This import has already been undone." }, { status: 400 });
    }

    const undoOperations = parseUndoOperations(details.undoOperations);
    if (undoOperations.length === 0) {
      return NextResponse.json({ error: "No undo snapshot is available for this import." }, { status: 400 });
    }

    const systemUser = await getSystemUser();
    let restoredRows = 0;
    let deletedRows = 0;
    const skipped: Array<{ sku: string; reason: string }> = [];

    for (const operation of undoOperations) {
      if (operation.kind === "restore_existing") {
        await db.$transaction(async (tx) => {
          await tx.masterRow.update({
            where: { id: operation.masterRowId },
            data: operation.previousValues,
          });

          await tx.stagedChange.updateMany({
            where: {
              masterRowId: operation.masterRowId,
              field: "upc",
              status: "STAGED",
            },
            data: { status: "CANCELLED" },
          });

          if (operation.previousStagedUpcChanges.length > 0) {
            await tx.stagedChange.createMany({
              data: operation.previousStagedUpcChanges.map((change) => ({
                masterRowId: operation.masterRowId,
                marketplaceListingId: change.marketplaceListingId,
                field: "upc",
                stagedValue: change.stagedValue,
                liveValue: change.liveValue,
                changedById: systemUser.id,
                status: "STAGED" as const,
              })),
            });
          }
        });

        restoredRows += 1;
        continue;
      }

      const masterRow = await db.masterRow.findUnique({
        where: { id: operation.masterRowId },
        select: {
          id: true,
          _count: {
            select: {
              listings: true,
              saleHistoryLines: true,
              inventorySnapshots: true,
              forecastRunLines: true,
              supplierOrderLines: true,
            },
          },
        },
      });

      if (!masterRow) {
        continue;
      }

      const hasDependencies =
        masterRow._count.listings > 0 ||
        masterRow._count.saleHistoryLines > 0 ||
        masterRow._count.inventorySnapshots > 0 ||
        masterRow._count.forecastRunLines > 0 ||
        masterRow._count.supplierOrderLines > 0;

      if (hasDependencies) {
        skipped.push({
          sku: operation.sku,
          reason: "The created row is already linked to other records, so it was left in place.",
        });
        continue;
      }

      await db.$transaction(async (tx) => {
        await tx.stagedChange.deleteMany({
          where: { masterRowId: operation.masterRowId },
        });
        await tx.masterRow.delete({
          where: { id: operation.masterRowId },
        });
      });
      deletedRows += 1;
    }

    const nextDetails = {
      ...details,
      undoAppliedAt: new Date().toISOString(),
      undoSummary: {
        restoredRows,
        deletedRows,
        skipped,
      },
    };

    await db.auditLog.update({
      where: { id: auditLog.id },
      data: {
        details: nextDetails as Prisma.InputJsonValue,
      },
    });

    await db.auditLog.create({
      data: {
        userId: systemUser.id,
        action: "import_undone",
        entityType: "import",
        entityId: auditLog.entityId,
        details: {
          sourceAuditLogId: auditLog.id,
          restoredRows,
          deletedRows,
          skipped,
        } as const,
      },
    });

    return NextResponse.json({
      data: {
        restoredRows,
        deletedRows,
        skipped,
      },
    });
  } catch (error) {
    console.error("[import] Failed to undo import", error);
    return NextResponse.json({ error: "Failed to undo import." }, { status: 500 });
  }
}
