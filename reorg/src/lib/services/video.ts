import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { refreshEbayItemsDirect } from "@/lib/services/ebay-tpp-sync";

const DEFAULT_VIDEO_MODEL = "bytedance/seedance/v1/pro/image-to-video";
const DEFAULT_VIDEO_DURATION_SECONDS = 12;
const VIDEO_ASPECT_RATIO = "16:9";
const VIDEO_RESOLUTION = "1080p";
const VIDEO_SIZE = "1920x1080";

export type VideoWindow = "7d" | "30d" | "90d";

export type VideoTopItem = {
  sku: string;
  title: string | null;
  marketplaceListingId: string | null;
  platformItemId: string | null;
  imageUrl: string | null;
  unitsSold: number;
  grossRevenue: number;
  netRevenue: number | null;
  orderCount: number;
  salePrice: number | null;
  inventory: number | null;
  listingUrl: string | null;
  hasListingDescription: boolean;
  photoCount: number;
};

export type VideoListingBrief = {
  marketplaceListingId: string;
  sku: string;
  title: string;
  platformItemId: string;
  listingUrl: string;
  imageUrls: string[];
  descriptionText: string | null;
  salePrice: number | null;
  inventory: number | null;
  upc: string | null;
  weight: string | null;
  condition: string | null;
  category: string | null;
  itemSpecifics: Array<{ name: string; value: string }>;
  prompt: string;
  negativePrompt: string;
  generationSettings: {
    modelId: string;
    quality: typeof VIDEO_RESOLUTION;
    size: typeof VIDEO_SIZE;
    aspectRatio: typeof VIDEO_ASPECT_RATIO;
    durationSeconds: number;
    formatGuidance: string;
  };
};

export type HiggsfieldConnectionStatus = {
  configured: boolean;
  authMode: "HF_KEY" | "HIGGSFIELD_API_KEY_SECRET" | "missing";
  modelId: string;
  quality: typeof VIDEO_RESOLUTION;
  size: typeof VIDEO_SIZE;
  aspectRatio: typeof VIDEO_ASPECT_RATIO;
};

type SaleLine = {
  marketplaceSaleOrderId: string;
  masterRowId: string | null;
  sku: string;
  title: string | null;
  platformItemId: string | null;
  quantity: number;
  unitPriceAmount: number | null;
  grossRevenueAmount: number | null;
  netRevenueAmount: number | null;
};

type MutableItem = {
  sku: string;
  title: string | null;
  platformItemIds: Set<string>;
  unitsSold: number;
  grossRevenue: number;
  netRevenueKnown: number;
  hasMissingNetData: boolean;
  orderIds: Set<string>;
};

type ListingFallbackRow = {
  id: string;
  sku: string;
  title: string | null;
  imageUrl: string | null;
  salePrice: number | null;
  inventory: number | null;
  platformItemId: string;
  rawData: Prisma.JsonValue;
  masterRow: {
    imageUrl: string | null;
    title: string | null;
  };
};

type VideoListingRecord = {
  id: string;
  sku: string;
  title: string | null;
  imageUrl: string | null;
  salePrice: number | null;
  inventory: number | null;
  platformItemId: string;
  rawData: Prisma.JsonValue;
  masterRow: {
    title: string | null;
    imageUrl: string | null;
    upc: string | null;
    weightDisplay: string | null;
    weight: string | null;
  };
};

type HiggsfieldQueuedResponse = {
  status?: string;
  request_id?: string;
  status_url?: string;
  cancel_url?: string;
  video?: { url?: string };
  images?: Array<{ url?: string }>;
};

function daysForWindow(window: VideoWindow) {
  if (window === "7d") return 7;
  if (window === "90d") return 90;
  return 30;
}

function startDateForWindow(window: VideoWindow) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (daysForWindow(window) - 1));
  return start;
}

