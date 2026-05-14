import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fetchEbayTppFullItemDirect } from "@/lib/services/ebay-tpp-sync";
import { fetchMarketplaceSales } from "@/lib/inventory-forecast/marketplace-sales";

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

export type VideoSalesCoverage = {
  window: VideoWindow;
  source: "database" | "live_ebay";
  requestedFrom: string;
  requestedTo: string;
  latestOrderDate: string | null;
  hasCurrentWindowData: boolean;
  isStale: boolean;
  message: string | null;
};

export type VideoTopItemsResult = {
  items: VideoTopItem[];
  coverage: VideoSalesCoverage;
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
    .replace(/<\/(p|div|section|article|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : null;
}

function truncate(value: string | null, maxLength: number) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}\n[Description truncated for prompt length.]`;
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

function formatSpecificsForPrompt(specifics: Array<{ name: string; value: string }>) {
  if (specifics.length === 0) return "No structured item specifics were returned. Use the title, photos, and full listing description.";
  return specifics
    .slice(0, 36)
    .map((entry) => `- ${entry.name}: ${entry.value}`)
    .join("\n");
}

function formatPhotoUrlsForPrompt(imageUrls: string[]) {
  if (imageUrls.length === 0) return "No listing photos were returned.";
  return imageUrls
    .slice(0, 12)
    .map((url, index) => `- Photo ${index + 1}: ${url}`)
    .join("\n");
}

function buildVideoPrompt(brief: Omit<VideoListingBrief, "prompt" | "negativePrompt" | "generationSettings">) {
  const specifics = brief.itemSpecifics;
  const brand = getSpecificValue(specifics, ["Brand", "Manufacturer"]);
  const mpn = getSpecificValue(specifics, ["Manufacturer Part Number", "MPN", "Part Number"]);
  const description = truncate(brief.descriptionText, 12000);

  return [
    "Create a premium, clear, engaging 15-second product video advertisement for an eBay video campaign.",
    "",
    "VIDEO SETTINGS:",
    `- Format: ${VIDEO_ASPECT_RATIO} horizontal widescreen`,
    `- Resolution: ${VIDEO_SIZE}, ${VIDEO_RESOLUTION.toUpperCase()} Full HD`,
    "- Duration: exactly 15 seconds",
    "- Audio: no voiceover, no spoken script, no music requirement; the ad must work perfectly on muted autoplay",
    "- Style: polished Amazon/eBay-style e-commerce product ad",
    "- Mood: trustworthy, useful, practical, buyer-friendly, product-focused",
    "- Visual quality: crisp studio lighting, sharp product detail, smooth cinematic motion, realistic product rendering",
    "- Camera: smooth dolly shots, macro close-ups, soft parallax, controlled product rotation, no shaky movement",
    "- Background: clean white/light gray studio or tidy workbench environment; subtle color accents are okay only if they do not distract from the item",
    "- Product accuracy: keep the product exactly aligned with the provided listing photos and facts. Preserve color, materials, shape, connectors, ports, prongs, labels, included parts, and visible identifiers.",
    "",
    "IMPORTANT CREATIVE INSTRUCTION:",
    "Read the full eBay listing data below before deciding the scenes and on-screen callouts. Use only facts that appear in the title, item specifics, listing photos, or full listing description. Make the video promotional and fun, but do not invent features, compatibility, guarantees, discounts, shipping claims, ratings, review counts, scarcity, or performance claims.",
    "",
    "PRODUCT DATA FROM EBAY LISTING:",
    `- Title: ${brief.title}`,
    `- SKU: ${brief.sku}`,
    `- eBay item ID: ${brief.platformItemId}`,
    brief.listingUrl ? `- eBay listing URL: ${brief.listingUrl}` : null,
    brief.condition ? `- Condition: ${brief.condition}` : null,
    brief.category ? `- Category: ${brief.category}` : null,
    brand ? `- Brand/manufacturer from listing: ${brand}` : null,
    mpn ? `- Part number / MPN from listing: ${mpn}` : null,
    brief.upc ? `- UPC: ${brief.upc}` : null,
    brief.weight ? `- Stored item weight: ${brief.weight}` : null,
    brief.inventory != null ? `- Current stored inventory: ${brief.inventory}` : null,
    "",
    "ITEM SPECIFICS RETURNED BY EBAY:",
    formatSpecificsForPrompt(specifics),
    "",
    "LISTING PHOTO REFERENCES:",
    "Use the provided image-to-video source image as the primary visual reference. If the generation tool can use multiple references, use these listing photo URLs as additional references:",
    formatPhotoUrlsForPrompt(brief.imageUrls),
    "",
    "FULL EBAY LISTING DESCRIPTION:",
    description ?? "No full listing description was returned by eBay for this item. Build the ad only from title, photos, category, condition, and item specifics.",
    "",
    "SCENE-BY-SCENE TIMELINE:",
    "0:00-0:02 - Hero reveal: open with the real product centered on a clean tabletop. Use a smooth push-in or slide-in. Show the whole item clearly so the shopper instantly understands what is being sold.",
    "On-screen text: choose a short hook based on the listing, such as the product type, replacement purpose, compatibility need, or problem it solves. Keep it 3-6 words.",
    "",
    "0:02-0:04 - Product identity: cut to a clean close-up of the most recognizable part of the item. Show shape, finish, connectors, ports, included cable, buttons, labels, or other visible identifiers from the photos.",
    "On-screen text: the exact product type from the listing title, shortened for readability.",
    "",
    "0:04-0:07 - Compatibility / use case: show the product in a realistic, marketplace-safe context that matches the listing description. If the listing names compatible models, display only those names. If compatibility is uncertain, use a generic use-case shot without model claims.",
    "On-screen text: one concise compatibility or use-case callout from the listing facts.",
    "",
    "0:07-0:10 - Feature close-ups: show 2-3 quick macro moments based on the listing description and item specifics. Examples: connector detail, cable length, foldaway prongs, included parts, material, color, size, control buttons, mounting points, or other physical details. Only include details that are visible or stated.",
    "On-screen text: short feature phrases, maximum 3-5 words each.",
    "",
    "0:10-0:12 - Buyer confidence: make the item feel easy to understand and easy to choose. Use clean animated callouts or simple icons tied to real listing facts such as condition, included quantity, compatibility warning, or package contents. Do not show fake badges.",
    "On-screen text: one useful fact from the description, not a hype claim.",
    "",
    "0:12-0:14 - Final beauty shot: return to the product arranged neatly and fully visible. Use subtle reflection, clean lighting, and a stable composition suitable for eBay/Amazon sponsored product video.",
    "On-screen text: a concise purchase-oriented line based on the product, for example 'Ready to replace' or 'Get back to use' only if it fits the listing.",
    "",
    "0:14-0:15 - End card: keep the product visible with a clean final CTA. No price, no star ratings, no review counts.",
    "On-screen text: 'Available from The Perfect Part' plus one short listing-accurate phrase.",
    "",
    "TEXT OVERLAY STYLE:",
    "- Use clean bold sans-serif typography",
    "- Use dark charcoal text on light backgrounds or white text on dark product close-ups",
    "- Keep text large, readable, and inside the safe center area of the 16:9 frame",
    "- Use no more than one main text phrase per scene",
    "- Do not overcrowd the frame or cover important product details",
    "",
    "VISUAL DETAILS TO EMPHASIZE:",
    "- The exact product shown in the listing photos",
    "- The strongest buyer-relevant facts from the listing description",
    "- Any compatibility, package contents, dimensions, color, material, quantity, condition, or warning that is explicitly stated",
    "- Clean product readability for shoppers scrolling with sound off",
    "",
    "MARKETPLACE COMPLIANCE:",
    "- Do not show official marketplace logos, OEM logos, or brand logos unless they visibly exist on the actual product photo",
    "- Do not imply the product is official/OEM unless the listing explicitly says so",
    "- Do not show prices, coupons, discounts, shipping speed, delivery promises, returns promises, reviews, ratings, or sold-count badges",
    "- Do not create before/after claims, safety claims, performance claims, warranty claims, or technical certifications unless explicitly present in the listing description",
    "",
    "FINAL STYLE:",
    "A polished eBay/Amazon sponsored-product style advertisement with clean studio product shots, smooth motion, clear muted-autoplay text, accurate product details, and a trustworthy value-focused tone.",
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

function buildSalesCoverage(args: {
  window: VideoWindow;
  source: VideoSalesCoverage["source"];
  from: Date;
  to: Date;
  latestOrderDate: Date | null;
  itemCount: number;
  message?: string | null;
}): VideoSalesCoverage {
  const latestOrderDate = args.latestOrderDate?.toISOString() ?? null;
  const hasCurrentWindowData = args.itemCount > 0;
  const isStale = args.source === "database" && (!args.latestOrderDate || args.latestOrderDate < args.from);
  const latestText = args.latestOrderDate
    ? args.latestOrderDate.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return {
    window: args.window,
    source: args.source,
    requestedFrom: args.from.toISOString(),
    requestedTo: args.to.toISOString(),
    latestOrderDate,
    hasCurrentWindowData,
    isStale,
    message: args.message ?? (isStale
      ? latestText
        ? `TPP sales data is stale for the selected ${args.window.toUpperCase()} window. Latest stored TPP sale is ${latestText}; refresh Revenue/Sync before trusting top-performer rankings.`
        : `No stored TPP sales lines were found. Refresh Revenue/Sync before building top-performer rankings.`
      : hasCurrentWindowData
        ? null
        : `No TPP sales lines were found inside the selected ${args.window.toUpperCase()} window.`),
  };
}

function aggregateVideoSaleLines(lines: SaleLine[]): MutableItem[] {
  const items = new Map<string, MutableItem>();
  for (const line of lines) {
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

  return [...items.values()];
}

async function getLiveTppVideoRankings(window: VideoWindow, limit: number) {
  const integration = await db.integration.findFirst({
    where: { platform: "TPP_EBAY", enabled: true },
    select: { platform: true, label: true, config: true },
  });
  if (!integration) {
    return { ranked: [] as MutableItem[], latestOrderDate: null as Date | null };
  }

  const fetched = await fetchMarketplaceSales(integration, daysForWindow(window));
  const liveLines: SaleLine[] = fetched.lines
    .filter((line) => !line.isCancelled && !line.isReturn)
    .map((line) => ({
      marketplaceSaleOrderId: line.externalOrderId,
      masterRowId: null,
      sku: line.sku,
      title: line.title,
      platformItemId: line.platformItemId ?? null,
      quantity: line.quantity,
      unitPriceAmount: line.unitPriceAmount ?? null,
      grossRevenueAmount: line.grossRevenueAmount ?? null,
      netRevenueAmount: line.netRevenueAmount ?? null,
    }));

  const latestOrderDate = fetched.lines.reduce<Date | null>((latest, line) => {
    if (!latest || line.orderDate > latest) return line.orderDate;
    return latest;
  }, null);

  return {
    ranked: aggregateVideoSaleLines(liveLines)
      .sort((a, b) => b.unitsSold - a.unitsSold || b.grossRevenue - a.grossRevenue)
      .slice(0, limit),
    latestOrderDate,
  };
}

export async function getTopTppVideoItems(window: VideoWindow, limit = 30): Promise<VideoTopItemsResult> {
  const from = startDateForWindow(window);
  const to = new Date();
  const latestLine = await db.marketplaceSaleLine.findFirst({
    where: {
      platform: "TPP_EBAY",
      isCancelled: false,
      isReturn: false,
    },
    select: { orderDate: true },
    orderBy: { orderDate: "desc" },
  });

  const lines = await db.marketplaceSaleLine.findMany({
    where: {
      platform: "TPP_EBAY",
      orderDate: { gte: from, lte: to },
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

  let source: VideoSalesCoverage["source"] = "database";
  let latestOrderDate = latestLine?.orderDate ?? null;
  let coverageMessage: string | null = null;
  let ranked = aggregateVideoSaleLines(lines as SaleLine[])
    .sort((a, b) => b.unitsSold - a.unitsSold || b.grossRevenue - a.grossRevenue)
    .slice(0, limit);

  if (ranked.length === 0 && (!latestLine?.orderDate || latestLine.orderDate < from)) {
    try {
      const live = await getLiveTppVideoRankings(window, limit);
      if (live.ranked.length > 0) {
        ranked = live.ranked;
        source = "live_ebay";
        latestOrderDate = live.latestOrderDate;
        coverageMessage = `Rankings fetched live from eBay GetOrders for the selected ${window.toUpperCase()} window because stored TPP revenue data is stale.`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Live eBay GetOrders fetch failed.";
      coverageMessage = `Stored TPP revenue data is stale, and live eBay GetOrders fallback failed: ${message}`;
    }
  }

  if (ranked.length === 0) {
    return {
      items: [],
      coverage: buildSalesCoverage({
        window,
        source,
        from,
        to,
        latestOrderDate,
        itemCount: 0,
        message: coverageMessage,
      }),
    };
  }

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
      grossRevenue: item.grossRevenue > 0 ? item.grossRevenue : item.unitsSold * (listing?.salePrice ?? 0),
      netRevenue: item.hasMissingNetData ? null : item.netRevenueKnown,
      orderCount: item.orderIds.size,
      salePrice: listing?.salePrice ?? null,
      inventory: listing?.inventory ?? null,
      listingUrl: ebayListingUrl(listing?.platformItemId ?? [...item.platformItemIds][0]),
      hasListingDescription: Boolean(stripHtml(firstString([asRecord(listing?.rawData)?.Description]))),
      photoCount: photos.size,
    };
  });

  return {
    items: revenueRows,
    coverage: buildSalesCoverage({
      window,
      source,
      from,
      to,
      latestOrderDate,
      itemCount: revenueRows.length,
      message: coverageMessage,
    }),
  };
}

async function fetchFullListingPayloadForVideoBrief(listing: { platformItemId: string }) {
  const integration = await db.integration.findFirst({
    where: { platform: "TPP_EBAY" },
    select: { id: true, platform: true, config: true, enabled: true },
  });
  if (!integration?.enabled) return null;

  return fetchEbayTppFullItemDirect(
    {
      id: integration.id,
      platform: integration.platform,
      config: integration.config as Record<string, unknown>,
    },
    listing.platformItemId,
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

  const liveRawData = await fetchFullListingPayloadForVideoBrief(listing).catch((error) => {
    console.warn("[video] Full eBay GetItem fetch failed before prompt build", error);
    return null;
  });

  return buildVideoListingBriefFromListing(listing, liveRawData);
}

function buildVideoListingBriefFromListing(
  listing: VideoListingRecord,
  rawDataOverride?: unknown | null,
): VideoListingBrief {
  const sourceRawData = rawDataOverride ?? listing.rawData;
  const raw = asRecord(sourceRawData);
  const specifics = getItemSpecifics(sourceRawData);
  const images = new Set<string>();
  if (listing.imageUrl) images.add(listing.imageUrl);
  if (listing.masterRow.imageUrl) images.add(listing.masterRow.imageUrl);
  for (const url of getPictureUrls(sourceRawData)) images.add(url);

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
