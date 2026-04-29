import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";

const UPC_STAGEABLE_PLATFORMS = new Set(["TPP_EBAY", "TT_EBAY", "BIGCOMMERCE", "SHOPIFY"]);

const stageSchema = z.object({
  action: z.enum(["stage", "stage_local_only", "push", "discard", "clear_all"]),
  sku: z.string().optional(),
  platform: z.string().optional(),
  listingId: z.string().optional(),
  newPrice: z.number().optional(),
  newValue: z.string().optional(),
  rejectionReason: z.string().optional(),
  field: z.enum(["salePrice", "adRate", "upc"]).optional(),
  /** DB primary key of the MarketplaceListing — when provided, bypasses the ambiguous findFirst by platformItemId. */
  marketplaceListingId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = stageSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { action, sku, platform, listingId, newPrice, newValue, rejectionReason, field: stageField, marketplaceListingId: directMlId } = parsed.data;
    const targetField = stageField ?? "salePrice";

    if (action === "clear_all") {
      const cancelled = await db.stagedChange.updateMany({
        where: { status: "STAGED" },
        data: { status: "CANCELLED" },
      });
      return NextResponse.json({ data: { cleared: cancelled.count } });
    }

    if (!sku) {
      return NextResponse.json({ error: "sku required" }, { status: 400 });
    }

    if (targetField !== "upc" && (!platform || !listingId)) {
      return NextResponse.json({ error: "sku, platform, listingId required" }, { status: 400 });
    }

    const master = await db.masterRow.findUnique({
      where: { sku },
      include: {
        listings: {
          select: {
            id: true,
            platformItemId: true,
            integration: { select: { platform: true } },
          },
        },
      },
    });
    if (!master) {
      return NextResponse.json({ error: `Product not found: ${sku}` }, { status: 404 });
    }

    if (targetField === "upc") {
      const isTargetedUpcAction = Boolean(platform && listingId);
      const eligibleListings = master.listings.filter((entry) => {
        const platformEligible = UPC_STAGEABLE_PLATFORMS.has(entry.integration.platform);
        if (!platformEligible) return false;
        if (platform && entry.integration.platform !== platform) return false;
        if (listingId && entry.platformItemId !== listingId) return false;
        return true;
      });

      if (action === "stage") {
        const normalizedUpc = newValue?.trim() ?? "";
        if (!normalizedUpc) {
          return NextResponse.json({ error: "newValue required for UPC staging" }, { status: 400 });
        }

        if (isTargetedUpcAction && eligibleListings.length === 0) {
          return NextResponse.json({ error: "Supported UPC listing not found" }, { status: 404 });
        }

        const liveValue = master.upc?.trim() || null;

        if (isTargetedUpcAction) {
          const targetListingIds = eligibleListings.map((listing) => listing.id);
          const existingStages = await db.stagedChange.findMany({
            where: {
              masterRowId: master.id,
              marketplaceListingId: { in: targetListingIds },
              field: "upc",
              status: "STAGED",
            },
          });

          const allTargetsAlreadyStaged =
            existingStages.length === targetListingIds.length &&
            existingStages.every((change) => change.stagedValue?.trim() === normalizedUpc);

          if (allTargetsAlreadyStaged) {
            return NextResponse.json({
              data: {
                action: "noop",
                reason: "unchanged",
                sku,
                platform,
                listingId,
                field: "upc",
                newValue: normalizedUpc,
              },
            });
          }

          await db.stagedChange.updateMany({
            where: {
              masterRowId: master.id,
              marketplaceListingId: { in: targetListingIds },
              field: "upc",
              status: "STAGED",
            },
            data: { status: "CANCELLED" },
          });

          const systemUser = await getSystemUser();
          const createdStages = await Promise.all(
            eligibleListings.map((listing) =>
              db.stagedChange.create({
                data: {
                  masterRowId: master.id,
                  marketplaceListingId: listing.id,
                  field: "upc",
                  stagedValue: normalizedUpc,
                  liveValue: liveValue,
                  changedById: systemUser.id,
                },
              }),
            ),
          );

          await db.auditLog.create({
            data: {
              userId: systemUser.id,
              action: "staged_change",
              entityType: "StagedChange",
              entityId: master.id,
              details: {
                sku: master.sku,
                field: "upc",
                oldValue: liveValue,
                newValue: normalizedUpc,
                platform,
                listingId,
                targetCount: eligibleListings.length,
              },
            },
          });

          return NextResponse.json({
            data: {
              action: "staged",
              sku,
              platform,
              listingId,
              field: "upc",
              newValue: normalizedUpc,
              targetCount: eligibleListings.length,
              targets: eligibleListings.map((listing, index) => ({
                platform: listing.integration.platform,
                listingId: listing.platformItemId,
                marketplaceListingId: listing.id,
                stagedChangeId: createdStages[index]?.id ?? null,
              })),
            },
          });
        }

        const existingStaged = await db.stagedChange.findFirst({
          where: {
            masterRowId: master.id,
            field: "upc",
            status: "STAGED",
          },
          orderBy: { createdAt: "desc" },
        });
        const effectiveValue = existingStaged?.stagedValue?.trim() || liveValue;

        if (effectiveValue === normalizedUpc) {
          return NextResponse.json({
            data: { action: "noop", reason: "unchanged", sku, field: "upc", newValue: normalizedUpc },
          });
        }

        await db.stagedChange.updateMany({
          where: {
            masterRowId: master.id,
            field: "upc",
            status: "STAGED",
          },
          data: { status: "CANCELLED" },
        });

        if (liveValue === normalizedUpc) {
          return NextResponse.json({
            data: { action: "noop", reason: "matches-live", sku, field: "upc", newValue: normalizedUpc },
          });
        }

        const systemUser = await getSystemUser();
        if (eligibleListings.length === 0) {
          await db.stagedChange.create({
            data: {
              masterRowId: master.id,
              marketplaceListingId: null,
              field: "upc",
              stagedValue: normalizedUpc,
              liveValue: liveValue,
              changedById: systemUser.id,
            },
          });
        } else {
          await db.stagedChange.createMany({
            data: eligibleListings.map((listing) => ({
              masterRowId: master.id,
              marketplaceListingId: listing.id,
              field: "upc",
              stagedValue: normalizedUpc,
              liveValue: liveValue,
              changedById: systemUser.id,
            })),
          });
        }

        await db.auditLog.create({
          data: {
            userId: systemUser.id,
            action: "staged_change",
            entityType: "StagedChange",
            entityId: master.id,
            details: {
              sku: master.sku,
              field: "upc",
              oldValue: liveValue,
              newValue: normalizedUpc,
            },
          },
        });

        return NextResponse.json({
          data: {
            action: "staged",
            sku,
            field: "upc",
            newValue: normalizedUpc,
            targetCount: eligibleListings.length,
          },
        });
      }

      if (action === "stage_local_only") {
        const normalizedUpc = newValue?.trim() ?? "";
        if (!normalizedUpc) {
          return NextResponse.json({ error: "newValue required for local-only UPC" }, { status: 400 });
        }

        if (isTargetedUpcAction && eligibleListings.length === 0) {
          return NextResponse.json({ error: "Supported UPC listing not found" }, { status: 404 });
        }

        const liveValue = master.upc?.trim() || null;
        const reason =
          rejectionReason?.trim() ||
          "Saved locally (catalog only — not applied on the marketplace).";

        if (isTargetedUpcAction) {
          const targetListingIds = eligibleListings.map((listing) => listing.id);

          const stagedRemaining = await db.stagedChange.count({
            where: {
              masterRowId: master.id,
              marketplaceListingId: { in: targetListingIds },
              field: "upc",
              status: "STAGED",
            },
          });
          const localRows = await db.stagedChange.findMany({
            where: {
              masterRowId: master.id,
              marketplaceListingId: { in: targetListingIds },
              field: "upc",
              status: "LOCAL_ONLY",
            },
          });
          const alreadyLocalOnly =
            stagedRemaining === 0 &&
            localRows.length === targetListingIds.length &&
            localRows.every((r) => r.stagedValue?.trim() === normalizedUpc);

          if (alreadyLocalOnly) {
            return NextResponse.json({
              data: {
                action: "noop",
                reason: "unchanged",
                sku,
                platform,
                listingId,
                field: "upc",
                newValue: normalizedUpc,
              },
            });
          }

          await db.stagedChange.updateMany({
            where: {
              masterRowId: master.id,
              marketplaceListingId: { in: targetListingIds },
              field: "upc",
              status: { in: ["STAGED", "LOCAL_ONLY"] },
            },
            data: { status: "CANCELLED" },
          });

          const systemUser = await getSystemUser();
          const createdStages = await Promise.all(
            eligibleListings.map((listing) =>
              db.stagedChange.create({
                data: {
                  masterRowId: master.id,
                  marketplaceListingId: listing.id,
                  field: "upc",
                  stagedValue: normalizedUpc,
                  liveValue: liveValue,
                  status: "LOCAL_ONLY",
                  rejectionReason: reason,
                  changedById: systemUser.id,
                },
              }),
            ),
          );

          await db.auditLog.create({
            data: {
              userId: systemUser.id,
              action: "staged_change_local_only",
              entityType: "StagedChange",
              entityId: master.id,
              details: {
                sku: master.sku,
                field: "upc",
                newValue: normalizedUpc,
                platform,
                listingId,
                targetCount: eligibleListings.length,
                rejectionReason: reason,
              },
            },
          });

          return NextResponse.json({
            data: {
              action: "staged_local_only",
              sku,
              platform,
              listingId,
              field: "upc",
              newValue: normalizedUpc,
              targetCount: eligibleListings.length,
              targets: eligibleListings.map((listing, index) => ({
                platform: listing.integration.platform,
                listingId: listing.platformItemId,
                marketplaceListingId: listing.id,
                stagedChangeId: createdStages[index]?.id ?? null,
              })),
            },
          });
        }

        await db.stagedChange.updateMany({
          where: {
            masterRowId: master.id,
            field: "upc",
            status: { in: ["STAGED", "LOCAL_ONLY"] },
          },
          data: { status: "CANCELLED" },
        });

        const systemUser = await getSystemUser();
        if (eligibleListings.length === 0) {
          await db.stagedChange.create({
            data: {
              masterRowId: master.id,
              marketplaceListingId: null,
              field: "upc",
              stagedValue: normalizedUpc,
              liveValue: liveValue,
              status: "LOCAL_ONLY",
              rejectionReason: reason,
              changedById: systemUser.id,
            },
          });
        } else {
          await db.stagedChange.createMany({
            data: eligibleListings.map((listing) => ({
              masterRowId: master.id,
              marketplaceListingId: listing.id,
              field: "upc",
              stagedValue: normalizedUpc,
              liveValue: liveValue,
              status: "LOCAL_ONLY" as const,
              rejectionReason: reason,
              changedById: systemUser.id,
            })),
          });
        }

        await db.auditLog.create({
          data: {
            userId: systemUser.id,
            action: "staged_change_local_only",
            entityType: "StagedChange",
            entityId: master.id,
            details: {
              sku: master.sku,
              field: "upc",
              newValue: normalizedUpc,
              targetCount: eligibleListings.length,
              rejectionReason: reason,
            },
          },
        });

        return NextResponse.json({
          data: {
            action: "staged_local_only",
            sku,
            field: "upc",
            newValue: normalizedUpc,
            targetCount: eligibleListings.length,
          },
        });
      }

      if (action === "discard") {
        if (isTargetedUpcAction && eligibleListings.length === 0) {
          return NextResponse.json({ error: "Supported UPC listing not found" }, { status: 404 });
        }

        const discarded = await db.stagedChange.updateMany({
          where: {
            masterRowId: master.id,
            field: "upc",
            status: "STAGED",
            ...(isTargetedUpcAction
              ? {
                  marketplaceListingId: { in: eligibleListings.map((listing) => listing.id) },
                }
              : {}),
          },
          data: { status: "CANCELLED" },
        });

        return NextResponse.json({
          data: {
            action: "discarded",
            sku,
            platform,
            listingId,
            field: "upc",
            count: discarded.count,
          },
        });
      }

      if (action === "push") {
        return NextResponse.json(
          {
            error:
              "Direct push from the staging route is disabled. Run the guarded /api/push dry-run and confirmation flow instead.",
          },
          { status: 409 },
        );
      }

      return NextResponse.json({ error: "Invalid UPC action" }, { status: 400 });
    }

    const listing = directMlId
      ? await db.marketplaceListing.findFirst({
          where: { id: directMlId, masterRowId: master.id },
        })
      : await db.marketplaceListing.findFirst({
          where: {
            masterRowId: master.id,
            platformItemId: listingId,
            integration: { platform: platform as never },
          },
        });

    if (!listing) {
      return NextResponse.json({ error: "Listing not found" }, { status: 404 });
    }

    if (action === "stage" && newPrice != null) {
      const liveValue = targetField === "adRate" ? listing.adRate : listing.salePrice;
      const existingStaged = await db.stagedChange.findFirst({
        where: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          status: "STAGED",
        },
        orderBy: { createdAt: "desc" },
      });
      const effectiveValue = existingStaged?.stagedValue != null
        ? Number(existingStaged.stagedValue)
        : liveValue;
      const matchesLive = liveValue != null && Math.abs(Number(liveValue) - newPrice) < 0.000001;
      const matchesCurrent = effectiveValue != null && Math.abs(Number(effectiveValue) - newPrice) < 0.000001;

      if (matchesCurrent) {
        return NextResponse.json({
          data: { action: "noop", reason: "unchanged", sku, listingId, field: targetField, newPrice },
        });
      }

      await db.stagedChange.updateMany({
        where: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          status: "STAGED",
        },
        data: { status: "CANCELLED" },
      });

      if (matchesLive) {
        return NextResponse.json({
          data: { action: "noop", reason: "matches-live", sku, listingId, field: targetField, newPrice },
        });
      }

      const systemUser = await getSystemUser();
      await db.stagedChange.create({
        data: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          stagedValue: String(newPrice),
          liveValue: liveValue != null ? String(liveValue) : null,
          changedById: systemUser.id,
        },
      });

      await db.auditLog.create({
        data: {
          userId: systemUser.id,
          action: "staged_change",
          entityType: "StagedChange",
          entityId: master.id,
          details: {
            sku: master.sku,
            field: targetField,
            oldValue: liveValue != null ? String(liveValue) : null,
            newValue: String(newPrice),
            platform,
            listingId,
          },
        },
      });

      return NextResponse.json({ data: { action: "staged", sku, listingId, field: targetField, newPrice } });
    }

    if (action === "push" && newPrice != null) {
      return NextResponse.json(
        {
          error:
            "Direct push from the staging route is disabled. Run the guarded /api/push dry-run and confirmation flow instead.",
        },
        { status: 409 },
      );
    }

    if (action === "discard") {
      const discarded = await db.stagedChange.updateMany({
        where: {
          masterRowId: master.id,
          marketplaceListingId: listing.id,
          field: targetField,
          status: "STAGED",
        },
        data: { status: "CANCELLED" },
      });

      return NextResponse.json({ data: { action: "discarded", sku, listingId, field: targetField, count: discarded.count } });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("[grid/stage] Failed to process staging action", error);
    return NextResponse.json(
      { error: "Failed to process staging action" },
      { status: 500 }
    );
  }
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