function safeNumber(value: number | null | undefined) {
  return value != null && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

function firstString(values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function stripHtml(value: string | null) {
  if (!value) return null;
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : null;
}

function truncate(value: string | null, maxLength: number) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}...`;
}

function getItemSpecifics(rawData: unknown): Array<{ name: string; value: string }> {
  const raw = asRecord(rawData);
  const itemSpecifics = asRecord(raw?.ItemSpecifics);
  const list = itemSpecifics?.NameValueList;
  const entries = Array.isArray(list) ? list : list ? [list] : [];

  return entries.flatMap((entry) => {
    const record = asRecord(entry);
    const name = firstString([record?.Name]);
    const value = toStringArray(record?.Value).join(", ");
    if (!name || !value) return [];
    return [{ name, value }];
  });
}

function getSpecificValue(
  specifics: Array<{ name: string; value: string }>,
  names: string[],
) {
  const normalized = new Set(names.map((name) => name.toLowerCase()));
  return specifics.find((entry) => normalized.has(entry.name.toLowerCase()))?.value ?? null;
}

function getPictureUrls(rawData: unknown): string[] {
  const raw = asRecord(rawData);
  const urls = new Set<string>();
  for (const url of toStringArray(asRecord(raw?.PictureDetails)?.PictureURL)) {
    urls.add(url);
  }

  const variationPictures = asRecord(asRecord(raw?.Variations)?.Pictures);
  const pictureSets = variationPictures?.VariationSpecificPictureSet;
  const sets = Array.isArray(pictureSets) ? pictureSets : pictureSets ? [pictureSets] : [];
  for (const set of sets) {
    for (const url of toStringArray(asRecord(set)?.PictureURL)) {
      urls.add(url);
    }
  }

  return [...urls];
}

function readPath(value: unknown, path: string[]) {
  let current: unknown = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
  }
  return current;
}

function firstNumber(values: unknown[]) {
  for (const value of values) {
    const parsed =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getEbayQuantitySold(rawData: unknown) {
  return firstNumber([
    readPath(rawData, ["SellingStatus", "QuantitySold"]),
    readPath(rawData, ["SellingStatus", "QuantitySoldByPickupInStore"]),
    asRecord(rawData)?.QuantitySold,
  ]) ?? 0;
}

function getEbayWatchCount(rawData: unknown) {
  return firstNumber([
    asRecord(rawData)?.WatchCount,
    readPath(rawData, ["ListingDetails", "WatchCount"]),
  ]) ?? 0;
}

function getEbayViewCount(rawData: unknown) {
  return firstNumber([
    asRecord(rawData)?.HitCount,
    readPath(rawData, ["ListingDetails", "ViewItemURL"]),
  ]) ?? 0;
}

function getListingPhotoSet(listing: Pick<ListingFallbackRow, "imageUrl" | "rawData" | "masterRow">) {
  const photos = new Set<string>();
  if (listing.imageUrl) photos.add(listing.imageUrl);
  if (listing.masterRow.imageUrl) photos.add(listing.masterRow.imageUrl);
  for (const url of getPictureUrls(listing.rawData)) photos.add(url);
  return photos;
}

function getHiggsfieldAuthHeader() {
  const singleKey = process.env.HF_KEY || process.env.HIGGSFIELD_KEY;
  if (singleKey?.trim()) return `Key ${singleKey.trim()}`;

  const apiKey = process.env.HIGGSFIELD_API_KEY || process.env.HF_API_KEY;
  const apiSecret = process.env.HIGGSFIELD_API_SECRET || process.env.HF_API_SECRET;
  if (apiKey?.trim() && apiSecret?.trim()) {
    return `Key ${apiKey.trim()}:${apiSecret.trim()}`;
  }

  return null;
}

function getVideoModelId() {
  return process.env.HIGGSFIELD_VIDEO_MODEL?.trim() || DEFAULT_VIDEO_MODEL;
}

function getAuthMode(): HiggsfieldConnectionStatus["authMode"] {
  if ((process.env.HF_KEY || process.env.HIGGSFIELD_KEY)?.trim()) return "HF_KEY";
  if (
    (process.env.HIGGSFIELD_API_KEY || process.env.HF_API_KEY)?.trim() &&
    (process.env.HIGGSFIELD_API_SECRET || process.env.HF_API_SECRET)?.trim()
  ) {
    return "HIGGSFIELD_API_KEY_SECRET";
  }
  return "missing";
}

function ebayListingUrl(platformItemId: string | null | undefined) {
  return platformItemId ? `https://www.ebay.com/itm/${encodeURIComponent(platformItemId)}` : null;
}

