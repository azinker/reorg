import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fetchEbayTppFullItemDirect } from "@/lib/services/ebay-tpp-sync";
import { fetchMarketplaceSales } from "@/lib/inventory-forecast/marketplace-sales";

const LEGACY_DOP_ENDPOINT = "/v1/image2video/dop";
const LEGACY_DOP_MODEL = "dop-turbo";
const DEFAULT_VIDEO_ENDPOINT = "/higgsfield-ai/dop/standard";
const DEFAULT_VIDEO_MODEL = "Hyper Motion";
const DEFAULT_VIDEO_DURATION_SECONDS = 15;
const MAX_HIGGSFIELD_PROMPT_LENGTH = 2200;
const VIDEO_ASPECT_RATIO = "16:9";
const VIDEO_RESOLUTION = "1080p";
const VIDEO_SIZE = "1920x1080";
const HIGGSFIELD_CREDITS_PER_USD = 16;
const DOP_CREDITS_PER_5_SECONDS = {
  lite: 2,
  turbo: 6.5,
  standard: 9,
  preview: 9,
} as const;
const LEGACY_UNAVAILABLE_VIDEO_MODELS = new Set([
  "bytedance/seedance/v1/pro/image-to-video",
]);

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
    estimatedCredits: number | null;
    estimatedUsd: number | null;
    creditEstimateNote: string;
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
  id?: string;
  status?: string;
  request_id?: string;
  status_url?: string;
  cancel_url?: string;
  video?: { url?: string };
  images?: Array<{ url?: string }>;
  url?: string;
};

type HiggsfieldCreditEstimate = {
  credits: number | null;
  usd: number | null;
  note: string;
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
  const configured = process.env.HIGGSFIELD_VIDEO_MODEL?.trim();
  if (!configured || LEGACY_UNAVAILABLE_VIDEO_MODELS.has(configured)) return LEGACY_DOP_MODEL;
  return configured;
}

function getHiggsfieldVideoEndpoint() {
  const configured = process.env.HIGGSFIELD_VIDEO_ENDPOINT?.trim();
  if (configured) return configured.startsWith("/") ? configured : `/${configured}`;
  return DEFAULT_VIDEO_ENDPOINT;
}

