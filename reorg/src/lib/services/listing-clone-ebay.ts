/**
 * eBay Trading API listing clone (cross-account fixed-price): GetItem → scrub →
 * target business policies → optional EPS picture re-upload → Verify / AddFixedPriceItem.
 *
 * Used by Listing Clone UI + optional CLI wrapper.
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import {
  buildEbayConfig,
  getEbayAccessToken,
  type EbayConfig,
} from "@/lib/services/helpdesk-ebay";

const TRADING_API = "https://api.ebay.com/ws/api.dll";
const SITE_ID = "0";
const COMPAT_LEVEL = "1199";
const REQUEST_TIMEOUT_MS = 120_000;
const TRADING_UPLOAD_TIMEOUT_MS = 240_000;
const MARKETPLACE_ID = "EBAY_US";

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (tagName: string) =>
    [
      "Item",
      "Variation",
      "NameValueList",
      "PictureURL",
      "VariationSpecificPictureSet",
      "Compatibility",
      "Errors",
      "Error",
    ].includes(tagName),
});

const builder = new XMLBuilder({
  ignoreAttributes: true,
  format: true,
  suppressEmptyNode: true,
  textNodeName: "#text",
});

export const EBAY_LISTING_CLONE_PLATFORMS = [
  Platform.TPP_EBAY,
  Platform.TT_EBAY,
] as const;

export type EbayListingClonePlatform = (typeof EBAY_LISTING_CLONE_PLATFORMS)[number];

export interface ListingCloneEbayOptions {
  skipPictureUpload?: boolean;
  /** Listing-level ItemSpecifics "Type" aspect when category requires it */
  itemTypeAspect?: string;
  shippingPolicyId?: string;
  returnPolicyId?: string;
  paymentPolicyId?: string;
  /** Existing listing on the target account to read SellerProfiles from */
  policySourceItemId?: string;
}

export interface ListingCloneEbayPayloadSummary {
  title: string;
  sourceItemId: string;
  pictureUrlCount: number;
  listingSpecificRowCount: number;
  hasVariations: boolean;
  variationCount: number;
}

export interface ListingCloneVerifyResult {
  ok: boolean;
  ack: string;
  errors: string[];
  fees?: unknown;
  summary: ListingCloneEbayPayloadSummary;
}

export interface ListingCloneExecuteResult extends ListingCloneVerifyResult {
  newItemId?: string;
}

const DROP_TOP_LEVEL_KEYS = new Set([
  "ItemID",
  "ListingDetails",
  "SellingStatus",
  "Seller",
  "WantItNowExpiringDate",
  "HitCounter",
  "DisableBuyerRequirements",
  "LocationDefaulted",
  "HideFromSearch",
  "QuestionCount",
  "LeadCount",
  "HitCount",
  "QuantityThresholdWarning",
  "IntegratedMerchantCreditCardEnabled",
  "PicturePackTemplateItemCount",
  "ProxyItem",
  "BuyerResponsibleForShipping",
  "CorporateSeller",
  "SellerProfiles",
]);

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

const IMAGE_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MIN_DOWNLOADED_JPEG_BYTES = 4096;

async function fetchJpegBytesFromCandidates(
  externalUrl: string,
): Promise<{ bytes: Buffer; usedUrl: string }> {
  const tries = pictureUploadCandidates(externalUrl);
  let lastErr = "";
  for (const url of tries) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: "image/*", "User-Agent": IMAGE_FETCH_UA },
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) {
          lastErr = `HTTP ${response.status}`;
          break;
        }
        const buf = Buffer.from(await response.arrayBuffer());
        if (buf.length < MIN_DOWNLOADED_JPEG_BYTES) {
          lastErr = `too small (${buf.length} bytes)`;
          break;
        }
        if (buf[0] !== 0xff || buf[1] !== 0xd8) {
          lastErr = "not JPEG magic";
          break;
        }
        return { bytes: buf, usedUrl: url };
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      }
    }
  }
  throw new Error(
    `Could not download a real JPEG for ${externalUrl} (${tries.length} tries). Last: ${lastErr}`,
  );
}