function buildVideoPrompt(brief: Omit<VideoListingBrief, "prompt" | "negativePrompt" | "generationSettings">) {
  const specifics = brief.itemSpecifics.slice(0, 18);
  const brand = getSpecificValue(specifics, ["Brand", "Manufacturer", "Manufacturer Part Number"]);
  const mpn = getSpecificValue(specifics, ["Manufacturer Part Number", "MPN", "Part Number"]);
  const usefulSpecifics = specifics
    .filter((entry) => !["brand", "manufacturer", "manufacturer part number"].includes(entry.name.toLowerCase()))
    .map((entry) => `${entry.name}: ${entry.value}`)
    .join("; ");
  const description = truncate(brief.descriptionText, 1800);

  return [
    "Create a clear, engaging, promotional product video advertisement for an eBay video campaign.",
    `Final video target: ${VIDEO_SIZE}, ${VIDEO_RESOLUTION}, ${VIDEO_ASPECT_RATIO} landscape, square pixels, clean marketplace-safe product ad style, 12-15 seconds. No voiceover is needed.`,
    "Use the provided product image as the hero visual reference. Keep the exact product accurate: preserve shape, materials, color, labels, connectors, ports, fitment clues, and any visible part numbers.",
    "",
    "Product:",
    `Title: ${brief.title}`,
    `SKU: ${brief.sku}`,
    `eBay item ID: ${brief.platformItemId}`,
    brand ? `Brand/manufacturer: ${brand}` : null,
    mpn ? `Part number: ${mpn}` : null,
    brief.condition ? `Condition: ${brief.condition}` : null,
    brief.category ? `Category: ${brief.category}` : null,
    usefulSpecifics ? `Known specs: ${usefulSpecifics}` : null,
    description ? `Full listing description text to use for accurate feature selection: ${description}` : null,
    "",
    "Ad structure:",
    "0-2s: Strong hero reveal of the actual product with a smooth push-in and clean lighting.",
    "2-7s: Show 3-4 close-up detail moments based only on the listing facts: ports, materials, included parts, dimensions, condition, useful controls, or visible identifiers.",
    "7-11s: Make the product feel useful and easy to choose. Use subtle motion graphics or short on-screen callouts, maximum 3-5 words each.",
    "11-15s: End on a clean final beauty shot with concise on-screen copy: Match the part. Fix it fast.",
    "",
    "Visual style:",
    "Premium but practical marketplace ad. Crisp macro camera movement, clean studio or workbench setting, soft reflections, high contrast product detail, no messy background, no fake packaging.",
    "Keep the product centered and readable for shoppers watching muted autoplay. No voiceover. No loud text wall. No gimmicks that hide the item.",
    "",
    "Marketplace compliance:",
    "Do not invent compatibility, warranties, discounts, shipping promises, ratings, review counts, scarcity, or performance claims not present in the listing.",
    "Do not add Amazon, eBay, OEM, or vehicle brand logos unless they visibly exist on the actual product photo. Do not show prices.",
  ].filter(Boolean).join("\n");
}

function buildNegativePrompt() {
  return [
    "No fake logos, no invented brand marks, no wrong part numbers, no distorted connectors, no extra ports, no impossible fitment claims.",
    "No price tags, coupons, star ratings, review claims, shipping promises, warranty claims, or before/after claims.",
    "No cluttered text, no unreadable tiny captions, no heavy motion blur, no warped product geometry, no people holding the item unless the product remains accurate.",
  ].join(" ");
}

function normalizeHiggsfieldError(body: unknown, fallback: string) {
  const record = asRecord(body);
  return firstString([record?.error, record?.message, record?.detail]) ?? fallback;
}

export function getHiggsfieldConnectionStatus(): HiggsfieldConnectionStatus {
  const authMode = getAuthMode();
  return {
    configured: authMode !== "missing",
    authMode,
    modelId: getVideoModelId(),
    quality: VIDEO_RESOLUTION,
    size: VIDEO_SIZE,
    aspectRatio: VIDEO_ASPECT_RATIO,
  };
}

