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

type LiveUpcChoice = {
  platform: Platform;
  label: string;
  value: string;
  editable: boolean;
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

  const listingDetails = asRecord(raw.ProductListingDetails);
  const listingDetailsUpc = firstString(
    listingDetails?.UPC,
    listingDetails?.EAN,
    listingDetails?.GTIN,
    listingDetails?.ISBN,
  );
  if (listingDetailsUpc && listingDetailsUpc !== "Does not apply" && listingDetailsUpc !== "N/A") {
    return listingDetailsUpc;
  }

  const variationListingDetails = asRecord(raw.VariationProductListingDetails);
  const variationUpc = firstString(
    variationListingDetails?.UPC,
    variationListingDetails?.EAN,
    variationListingDetails?.GTIN,
    variationListingDetails?.ISBN,
  );
  if (variationUpc && variationUpc !== "Does not apply" && variationUpc !== "N/A") {
    return variationUpc;
  }

  const product = asRecord(raw.product) ?? asRecord(raw.Product);
  const productUpc = firstString(product?.upc, product?.UPC, product?.EAN, product?.GTIN);
  if (productUpc) return productUpc;

  const rawUpc = firstString(raw.upc, raw.UPC, raw.ean, raw.EAN, raw.gtin, raw.GTIN);
  if (rawUpc && rawUpc !== "Does not apply" && rawUpc !== "N/A") {
    return rawUpc;
  }

  const specifics = raw.ItemSpecifics;
  const nameValueList = Array.isArray(specifics)
    ? specifics
    : asRecord(specifics) && Array.isArray(asRecord(specifics)?.NameValueList)
      ? (asRecord(specifics)?.NameValueList as unknown[])
      : [];

  for (const entry of nameValueList) {
    const record = asRecord(entry);
    const name = firstString(record?.Name, record?.name);
    if (name && ["UPC", "EAN", "GTIN", "ISBN"].includes(name.toUpperCase())) {
      const value = firstString(record?.Value, record?.value, record?.ValueLiteral);
      if (value && value !== "Does not apply" && value !== "N/A") {
        return value;
      }
    }
  }

  const variationSpecifics = asRecord(raw.VariationSpecifics);
  const variationNameValueList = variationSpecifics && Array.isArray(variationSpecifics.NameValueList)
    ? variationSpecifics.NameValueList
    : [];
  for (const entry of variationNameValueList) {
    const record = asRecord(entry);
    const name = firstString(record?.Name, record?.name);
    if (name && ["UPC", "EAN", "GTIN", "ISBN"].includes(name.toUpperCase())) {
      const value = firstString(record?.Value, record?.value, record?.ValueLiteral);
      if (value && value !== "Does not apply" && value !== "N/A") {
        return value;
      }
    }
  }

  const variations = asRecord(raw.Variations);
  const variationList = variations && Array.isArray(variations.Variation)
    ? variations.Variation
    : [];
  for (const variation of variationList) {
    const variationRecord = asRecord(variation);
    if (!variationRecord) continue;
    const variationDetails = asRecord(variationRecord.VariationProductListingDetails);
    const variationValue = firstString(
      variationDetails?.UPC,
      variationDetails?.EAN,
      variationDetails?.GTIN,
      variationDetails?.ISBN,
    );
    if (variationValue && variationValue !== "Does not apply" && variationValue !== "N/A") {
      return variationValue;
    }
    const variationSpecificList =
      asRecord(variationRecord.VariationSpecifics) &&
      Array.isArray(asRecord(variationRecord.VariationSpecifics)?.NameValueList)
        ? (asRecord(variationRecord.VariationSpecifics)?.NameValueList as unknown[])
        : [];
    for (const entry of variationSpecificList) {
      const record = asRecord(entry);
      const name = firstString(record?.Name, record?.name);
      if (name && ["UPC", "EAN", "GTIN", "ISBN"].includes(name.toUpperCase())) {
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

    const choices: LiveUpcChoice[] = ordered.map((entry) => ({
      platform: entry.platform,
      label: entry.label,
      value: entry.value,
      editable: entry.platform === "BIGCOMMERCE" || entry.platform === "SHOPIFY",
    }));

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
      { data: { lines, choices } },
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