async function tradingCallUploadSiteHostedPicturesMultipart(
  integrationId: string,
  config: EbayConfig,
  pictureName: string,
  imageBytes: Buffer,
): Promise<{ xml: string; parsed: Record<string, unknown> }> {
  const token = await getEbayAccessToken(integrationId, config);
  const safeName = pictureName.replace(/[^\w.-]+/g, "_");
  const xmlPart = `<?xml version="1.0" encoding="utf-8"?>
<UploadSiteHostedPicturesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <PictureName>${escapeXml(safeName)}</PictureName>
  <PictureSet>Standard</PictureSet>
</UploadSiteHostedPicturesRequest>`;
  const filename = `${safeName}.jpg`;
  const boundary = `----reorgEps${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const crlf = "\r\n";
  const head =
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="XML Payload"${crlf}${crlf}` +
    xmlPart +
    crlf +
    `--${boundary}${crlf}` +
    `Content-Disposition: form-data; name="${safeName}"; filename="${filename}"${crlf}` +
    `Content-Type: image/jpeg${crlf}${crlf}`;
  const tail = `${crlf}--${boundary}--${crlf}`;
  const headBuf = Buffer.from(head, "utf8");
  const tailBuf = Buffer.from(tail, "utf8");
  const body = Buffer.concat([headBuf, imageBytes, tailBuf]);

  const response = await fetchWithTimeout(
    TRADING_API,
    {
      method: "POST",
      headers: {
        "X-EBAY-API-IAF-TOKEN": token,
        "X-EBAY-API-SITEID": SITE_ID,
        "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
        "X-EBAY-API-CALL-NAME": "UploadSiteHostedPictures",
        "X-EBAY-API-RESPONSE-ENCODING": "XML",
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body: body as unknown as BodyInit,
    },
    TRADING_UPLOAD_TIMEOUT_MS,
  );
  const xml = response.body;
  if (!response.ok) {
    throw new Error(`UploadSiteHostedPictures HTTP ${response.status}: ${xml.slice(0, 500)}`);
  }
  const parsed = parser.parse(xml) as Record<string, unknown>;
  return { xml, parsed };
}

async function tradingCall(
  integrationId: string,
  config: EbayConfig,
  callName: string,
  innerXml: string,
): Promise<{ xml: string; parsed: Record<string, unknown> }> {
  const token = await getEbayAccessToken(integrationId, config);
  const doc = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
${innerXml}
</${callName}Request>`;

  const response = await fetchWithTimeout(TRADING_API, {
    method: "POST",
    headers: {
      "X-EBAY-API-IAF-TOKEN": token,
      "X-EBAY-API-SITEID": SITE_ID,
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPAT_LEVEL,
      "X-EBAY-API-CALL-NAME": callName,
      "Content-Type": "text/xml",
    },
    body: doc,
  });

  const xml = response.body;
  if (!response.ok) {
    throw new Error(`${callName} HTTP ${response.status}: ${xml.slice(0, 500)}`);
  }

  const parsed = parser.parse(xml) as Record<string, unknown>;
  return { xml, parsed };
}

function readAck(root: Record<string, unknown> | undefined): string {
  return String(root?.Ack ?? "").trim();
}

function readErrors(root: Record<string, unknown> | undefined): string[] {
  const raw = root?.Errors;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return (list as Array<Record<string, unknown>>).map(
    (e) =>
      String(e.LongMessage ?? e.ShortMessage ?? e.message ?? JSON.stringify(e)),
  );
}

export async function getItemFullForClone(
  integrationId: string,
  config: EbayConfig,
  itemId: string,
): Promise<Record<string, unknown>> {
  const inner = `<ItemID>${escapeXml(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
  <IncludeItemSpecifics>true</IncludeItemSpecifics>
  <IncludeItemCompatibilityList>true</IncludeItemCompatibilityList>`;
  const { parsed } = await tradingCall(integrationId, config, "GetItem", inner);
  const resp = parsed.GetItemResponse as Record<string, unknown> | undefined;
  const ack = readAck(resp);
  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(`GetItem failed: ${readErrors(resp).join("; ") || ack}`);
  }
  const rawItem = resp?.Item;
  const item = Array.isArray(rawItem) ? rawItem[0] : rawItem;
  if (!item || typeof item !== "object") {
    throw new Error("GetItem returned no Item payload");
  }
  return item as Record<string, unknown>;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collectPictureUrls(item: Record<string, unknown>): Set<string> {
  const urls = new Set<string>();
  const pushUrl = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//i.test(v)) urls.add(v.trim());
  };

  const picDetails = item.PictureDetails as Record<string, unknown> | undefined;
  const pu = picDetails?.PictureURL;
  if (pu) {
    const arr = Array.isArray(pu) ? pu : [pu];
    for (const u of arr) pushUrl(u);
  }

  const vars = item.Variations as Record<string, unknown> | undefined;
  const picsNode = vars?.Pictures as Record<string, unknown> | undefined;
  const varPicSets = picsNode?.VariationSpecificPictureSet;
  const sets = Array.isArray(varPicSets) ? varPicSets : varPicSets ? [varPicSets] : [];
  for (const set of sets as Array<Record<string, unknown>>) {
    const vpu = set.PictureURL;
    const arr = Array.isArray(vpu) ? vpu : vpu ? [vpu] : [];
    for (const u of arr) pushUrl(u);
  }

  return urls;
}

function rewritePictureUrls(root: unknown, map: Map<string, string>): void {
  if (root == null) return;
  if (typeof root === "string") return;
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      const v = root[i];
      if (typeof v === "string") {
        const n = map.get(v);
        if (n) root[i] = n;
      } else rewritePictureUrls(v, map);
    }
    return;
  }
  if (typeof root === "object") {
    const o = root as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string") {
        const n = map.get(v);
        if (n) o[k] = n;
      } else rewritePictureUrls(v, map);
    }
  }
}

function ebaySl1600Candidate(externalUrl: string): string | null {
  try {
    const u = new URL(externalUrl);
    if (!u.hostname.includes("ebayimg.com")) return null;
    const m = u.pathname.match(/\/z\/([^/]+)\//);
    const token = m?.[1]?.trim();
    if (!token) return null;
    return `https://i.ebayimg.com/images/g/${token}/s-l1600.jpg`;
  } catch {
    return null;
  }
}

function pictureUploadCandidates(externalUrl: string): string[] {
  const trimmed = externalUrl.trim();
  const sl1600 = ebaySl1600Candidate(trimmed);
  const noQuery = trimmed.split("?")[0];
  const variants = [
    ...(sl1600 ? [sl1600] : []),
    trimmed,
    noQuery,
    noQuery.replace(/\$_\d+\.(jpe?g)$/i, "$_64.$1"),
    noQuery.replace(/\$_\d+\.(jpe?g)$/i, "$_12.$1"),
  ];
  return [...new Set(variants.filter(Boolean))];
}

function readSiteHostedPictureFullUrl(parsed: Record<string, unknown>): string {
  const resp = parsed.UploadSiteHostedPicturesResponse as Record<string, unknown> | undefined;
  const ack = readAck(resp);
  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(readErrors(resp).join("; ") || `Ack=${ack}`);
  }
  const details = resp?.SiteHostedPictureDetails as Record<string, unknown> | undefined;
  const full = details?.FullURL;
  if (typeof full !== "string" || !full.startsWith("http")) {
    throw new Error(`missing FullURL`);
  }
  return full.trim();
}

async function uploadSiteHostedPictureOnce(
  targetIntegrationId: string,
  targetConfig: EbayConfig,
  externalUrl: string,
  idx: number,
): Promise<string> {
  const inner = `<ExternalPictureURL>${escapeXml(externalUrl)}</ExternalPictureURL>
  <PictureName>clone_${idx}</PictureName>`;
  const { parsed } = await tradingCall(
    targetIntegrationId,
    targetConfig,
    "UploadSiteHostedPictures",
    inner,
  );
  return readSiteHostedPictureFullUrl(parsed);
}

const EPS_MULTIPART_POST_ATTEMPTS = 5;

async function uploadSiteHostedPicture(
  targetIntegrationId: string,
  targetConfig: EbayConfig,
  externalUrl: string,
  idx: number,
): Promise<string> {
  const pictureName = `clone_${idx}`;
  try {
    const { bytes, usedUrl } = await fetchJpegBytesFromCandidates(externalUrl);
    console.log(
      `[listing-clone] EPS multipart ${pictureName}: ${bytes.length} bytes from ${usedUrl.slice(0, 100)}`,
    );
    for (let postAttempt = 0; postAttempt < EPS_MULTIPART_POST_ATTEMPTS; postAttempt++) {
      try {
        const { parsed } = await tradingCallUploadSiteHostedPicturesMultipart(
          targetIntegrationId,
          targetConfig,
          pictureName,
          bytes,
        );
        return readSiteHostedPictureFullUrl(parsed);
      } catch (ePost) {
        const why = ePost instanceof Error ? ePost.message : String(ePost);
        const last = postAttempt + 1 >= EPS_MULTIPART_POST_ATTEMPTS;
        if (last) {
          console.warn(
            `[listing-clone] EPS multipart POST failed after ${EPS_MULTIPART_POST_ATTEMPTS} tries (${pictureName}): ${why}`,
          );
          break;
        }
        const backoffMs = 750 * (postAttempt + 1);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  } catch (eDl) {
    const why = eDl instanceof Error ? eDl.message : String(eDl);
    console.warn(
      `[listing-clone] JPEG download failed for ${pictureName}, trying ExternalPictureURL mode only: ${why}`,
    );
  }

  const tries = pictureUploadCandidates(externalUrl);
  let lastMsg = "";
  for (const u of tries) {
    try {
      return await uploadSiteHostedPictureOnce(targetIntegrationId, targetConfig, u, idx);
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(
    `UploadSiteHostedPictures failed for ${externalUrl} after multipart + ${tries.length} URL variants: ${lastMsg}`,
  );
}

function readPolicyText(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function extractProfilesFromItemSellerProfiles(item: Record<string, unknown>): {
  shippingProfileID: string;
  returnProfileID: string;
  paymentProfileID: string;
} | null {
  const sp = item.SellerProfiles;
  if (!sp || typeof sp !== "object") return null;
  const o = sp as Record<string, unknown>;
  const shipNode = o.SellerShippingProfile as Record<string, unknown> | undefined;
  const retNode = o.SellerReturnProfile as Record<string, unknown> | undefined;
  const payNode = o.SellerPaymentProfile as Record<string, unknown> | undefined;
  const shippingProfileID = readPolicyText(shipNode?.ShippingProfileID);
  const returnProfileID = readPolicyText(retNode?.ReturnProfileID);
  const paymentProfileID = readPolicyText(payNode?.PaymentProfileID);
  if (!shippingProfileID || !returnProfileID || !paymentProfileID) return null;
  return { shippingProfileID, returnProfileID, paymentProfileID };
}

function envExplicitPolicies(targetPlatform: EbayListingClonePlatform): {
  ship?: string;
  ret?: string;
  pay?: string;
} {
  if (targetPlatform === Platform.TT_EBAY) {
    return {
      ship: process.env.EBAY_CLONE_TT_SHIPPING_POLICY_ID?.trim(),
      ret: process.env.EBAY_CLONE_TT_RETURN_POLICY_ID?.trim(),
      pay: process.env.EBAY_CLONE_TT_PAYMENT_POLICY_ID?.trim(),
    };
  }
  return {
    ship: process.env.EBAY_CLONE_TPP_SHIPPING_POLICY_ID?.trim(),
    ret: process.env.EBAY_CLONE_TPP_RETURN_POLICY_ID?.trim(),
    pay: process.env.EBAY_CLONE_TPP_PAYMENT_POLICY_ID?.trim(),
  };
}

function envPolicySourceItemId(targetPlatform: EbayListingClonePlatform): string | undefined {
  if (targetPlatform === Platform.TT_EBAY) {
    return process.env.EBAY_CLONE_TT_POLICY_SOURCE_ITEM_ID?.trim();
  }
  return process.env.EBAY_CLONE_TPP_POLICY_SOURCE_ITEM_ID?.trim();
}

async function resolveTargetSellerProfiles(
  targetIntegrationId: string,
  targetConfig: EbayConfig,
  targetPlatform: EbayListingClonePlatform,
  options: ListingCloneEbayOptions,
): Promise<{
  shippingProfileID: string;
  returnProfileID: string;
  paymentProfileID: string;
}> {
  const shipOpt = options.shippingPolicyId?.trim();
  const retOpt = options.returnPolicyId?.trim();
  const payOpt = options.paymentPolicyId?.trim();
  const envP = envExplicitPolicies(targetPlatform);
  const shipEnv = shipOpt ?? envP.ship;
  const retEnv = retOpt ?? envP.ret;
  const payEnv = payOpt ?? envP.pay;
  if (shipEnv && retEnv && payEnv) {
    return {
      shippingProfileID: shipEnv,
      returnProfileID: retEnv,
      paymentProfileID: payEnv,
    };
  }

  const accessToken = await getEbayAccessToken(targetIntegrationId, targetConfig);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  const base = "https://api.ebay.com/sell/account/v1";

  const pickFirstId = (
    json: Record<string, unknown>,
    arrayKey: string,
    idKey: string,
  ): string => {
    const arr = json[arrayKey];
    const list = Array.isArray(arr) ? arr : [];
    const first = list[0] as Record<string, unknown> | undefined;
    const id = first?.[idKey];
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(`Could not resolve ${arrayKey}.${idKey} from Account API`);
    }
    return id.trim();
  };

  const [shipRes, payRes, retRes] = await Promise.all([
    fetchWithTimeout(`${base}/fulfillment_policy?marketplace_id=${MARKETPLACE_ID}`, {
      headers,
    }),
    fetchWithTimeout(`${base}/payment_policy?marketplace_id=${MARKETPLACE_ID}`, {
      headers,
    }),
    fetchWithTimeout(`${base}/return_policy?marketplace_id=${MARKETPLACE_ID}`, {
      headers,
    }),
  ]);

  if (shipRes.ok && payRes.ok && retRes.ok) {
    const shipJson = JSON.parse(shipRes.body) as Record<string, unknown>;
    const payJson = JSON.parse(payRes.body) as Record<string, unknown>;
    const retJson = JSON.parse(retRes.body) as Record<string, unknown>;

    return {
      shippingProfileID:
        shipEnv ?? pickFirstId(shipJson, "fulfillmentPolicies", "fulfillmentPolicyId"),
      paymentProfileID:
        payEnv ?? pickFirstId(payJson, "paymentPolicies", "paymentPolicyId"),
      returnProfileID: retEnv ?? pickFirstId(retJson, "returnPolicies", "returnPolicyId"),
    };
  }

  console.warn(
    `[listing-clone] Account API policy fetch not usable (shipping=${shipRes.status} payment=${payRes.status} return=${retRes.status}); falling back to SellerProfiles from an existing listing.`,
  );

  let sampleItemId =
    options.policySourceItemId?.trim() ?? envPolicySourceItemId(targetPlatform);

  if (!sampleItemId) {
    const row = await db.marketplaceListing.findFirst({
      where: {
        integration: { platform: targetPlatform },
        platformVariantId: null,
        status: "ACTIVE",
      },
      select: { platformItemId: true },
      orderBy: { lastSyncedAt: "desc" },
    });
    sampleItemId = row?.platformItemId ?? undefined;
  }

  if (!sampleItemId) {
    const row2 = await db.marketplaceListing.findFirst({
      where: { integration: { platform: targetPlatform } },
      select: { platformItemId: true },
      orderBy: { lastSyncedAt: "desc" },
    });
    sampleItemId = row2?.platformItemId ?? undefined;
  }

  if (!sampleItemId) {
    throw new Error(
      `Cannot resolve ${targetPlatform} business policies: Account API unavailable AND no policy IDs or sample listing. ` +
        `Set explicit shipping/return/payment policy IDs, or policySourceItemId (an existing listing on the target account).`,
    );
  }

  console.log("[listing-clone] Reading SellerProfiles from target GetItem:", sampleItemId);
  const tgtItem = await getItemFullForClone(targetIntegrationId, targetConfig, sampleItemId);
  const extracted = extractProfilesFromItemSellerProfiles(tgtItem);
  if (!extracted) {
    throw new Error(
      `Target item ${sampleItemId} has no SellerProfiles in GetItem response. Provide explicit policy IDs.`,
    );
  }

  return extracted;
}

function stripBrandMpnNodes(root: unknown): void {
  if (root == null) return;
  if (Array.isArray(root)) {
    for (const el of root) stripBrandMpnNodes(el);
    return;
  }
  if (typeof root !== "object") return;
  const o = root as Record<string, unknown>;
  delete o.BrandMPN;
  for (const k of Object.keys(o)) stripBrandMpnNodes(o[k]);
}

function upsertItemSpecific(item: Record<string, unknown>, name: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  let specifics = item.ItemSpecifics as Record<string, unknown> | undefined;
  if (!specifics || typeof specifics !== "object") {
    specifics = {};
    item.ItemSpecifics = specifics;
  }
  const existing = specifics.NameValueList;
  const rows: Array<Record<string, unknown>> = [];
  if (existing) {
    const arr = Array.isArray(existing) ? existing : [existing];
    for (const row of arr) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const n = String(r.Name ?? "").trim();
      if (n.toLowerCase() !== name.toLowerCase()) rows.push(r);
    }
  }
  rows.push({ Name: name, Value: v });
  specifics.NameValueList = rows.length === 1 ? rows[0] : rows;
}

function normalizeCloneCatalogMetadata(
  item: Record<string, unknown>,
  itemTypeAspect?: string,
): void {
  const pld = item.ProductListingDetails as Record<string, unknown> | undefined;
  if (pld && typeof pld === "object" && pld.BrandMPN && typeof pld.BrandMPN === "object") {
    const bmp = pld.BrandMPN as Record<string, unknown>;
    const brand = typeof bmp.Brand === "string" ? bmp.Brand.trim() : "";
    const mpn = typeof bmp.MPN === "string" ? bmp.MPN.trim() : "";
    delete pld.BrandMPN;
    if (brand) upsertItemSpecific(item, "Brand", brand);
    if (mpn) upsertItemSpecific(item, "MPN", mpn);
  }
  stripBrandMpnNodes(item);
  const typ = itemTypeAspect?.trim();
  if (typ) upsertItemSpecific(item, "Type", typ);
}

function scrubCrossSellerCatalogHints(item: Record<string, unknown>): void {
  const pld = item.ProductListingDetails as Record<string, unknown> | undefined;
  if (!pld || typeof pld !== "object") return;
  const upc =
    typeof pld.UPC === "string" && pld.UPC.trim()
      ? pld.UPC.trim()
      : "Does Not Apply";
  delete pld.IncludeeBayProductDetails;
  delete pld.ProductReferenceID;
  delete pld.ProductDefinition;
  delete pld.EAN;
  delete pld.ISBN;
  delete pld.BrandMPN;
  pld.UPC = upc;
  const keys = Object.keys(pld).filter((k) => {
    const v = pld[k];
    if (v == null) return false;
    if (typeof v === "string" && !v.trim()) return false;
    if (typeof v === "object" && Object.keys(v as object).length === 0) return false;
    return true;
  });
  if (keys.length === 0) delete item.ProductListingDetails;
}

function stripTradingOutputOnlyFromNameValueLists(root: unknown): void {
  if (root == null) return;
  if (Array.isArray(root)) {
    for (const el of root) stripTradingOutputOnlyFromNameValueLists(el);
    return;
  }
  if (typeof root !== "object") return;
  const o = root as Record<string, unknown>;
  if (typeof o.Name === "string" && "Value" in o) {
    delete o.Source;
  }
  for (const k of Object.keys(o)) stripTradingOutputOnlyFromNameValueLists(o[k]);
}

export function listingItemSpecificRowCount(item: Record<string, unknown>): number {
  const specifics = item.ItemSpecifics as Record<string, unknown> | undefined;
  const nvl = specifics?.NameValueList;
  if (!nvl) return 0;
  const arr = Array.isArray(nvl) ? nvl : [nvl];
  return arr.filter((row) => row && typeof row === "object").length;
}

function stripListingForClone(
  item: Record<string, unknown>,
  itemTypeAspect?: string,
): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;

  for (const k of DROP_TOP_LEVEL_KEYS) {
    delete clone[k];
  }

  delete clone.ShippingDetails;
  delete clone.ReturnPolicy;
  delete clone.BuyerRequirementDetails;
  delete clone.ShippingPackageDetails;
  delete clone.ListingDesigner;
  delete clone.ItemCompatibilityCount;

  normalizeCloneCatalogMetadata(clone, itemTypeAspect);
  scrubCrossSellerCatalogHints(clone);
  stripTradingOutputOnlyFromNameValueLists(clone);

  return clone;
}

function attachSellerProfiles(
  item: Record<string, unknown>,
  profiles: {
    shippingProfileID: string;
    returnProfileID: string;
    paymentProfileID: string;
  },
): void {
  item.SellerProfiles = {
    SellerShippingProfile: { ShippingProfileID: profiles.shippingProfileID },
    SellerReturnProfile: { ReturnProfileID: profiles.returnProfileID },
    SellerPaymentProfile: { PaymentProfileID: profiles.paymentProfileID },
  };
}

function buildAddFixedPriceInnerXml(item: Record<string, unknown>): string {
  return builder.build({ Item: item });
}

function variationCount(item: Record<string, unknown>): number {
  const vars = item.Variations as Record<string, unknown> | undefined;
  const raw = vars?.Variation;
  if (!raw) return 0;
  return Array.isArray(raw) ? raw.length : 1;
}

async function tradingVerifyOrAddFixedPrice(
  targetIntegrationId: string,
  targetConfig: EbayConfig,
  item: Record<string, unknown>,
  verifyOnly: boolean,
): Promise<{
  ack: string;
  errors: string[];
  itemId?: string;
  fees?: unknown;
}> {
  const callName = verifyOnly ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem";
  const inner = buildAddFixedPriceInnerXml(item);
  const { parsed } = await tradingCall(targetIntegrationId, targetConfig, callName, inner);
  const respKey = `${callName}Response`;
  const resp = parsed[respKey] as Record<string, unknown> | undefined;
  const ack = readAck(resp);
  const errs = readErrors(resp);

  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(`${callName} failed: ${errs.join("; ") || ack}`);
  }

  let itemId: string | undefined;
  if (!verifyOnly && resp?.ItemID != null) {
    itemId = String(resp.ItemID).trim();
  }

  return { ack, errors: errs, itemId, fees: resp?.Fees };
}

async function buildWorkingCloneItem(input: {
  sourcePlatform: EbayListingClonePlatform;
  targetPlatform: EbayListingClonePlatform;
  sourceItemId: string;
  options: ListingCloneEbayOptions;
}): Promise<{
  working: Record<string, unknown>;
  summary: ListingCloneEbayPayloadSummary;
  targetIntegrationId: string;
  targetConfig: EbayConfig;
}> {
  const { sourcePlatform, targetPlatform, sourceItemId, options } = input;

  if (sourcePlatform === targetPlatform) {
    throw new Error("Source and target eBay stores must differ.");
  }

  const sourceInt = await db.integration.findUnique({
    where: { platform: sourcePlatform },
  });
  const targetInt = await db.integration.findUnique({
    where: { platform: targetPlatform },
  });

  if (!sourceInt?.enabled || !targetInt?.enabled) {
    throw new Error("Both source and target eBay integrations must exist and be enabled.");
  }

  const sourceConfig = buildEbayConfig(sourceInt);
  const targetConfig = buildEbayConfig(targetInt);

  const itemRaw = await getItemFullForClone(sourceInt.id, sourceConfig, sourceItemId);
  const profiles = await resolveTargetSellerProfiles(
    targetInt.id,
    targetConfig,
    targetPlatform,
    options,
  );

  let working = stripListingForClone(itemRaw, options.itemTypeAspect);
  attachSellerProfiles(working, profiles);

  const urls = collectPictureUrls(working);
  if (!options.skipPictureUpload && urls.size > 0) {
    const map = new Map<string, string>();
    let i = 0;
    for (const u of urls) {
      const nu = await uploadSiteHostedPicture(targetInt.id, targetConfig, u, i);
      map.set(u, nu);
      i += 1;
      await new Promise((r) => setTimeout(r, 550));
    }
    rewritePictureUrls(working, map);
  }

  const vars = working.Variations as Record<string, unknown> | undefined;
  const hasVariations = Boolean(vars?.Variation);

  const summary: ListingCloneEbayPayloadSummary = {
    title: String(itemRaw.Title ?? "").trim() || "(no title)",
    sourceItemId,
    pictureUrlCount: urls.size,
    listingSpecificRowCount: listingItemSpecificRowCount(working),
    hasVariations,
    variationCount: variationCount(working),
  };

  return {
    working,
    summary,
    targetIntegrationId: targetInt.id,
    targetConfig,
  };
}

/** Verify-only dry run (no listing created). */
export async function runListingCloneEbayPreview(
  sourcePlatform: EbayListingClonePlatform,
  targetPlatform: EbayListingClonePlatform,
  sourceItemId: string,
  options: ListingCloneEbayOptions = {},
): Promise<ListingCloneVerifyResult> {
  const { working, summary, targetIntegrationId, targetConfig } =
    await buildWorkingCloneItem({
      sourcePlatform,
      targetPlatform,
      sourceItemId,
      options,
    });

  const r = await tradingVerifyOrAddFixedPrice(
    targetIntegrationId,
    targetConfig,
    working,
    true,
  );

  return {
    ok: true,
    ack: r.ack,
    errors: r.errors,
    fees: r.fees,
    summary,
  };
}

/** Live AddFixedPriceItem after the same pipeline as preview (rebuilds payload). */
export async function runListingCloneEbayExecute(
  sourcePlatform: EbayListingClonePlatform,
  targetPlatform: EbayListingClonePlatform,
  sourceItemId: string,
  options: ListingCloneEbayOptions = {},
): Promise<ListingCloneExecuteResult> {
  const { working, summary, targetIntegrationId, targetConfig } =
    await buildWorkingCloneItem({
      sourcePlatform,
      targetPlatform,
      sourceItemId,
      options,
    });

  const verifyFirst = await tradingVerifyOrAddFixedPrice(
    targetIntegrationId,
    targetConfig,
    working,
    true,
  );

  const add = await tradingVerifyOrAddFixedPrice(
    targetIntegrationId,
    targetConfig,
    working,
    false,
  );

  return {
    ok: true,
    ack: add.ack,
    errors: [...verifyFirst.errors, ...add.errors],
    fees: add.fees,
    summary,
    newItemId: add.itemId,
  };
}