export async function getTopTppVideoItems(window: VideoWindow, limit = 30): Promise<VideoTopItem[]> {
  const from = startDateForWindow(window);
  const lines = await db.marketplaceSaleLine.findMany({
    where: {
      platform: "TPP_EBAY",
      orderDate: { gte: from },
      isCancelled: false,
      isReturn: false,
    },
    select: {
      marketplaceSaleOrderId: true,
      masterRowId: true,
      sku: true,
      title: true,
      platformItemId: true,
      quantity: true,
      unitPriceAmount: true,
      grossRevenueAmount: true,
      netRevenueAmount: true,
    },
  });

  const items = new Map<string, MutableItem>();
  for (const line of lines as SaleLine[]) {
    const key = line.sku.trim();
    if (!key) continue;
    const gross =
      safeNumber(line.grossRevenueAmount) ??
      ((safeNumber(line.unitPriceAmount) ?? 0) * line.quantity);
    const net = safeNumber(line.netRevenueAmount);
    const item =
      items.get(key) ??
      {
        sku: key,
        title: line.title,
        platformItemIds: new Set<string>(),
        unitsSold: 0,
        grossRevenue: 0,
        netRevenueKnown: 0,
        hasMissingNetData: false,
        orderIds: new Set<string>(),
      };
    if (!item.title?.trim() && line.title?.trim()) item.title = line.title;
    if (line.platformItemId?.trim()) item.platformItemIds.add(line.platformItemId);
    item.unitsSold += line.quantity;
    item.grossRevenue += gross;
    if (net != null) item.netRevenueKnown += net;
    else if (gross > 0) item.hasMissingNetData = true;
    item.orderIds.add(line.marketplaceSaleOrderId);
    items.set(key, item);
  }

  const ranked = [...items.values()]
    .sort((a, b) => b.unitsSold - a.unitsSold || b.grossRevenue - a.grossRevenue)
    .slice(0, limit);
  if (ranked.length === 0) return getTopTppListingsByEbayPerformance(limit);

  const skus = ranked.map((item) => item.sku);
  const itemIds = [...new Set(ranked.flatMap((item) => [...item.platformItemIds]))];
  const listings = await db.marketplaceListing.findMany({
    where: {
      integration: { platform: "TPP_EBAY" },
      OR: [
        { sku: { in: skus } },
        ...(itemIds.length > 0 ? [{ platformItemId: { in: itemIds } }] : []),
      ],
    },
    select: {
      id: true,
      sku: true,
      title: true,
      imageUrl: true,
      salePrice: true,
      inventory: true,
      platformItemId: true,
      rawData: true,
      masterRow: {
        select: {
          imageUrl: true,
          title: true,
        },
      },
    },
  });

  const revenueRows = ranked.map((item) => {
    const listing =
      listings.find((entry) => item.platformItemIds.has(entry.platformItemId)) ??
      listings.find((entry) => entry.sku === item.sku) ??
      null;
    const photos = new Set<string>();
    if (listing?.imageUrl) photos.add(listing.imageUrl);
    if (listing?.masterRow.imageUrl) photos.add(listing.masterRow.imageUrl);
    for (const url of getPictureUrls(listing?.rawData)) photos.add(url);

    return {
      sku: item.sku,
      title: listing?.title ?? item.title ?? listing?.masterRow.title ?? null,
      marketplaceListingId: listing?.id ?? null,
      platformItemId: listing?.platformItemId ?? [...item.platformItemIds][0] ?? null,
      imageUrl: listing?.imageUrl ?? listing?.masterRow.imageUrl ?? getPictureUrls(listing?.rawData)[0] ?? null,
      unitsSold: item.unitsSold,
      grossRevenue: item.grossRevenue,
      netRevenue: item.hasMissingNetData ? null : item.netRevenueKnown,
      orderCount: item.orderIds.size,
      salePrice: listing?.salePrice ?? null,
      inventory: listing?.inventory ?? null,
      listingUrl: ebayListingUrl(listing?.platformItemId ?? [...item.platformItemIds][0]),
      hasListingDescription: Boolean(stripHtml(firstString([asRecord(listing?.rawData)?.Description]))),
      photoCount: photos.size,
    };
  }).filter((row) => row.marketplaceListingId && row.imageUrl);

  return revenueRows.length > 0 ? revenueRows : getTopTppListingsByEbayPerformance(limit);
}