function buildHiggsfieldUrl(endpoint: string) {
  const baseUrl = (process.env.HIGGSFIELD_BASE_URL || "https://platform.higgsfield.ai").replace(/\/+$/, "");
  return `${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
}

function isLegacyDopEndpoint(endpoint: string) {
  return endpoint.replace(/\/+$/, "") === LEGACY_DOP_ENDPOINT;
}

function isCurrentDopEndpoint(endpoint: string) {
  return endpoint.replace(/\/+$/, "").startsWith("/higgsfield-ai/dop/");
}

function getDisplayModelId(endpoint = getHiggsfieldVideoEndpoint()) {
  if (isLegacyDopEndpoint(endpoint)) return getVideoModelId();
  if (isCurrentDopEndpoint(endpoint)) return DEFAULT_VIDEO_MODEL;
  return getVideoModelId();
}

function getHiggsfieldDuration(endpoint: string, requestedDuration: number | undefined) {
  return Math.min(20, Math.max(15, requestedDuration ?? DEFAULT_VIDEO_DURATION_SECONDS));
}

function inferDopPricingTier(endpoint: string) {
  const normalized = endpoint.toLowerCase();
  if (normalized.includes("/lite")) return "lite";
  if (normalized.includes("/turbo")) return "turbo";
  if (normalized.includes("/preview")) return "preview";
  if (normalized.includes("/standard")) return "standard";
  if (isLegacyDopEndpoint(endpoint)) return "turbo";
  return null;
}

function roundCredits(value: number) {
  return Math.round(value * 10) / 10;
}

function estimateHiggsfieldCredits(endpoint: string, duration: number): HiggsfieldCreditEstimate {
  const tier = inferDopPricingTier(endpoint);
  if (!tier) {
    return {
      credits: null,
      usd: null,
      note: "Credit estimate unavailable for this Higgsfield model.",
    };
  }

  const credits = roundCredits((DOP_CREDITS_PER_5_SECONDS[tier] * duration) / 5);
  return {
    credits,
    usd: Math.round((credits / HIGGSFIELD_CREDITS_PER_USD) * 100) / 100,
    note: `Estimated from Higgsfield Cloud/API DoP ${tier} pricing at ${DOP_CREDITS_PER_5_SECONDS[tier]} credits per 5 seconds. This uses Cloud API credits, not the higgsfield.ai subscription credits. Higgsfield does not expose API-key balance in the public API docs.`,
  };
}

function formatCreditEstimate(estimate: HiggsfieldCreditEstimate) {
  if (estimate.credits == null) return "an unknown number of credits";
  const usd = estimate.usd == null ? "" : `, about $${estimate.usd.toFixed(2)}`;
  return `${estimate.credits.toLocaleString()} credits${usd}`;
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

function cleanPromoFact(value: string) {
  return value
    .replace(/^\s*[-*]+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function promoFactsFromDescription(description: string | null) {
  if (!description) return [];
  const rejected = /shipping|money back|guarantee|contact us|refund|replacement|ships|same day|business day|risk free|purchase/i;
  return description
    .split(/\r?\n/)
    .map(cleanPromoFact)
    .filter((line) => line.length >= 24 && line.length <= 180)
    .filter((line) => !rejected.test(line))
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 6);
}

function productTypeFromTitle(title: string) {
  const lower = title.toLowerCase();
  if (lower.includes("cd") && lower.includes("dvd") && lower.includes("drive")) return "external CD/DVD drive";
  if (lower.includes("laser")) return "laser pointer";
  if (lower.includes("antenna")) return "digital antenna";
  if (lower.includes("sd card") || lower.includes("memory card")) return "memory card";
  if (lower.includes("washer")) return "portable washer";
  return "product";
}

function buildVideoPrompt(brief: Omit<VideoListingBrief, "prompt" | "negativePrompt" | "generationSettings">) {
  const specifics = brief.itemSpecifics;
  const productType = productTypeFromTitle(brief.title);
  const brand = getSpecificValue(specifics, ["Brand", "Manufacturer"]);
  const color = getSpecificValue(specifics, ["Color"]);
  const material = getSpecificValue(specifics, ["Material"]);
  const promoFacts = [
    brand ? `Brand/manufacturer: ${brand}` : null,
    color ? `Color: ${color}` : null,
    material ? `Material: ${material}` : null,
    ...promoFactsFromDescription(brief.descriptionText),
  ].filter(Boolean).slice(0, 7);

  return [
    "Create a 15-second Hyper Motion promotional product video.",
    "",
    "FORMAT:",
    `- Format: ${VIDEO_ASPECT_RATIO} horizontal widescreen`,
    `- Resolution: ${VIDEO_SIZE}, ${VIDEO_RESOLUTION.toUpperCase()} Full HD`,
    "- Duration: exactly 15 seconds",
    "- Audio: no voiceover and no spoken script; must work perfectly muted",
    "",
    "HYPER MOTION STYLE:",
    "- Pure CGI product commercial with the product as the hero",
    "- Dynamic camera moves, premium lighting, clean reflections, physics-driven VFX, and fast ad-editing energy",
    "- No people, no hands, no UGC, no real-life testimonial footage, no unboxing host",
    "- Make it feel like a premium tech/product launch spot, not a literal eBay listing recap",
    "",
    "PRODUCT TO PROMOTE:",
    `- Product: ${brief.title}`,
    `- Product type: ${productType}`,
    brief.condition ? `- Condition: ${brief.condition}` : null,
    promoFacts.length > 0 ? "- Useful product facts:" : null,
    ...promoFacts.map((fact) => `  - ${fact}`),
    "",
    "VISUAL RULES:",
    "- Use the listing product photo as the visual reference for shape, color, ports, labels, included parts, and proportions",
    "- Show only the product and abstract/premium product-ad environments",
    "- Do not invent brand marks, compatibility, certifications, discounts, reviews, shipping promises, warranties, or performance claims",
    "- Keep text overlays short, clean, and promotional; avoid tiny technical copy",
    "",
    "15-SECOND SHOT PLAN:",
    `0:00-0:03 - Hyper Motion hero reveal of the ${productType}: product emerges from sleek light streaks or a clean CGI surface, centered and instantly readable.`,
    "0:03-0:06 - Dynamic orbit and macro close-ups that emphasize the most recognizable physical details from the photo.",
    "0:06-0:10 - Fast, polished product-ad motion: floating parts, light trails, subtle particles, and smooth transitions that make the item feel premium.",
    "0:10-0:13 - Practical value moment: visualize what the product does using abstract CGI icons or simple environment cues, without showing people.",
    "0:13-0:15 - Final beauty pack shot with the product fully visible and one clean CTA-style text phrase.",
    "",
    "FINAL FEEL:",
    "A scroll-stopping Hyper Motion product ad: premium, energetic, product-only, CGI-driven, accurate to the listing photos, and clearly promotional.",
  ].filter(Boolean).join("\n");
}

function buildNegativePrompt() {
  return [
    "No fake logos, no invented brand marks, no wrong part numbers, no distorted connectors, no extra ports, no impossible fitment claims.",
    "No price tags, coupons, star ratings, review claims, shipping promises, warranty claims, or before/after claims.",
    "No people, no hands, no UGC, no testimonial footage, no cluttered text, no unreadable tiny captions, no heavy motion blur, no warped product geometry.",
  ].join(" ");
}

function buildHiggsfieldGenerationPrompt(brief: VideoListingBrief) {
  return brief.prompt.length <= MAX_HIGGSFIELD_PROMPT_LENGTH
    ? brief.prompt
    : `${brief.prompt.slice(0, MAX_HIGGSFIELD_PROMPT_LENGTH - 1).trimEnd()}.`;
}

function buildHiggsfieldRequestBody(args: {
  endpoint: string;
  brief: VideoListingBrief;
  duration: number;
  modelId: string;
}) {
  const prompt = buildHiggsfieldGenerationPrompt(args.brief);
  if (isLegacyDopEndpoint(args.endpoint)) {
    return {
      model: args.modelId,
      prompt,
      input_images: [
        {
          type: "image_url",
          image_url: args.brief.imageUrls[0],
        },
      ],
      duration: args.duration,
      enhance_prompt: true,
      check_nsfw: true,
    };
  }

  if (isCurrentDopEndpoint(args.endpoint)) {
    return {
      image_url: args.brief.imageUrls[0],
      prompt,
      duration: args.duration,
    };
  }

  return {
    image_url: args.brief.imageUrls[0],
    prompt,
    duration: args.duration,
  };
}

function normalizeHiggsfieldError(body: unknown, fallback: string) {
  const record = asRecord(body);
  const direct = firstString([record?.error, record?.message, record?.detail]);
  if (direct) return direct;
  if (record?.detail || record?.errors) {
    try {
      return `Higgsfield validation failed: ${JSON.stringify(record.detail ?? record.errors)}`;
    } catch {
      return "Higgsfield validation failed.";
    }
  }
  return fallback;
}

export function getHiggsfieldConnectionStatus(): HiggsfieldConnectionStatus {
  const authMode = getAuthMode();
  return {
    configured: authMode !== "missing",
    authMode,
    modelId: getDisplayModelId(),
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
  const endpoint = getHiggsfieldVideoEndpoint();
  const duration = getHiggsfieldDuration(endpoint, DEFAULT_VIDEO_DURATION_SECONDS);
  const creditEstimate = estimateHiggsfieldCredits(endpoint, duration);

  return {
    ...briefBase,
    prompt: buildVideoPrompt(briefBase),
    negativePrompt,
    generationSettings: {
      modelId: getDisplayModelId(),
      quality: VIDEO_RESOLUTION,
      size: VIDEO_SIZE,
      aspectRatio: VIDEO_ASPECT_RATIO,
      durationSeconds: duration,
      estimatedCredits: creditEstimate.credits,
      estimatedUsd: creditEstimate.usd,
      creditEstimateNote: creditEstimate.note,
      formatGuidance:
        "Hyper Motion product ads are generated as 15-second, product-only CGI promotional videos from the selected listing photo.",
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

  const endpoint = getHiggsfieldVideoEndpoint();
  const duration = getHiggsfieldDuration(endpoint, args.durationSeconds);
  const modelId = getDisplayModelId(endpoint);
  const requestBody = buildHiggsfieldRequestBody({ endpoint, brief, duration, modelId });
  const response = await fetch(buildHiggsfieldUrl(endpoint), {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  const json = (await response.json().catch(() => null)) as HiggsfieldQueuedResponse | null;
  if (!response.ok) {
    const message = normalizeHiggsfieldError(json, `Higgsfield request failed with status ${response.status}.`);
    if (/not_enough_credits/i.test(message)) {
      const estimate = estimateHiggsfieldCredits(endpoint, duration);
      throw new Error(
        `Higgsfield says not_enough_credits. This ${duration}s ${modelId} request is estimated at ${formatCreditEstimate(estimate)} and uses Higgsfield Cloud/API credits, not higgsfield.ai subscription credits. Add credits in Higgsfield Cloud, then retry.`,
      );
    }
    throw new Error(message);
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
        endpoint,
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

  const response = await fetch(buildHiggsfieldUrl(`/requests/${encodeURIComponent(requestId)}/status`), {
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
