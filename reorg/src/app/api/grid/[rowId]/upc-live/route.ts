import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { Platform } from "@/lib/grid-types";

type LiveUpcLine =
  | {
      kind: "all";
      label: string;
      value: string;
    }
  | {
      kind: "platform";
      platform: Platform;
      label: string;
      value: string;
    };

const PLATFORM_ORDER: Platform[] = ["TPP_EBAY", "SHOPIFY", "BIGCOMMERCE", "TT_EBAY"];
const PLATFORM_SHORT: Record<Platform, string> = {
  TPP_EBAY: "TPP",
  TT_EBAY: "TT",
  BIGCOMMERCE: "BC",
  SHOPIFY: "SHPFY",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim().length > 0) {
          return entry.trim();
        }
      }
    }
  }
  return null;
}

function extractEbayUpc(rawData: unknown): string | null {
  const raw = asRecord(rawData);
  if (!raw) return null;

  const product = asRecord(raw.product) ?? asRecord(raw.Product);
  const productUpc = firstString(product?.upc, product?.UPC, product?.EAN, product?.GTIN);
  if (productUpc) return productUpc;

  const specifics = raw.ItemSpecifics;
  if (Array.isArray(specifics)) {
    for (const entry of specifics) {
      const record = asRecord(entry);
      const name = firstString(record?.Name, record?.name);
      if (name && ["UPC", "EAN", "GTIN"].includes(name.toUpperCase())) {
        const value = firstString(record?.Value, record?.value, record?.ValueLiteral);
        if (value) return value;
      }
    }
  }

  return null;
}

function extractListingUpc(platform: Platform, rawData: unknown): string | null {
  const raw = asRecord(rawData);
  if (!raw) return null;

  if (platform === "SHOPIFY") {
    const variant = asRecord(raw.variant);
    return firstString(variant?.barcode);
  }

  if (platform === "BIGCOMMERCE") {
    const variant = asRecord(raw.variant);
    const product = asRecord(raw.product);
    return firstString(variant?.upc, product?.upc);
  }

  if (platform === "TPP_EBAY" || platform === "TT_EBAY") {
    return extractEbayUpc(raw);
  }

  return null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<unknown> },
) {
  try {
    const { rowId } = (await context.params) as { rowId: string };
    const masterRowId = rowId.startsWith("child-") ? rowId.replace(/^child-/, "") : rowId;

    const row = await db.masterRow.findUnique({
      where: { id: masterRowId },
      select: {
        upc: true,
        listings: {
          select: {
            rawData: true,
            integration: {
              select: {
                platform: true,
              },
            },
          },
        },
      },
    });

    if (!row) {
      return NextResponse.json({ error: "Row not found" }, { status: 404 });
    }

    const platformValues = new Map<Platform, string>();

    for (const listing of row.listings) {
      const platform = listing.integration.platform as Platform;
      const upc = extractListingUpc(platform, listing.rawData);
      if (upc) {
        platformValues.set(platform, upc);
      }
    }

    if (!platformValues.has("TPP_EBAY") && row.upc) {
      platformValues.set("TPP_EBAY", row.upc);
    }

    const ordered = PLATFORM_ORDER
      .map((platform) => {
        const value = platformValues.get(platform);
        if (!value) return null;
        return {
          platform,
          label: PLATFORM_SHORT[platform],
          value,
        };
      })
      .filter((entry): entry is { platform: Platform; label: string; value: string } => Boolean(entry));

    const distinctValues = [...new Set(ordered.map((entry) => entry.value))];
    const lines: LiveUpcLine[] =
      ordered.length > 1 && distinctValues.length === 1
        ? [
            {
              kind: "all",
              label: "All Stores",
              value: distinctValues[0],
            },
          ]
        : ordered.map((entry) => ({
            kind: "platform" as const,
            platform: entry.platform,
            label: entry.label,
            value: entry.value,
          }));

    return NextResponse.json(
      { data: { lines } },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error("[grid] Failed to fetch UPC live summary", error);
    return NextResponse.json(
      { error: "Failed to fetch UPC live summary", details: String(error) },
      { status: 500 },
    );
  }
}