async function getTopTppListingsByEbayPerformance(limit: number): Promise<VideoTopItem[]> {
  const listings = await db.marketplaceListing.findMany({
    where: {
      integration: { platform: "TPP_EBAY" },
      status: "ACTIVE",
    },
    select: {
      id: true,
      sku: true,
      title: true,
      imageUrl: true,
      salePrice: true,
      inventory: true,
      platformItemId: true,
      rawData: true,
      masterRow: {
        select: {
          imageUrl: true,
          title: true,
        },
      },
    },
    take: 2000,
  });

  return (listings as ListingFallbackRow[])
    .map((listing) => {
      const unitsSold = getEbayQuantitySold(listing.rawData);
      const watchCount = getEbayWatchCount(listing.rawData);
      const viewCount = getEbayViewCount(listing.rawData);
      const photos = getListingPhotoSet(listing);
      return {
        listing,
        unitsSold,
        watchCount,
        viewCount,
        grossRevenue: unitsSold * (listing.salePrice ?? 0),
        photos,
      };
    })
    .filter((entry) =>
      entry.photos.size > 0 &&
      (entry.unitsSold > 0 || entry.watchCount > 0 || entry.viewCount > 0)
    )
    .sort((a, b) =>
      b.unitsSold - a.unitsSold ||
      b.grossRevenue - a.grossRevenue ||
      b.watchCount - a.watchCount ||
      b.viewCount - a.viewCount,
    )
    .slice(0, limit)
    .map(({ listing, unitsSold, grossRevenue, photos }) => ({
      sku: listing.sku,
      title: listing.title ?? listing.masterRow.title ?? null,
      marketplaceListingId: listing.id,
      platformItemId: listing.platformItemId,
      imageUrl: listing.imageUrl ?? listing.masterRow.imageUrl ?? [...photos][0] ?? null,
      unitsSold,
      grossRevenue,
      netRevenue: null,
      orderCount: unitsSold,
      salePrice: listing.salePrice,
      inventory: listing.inventory,
      listingUrl: ebayListingUrl(listing.platformItemId),
      hasListingDescription: Boolean(stripHtml(firstString([asRecord(listing.rawData)?.Description]))),
      photoCount: photos.size,
    }));
}

async function refreshListingForVideoBrief(listing: { platformItemId: string }) {
  const integration = await db.integration.findFirst({
    where: { platform: "TPP_EBAY" },
    select: { id: true, platform: true, config: true, enabled: true },
  });
  if (!integration?.enabled) return;

  await refreshEbayItemsDirect(
    {
      id: integration.id,
      platform: integration.platform,
      config: integration.config as Record<string, unknown>,
    },
    [listing.platformItemId],
  );
}

export async function getVideoListingBrief(marketplaceListingId: string): Promise<VideoListingBrief | null> {
  const listing = await db.marketplaceListing.findFirst({
    where: {
      id: marketplaceListingId,
      integration: { platform: "TPP_EBAY" },
    },
    select: {
      id: true,
      sku: true,
      title: true,
      imageUrl: true,
      salePrice: true,
      inventory: true,
      platformItemId: true,
      rawData: true,
      masterRow: {
        select: {
          title: true,
          imageUrl: true,
          upc: true,
          weightDisplay: true,
          weight: true,
        },
      },
    },
  });
  if (!listing) return null;

  const initialDescription = stripHtml(firstString([asRecord(listing.rawData)?.Description]));
  const initialPhotos = getPictureUrls(listing.rawData);
  if (!initialDescription || initialPhotos.length <= 1) {
    await refreshListingForVideoBrief(listing).catch((error) => {
      console.warn("[video] Full eBay item refresh failed before prompt build", error);
    });
    return getVideoListingBriefFromStoredData(marketplaceListingId);
  }

  return buildVideoListingBriefFromListing(listing);
}

async function getVideoListingBriefFromStoredData(marketplaceListingId: string): Promise<VideoListingBrief | null> {
  const listing = await db.marketplaceListing.findFirst({
    where: {
      id: marketplaceListingId,
      integration: { platform: "TPP_EBAY" },
    },
    select: {
      id: true,
      sku: true,
      title: true,
      imageUrl: true,
      salePrice: true,
      inventory: true,
      platformItemId: true,
      rawData: true,
      masterRow: {
        select: {
          title: true,
          imageUrl: true,
          upc: true,
          weightDisplay: true,
          weight: true,
        },
      },
    },
  });
  return listing ? buildVideoListingBriefFromListing(listing as VideoListingRecord) : null;
}

function buildVideoListingBriefFromListing(listing: VideoListingRecord): VideoListingBrief {
  const raw = asRecord(listing.rawData);
  const specifics = getItemSpecifics(listing.rawData);
  const images = new Set<string>();
  if (listing.imageUrl) images.add(listing.imageUrl);
  if (listing.masterRow.imageUrl) images.add(listing.masterRow.imageUrl);
  for (const url of getPictureUrls(listing.rawData)) images.add(url);

  const briefBase = {
    marketplaceListingId: listing.id,
    sku: listing.sku,
    title: listing.title ?? listing.masterRow.title ?? listing.sku,
    platformItemId: listing.platformItemId,
    listingUrl: ebayListingUrl(listing.platformItemId) ?? "",
    imageUrls: [...images].slice(0, 12),
    descriptionText: stripHtml(firstString([raw?.Description])),
    salePrice: listing.salePrice,
    inventory: listing.inventory,
    upc: listing.masterRow.upc,
    weight: listing.masterRow.weightDisplay ?? listing.masterRow.weight,
    condition: firstString([
      raw?.ConditionDisplayName,
      asRecord(raw?.ConditionDescriptor)?.Name,
      raw?.ConditionID,
    ]),
    category: firstString([
      asRecord(raw?.PrimaryCategory)?.CategoryName,
      asRecord(raw?.Storefront)?.StoreCategoryName,
    ]),
    itemSpecifics: specifics,
  };
  const negativePrompt = buildNegativePrompt();

  return {
    ...briefBase,
    prompt: buildVideoPrompt(briefBase),
    negativePrompt,
    generationSettings: {
      modelId: getVideoModelId(),
      quality: VIDEO_RESOLUTION,
      size: VIDEO_SIZE,
      aspectRatio: VIDEO_ASPECT_RATIO,
      durationSeconds: DEFAULT_VIDEO_DURATION_SECONDS,
      formatGuidance:
        "Amazon Sponsored Brands video accepts 16:9 square-pixel video at 1920x1080; 6-45 seconds allowed, 20 seconds or less recommended.",
    },
  };
}

export async function submitHiggsfieldVideoGeneration(args: {
  marketplaceListingId: string;
  userId?: string | null;
  durationSeconds?: number;
}) {
  const authHeader = getHiggsfieldAuthHeader();
  if (!authHeader) {
    throw new Error("Higgsfield is not configured. Add HF_KEY or HIGGSFIELD_API_KEY/HIGGSFIELD_API_SECRET server env vars.");
  }

  const brief = await getVideoListingBrief(args.marketplaceListingId);
  if (!brief) throw new Error("TPP eBay listing was not found.");
  if (brief.imageUrls.length === 0) {
    throw new Error("This listing has no product photo available for image-to-video generation.");
  }

  const duration = Math.min(20, Math.max(6, args.durationSeconds ?? DEFAULT_VIDEO_DURATION_SECONDS));
  const modelId = getVideoModelId();
  const response = await fetch(`https://platform.higgsfield.ai/${modelId}`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      image_url: brief.imageUrls[0],
      prompt: brief.prompt,
      negative_prompt: brief.negativePrompt,
      duration,
      aspect_ratio: VIDEO_ASPECT_RATIO,
      resolution: VIDEO_RESOLUTION,
    }),
  });

  const json = (await response.json().catch(() => null)) as HiggsfieldQueuedResponse | null;
  if (!response.ok) {
    throw new Error(normalizeHiggsfieldError(json, `Higgsfield request failed with status ${response.status}.`));
  }

  await db.auditLog.create({
    data: {
      userId: args.userId ?? null,
      action: "video_higgsfield_generation_requested",
      entityType: "marketplace_listing",
      entityId: brief.marketplaceListingId,
      details: {
        platform: "TPP_EBAY",
        sku: brief.sku,
        platformItemId: brief.platformItemId,
        modelId,
        duration,
        requestId: json?.request_id ?? null,
      } as unknown as Prisma.InputJsonValue,
    },
  }).catch((error) => {
    console.error("[video] Failed to audit Higgsfield generation request", error);
  });

  return {
    brief,
    higgsfield: json,
  };
}

export async function getHiggsfieldRequestStatus(requestId: string) {
  const authHeader = getHiggsfieldAuthHeader();
  if (!authHeader) {
    throw new Error("Higgsfield is not configured.");
  }

  const response = await fetch(`https://platform.higgsfield.ai/requests/${encodeURIComponent(requestId)}/status`, {
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(normalizeHiggsfieldError(json, `Higgsfield status failed with status ${response.status}.`));
  }
  return json;
}
