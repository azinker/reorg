/**
 * One-off: clone an active fixed-price listing from TPP eBay → TT eBay via Trading API.
 *
 * Prerequisites:
 *   - DATABASE_URL points at DB with Integration rows for TPP_EBAY + TT_EBAY (prod "little-fire" per AGENTS.md).
 *   - TT OAuth token allows Trading writes + Account API read (sell.account) OR set explicit policy IDs via env.
 *
 * Usage:
 *   cd reorg && npx tsx scripts/_clone-listing-tpp-to-tt.ts [SOURCE_ITEM_ID]
 *
 * Default SOURCE_ITEM_ID: 204226527330
 *
 * Dry-run (default): calls VerifyAddFixedPriceItem only — no listing created.
 * Live publish:
 *   CLONE_LISTING_CONFIRM_LIVE=true npx tsx scripts/_clone-listing-tpp-to-tt.ts
 *   or pass flag: --live
 *
 * Optional env (skip Account API policy discovery):
 *   EBAY_CLONE_TT_SHIPPING_POLICY_ID
 *   EBAY_CLONE_TT_RETURN_POLICY_ID
 *   EBAY_CLONE_TT_PAYMENT_POLICY_ID
 *
 * Skip re-uploading gallery images (often fails cross-seller — leave default OFF):
 *   CLONE_SKIP_PICTURE_UPLOAD=true
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
const MARKETPLACE_ID = "EBAY_US";

const DEFAULT_SOURCE_ITEM_ID = "204226527330";

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

const LIVE =
  process.argv.includes("--live") ||
  process.env.CLONE_LISTING_CONFIRM_LIVE === "true";

const SKIP_PIC_UPLOAD = process.env.CLONE_SKIP_PICTURE_UPLOAD === "true";

/** Read-only / identity fields Drop from a fresh listing payload */
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
): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
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

async function getItemFull(
  tppIntegrationId: string,
  tppConfig: EbayConfig,
  itemId: string,
): Promise<Record<string, unknown>> {
  const inner = `<ItemID>${escapeXml(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>`;
  const { parsed } = await tradingCall(tppIntegrationId, tppConfig, "GetItem", inner);
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

/** Collect gallery URLs from PictureDetails + variation pics */
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

/** Replace URL strings recursively */
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

async function uploadSiteHostedPicture(
  ttIntegrationId: string,
  ttConfig: EbayConfig,
  externalUrl: string,
  idx: number,
): Promise<string> {
  const inner = `<ExternalPictureURL>${escapeXml(externalUrl)}</ExternalPictureURL>
  <PictureName>clone_${idx}</PictureName>`;
  const { parsed } = await tradingCall(
    ttIntegrationId,
    ttConfig,
    "UploadSiteHostedPictures",
    inner,
  );
  const resp = parsed.UploadSiteHostedPicturesResponse as Record<string, unknown> | undefined;
  const ack = readAck(resp);
  if (ack !== "Success" && ack !== "Warning") {
    throw new Error(
      `UploadSiteHostedPictures failed for ${externalUrl}: ${readErrors(resp).join("; ")}`,
    );
  }
  const details = resp?.SiteHostedPictureDetails as Record<string, unknown> | undefined;
  const full = details?.FullURL;
  if (typeof full !== "string" || !full.startsWith("http")) {
    throw new Error(`UploadSiteHostedPictures missing FullURL for ${externalUrl}`);
  }
  return full.trim();
}

async function fetchTtSellerProfiles(accessToken: string): Promise<{
  shippingProfileID: string;
  returnProfileID: string;
  paymentProfileID: string;
}> {
  const shipEnv = process.env.EBAY_CLONE_TT_SHIPPING_POLICY_ID?.trim();
  const retEnv = process.env.EBAY_CLONE_TT_RETURN_POLICY_ID?.trim();
  const payEnv = process.env.EBAY_CLONE_TT_PAYMENT_POLICY_ID?.trim();
  if (shipEnv && retEnv && payEnv) {
    return {
      shippingProfileID: shipEnv,
      returnProfileID: retEnv,
      paymentProfileID: payEnv,
    };
  }

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

  if (!shipRes.ok || !payRes.ok || !retRes.ok) {
    throw new Error(
      `Account API policy fetch failed (need sell.account scope or set EBAY_CLONE_TT_*_POLICY_ID env). ` +
        `shipping=${shipRes.status} payment=${payRes.status} return=${retRes.status}`,
    );
  }

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

function stripListingForClone(item: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(item)) as Record<string, unknown>;

  for (const k of DROP_TOP_LEVEL_KEYS) {
    delete clone[k];
  }

  delete clone.ShippingDetails;
  delete clone.ReturnPolicy;
  delete clone.BuyerRequirementDetails;
  delete clone.ShippingPackageDetails;

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

async function verifyOrAddFixedPrice(
  ttIntegrationId: string,
  ttConfig: EbayConfig,
  item: Record<string, unknown>,
  verifyOnly: boolean,
): Promise<void> {
  const callName = verifyOnly ? "VerifyAddFixedPriceItem" : "AddFixedPriceItem";
  const inner = buildAddFixedPriceInnerXml(item);
  const { parsed } = await tradingCall(ttIntegrationId, ttConfig, callName, inner);
  const respKey = `${callName}Response`;
  const resp = parsed[respKey] as Record<string, unknown> | undefined;
  const ack = readAck(resp);
  const errs = readErrors(resp);

  if (ack !== "Success" && ack !== "Warning") {
    console.error(`[clone] ${callName} Ack=${ack}`, errs);
    throw new Error(`${callName} failed`);
  }

  if (errs.length > 0) {
    console.warn(`[clone] ${callName} warnings/errors:`, errs);
  }

  if (!verifyOnly) {
    const itemId = resp?.ItemID;
    console.log(`[clone] Live listing created. ItemID=${itemId}`);
  } else {
    console.log(`[clone] VerifyAddFixedPriceItem OK (dry-run). No listing created.`);
    const fees = resp?.Fees;
    if (fees) console.log("[clone] Fees summary:", JSON.stringify(fees).slice(0, 800));
  }
}

async function main() {
  const sourceItemId =
    process.argv.find((a) => /^\d{10,}$/.test(a)) ?? DEFAULT_SOURCE_ITEM_ID;

  console.log(`[clone] SOURCE_ITEM_ID=${sourceItemId}`);
  console.log(`[clone] LIVE=${LIVE} SKIP_PIC_UPLOAD=${SKIP_PIC_UPLOAD}`);

  const url = process.env.DATABASE_URL ?? "";
  const host = url.match(/@([^/:]+)/)?.[1] ?? "";
  console.log(`[clone] DATABASE_URL host=${host || "(unset)"}`);
  if (host && !host.includes("little-fire")) {
    console.warn(
      `[clone] WARNING: prod listings usually use DB host containing 'little-fire'.`,
    );
  }

  const tppInt = await db.integration.findUnique({
    where: { platform: Platform.TPP_EBAY },
  });
  const ttInt = await db.integration.findUnique({
    where: { platform: Platform.TT_EBAY },
  });
  if (!tppInt?.enabled || !ttInt?.enabled) {
    throw new Error("TPP_EBAY and TT_EBAY integrations must exist and be enabled.");
  }

  const tppConfig = buildEbayConfig(tppInt);
  const ttConfig = buildEbayConfig(ttInt);

  console.log("[clone] Fetching source listing via GetItem (TPP)…");
  const itemRaw = await getItemFull(tppInt.id, tppConfig, sourceItemId);
  console.log("[clone] Title:", itemRaw.Title);

  const ttToken = await getEbayAccessToken(ttInt.id, ttConfig);
  console.log("[clone] Resolving TT business policies…");
  const profiles = await fetchTtSellerProfiles(ttToken);
  console.log("[clone] TT SellerProfiles:", profiles);

  let working = stripListingForClone(itemRaw);
  attachSellerProfiles(working, profiles);

  const urls = collectPictureUrls(working);
  console.log(`[clone] Picture URLs found: ${urls.size}`);

  if (!SKIP_PIC_UPLOAD && urls.size > 0) {
    const map = new Map<string, string>();
    let i = 0;
    for (const u of urls) {
      console.log(`[clone] Uploading (${i + 1}/${urls.size})…`);
      const nu = await uploadSiteHostedPicture(ttInt.id, ttConfig, u, i);
      map.set(u, nu);
      i += 1;
      await new Promise((r) => setTimeout(r, 400));
    }
    rewritePictureUrls(working, map);
  }

  console.log("[clone] Running VerifyAddFixedPriceItem (always)…");
  await verifyOrAddFixedPrice(ttInt.id, ttConfig, working, true);

  if (LIVE) {
    console.log("[clone] Running AddFixedPriceItem (live)…");
    await verifyOrAddFixedPrice(ttInt.id, ttConfig, working, false);
  } else {
    console.log(
      `[clone] Dry-run complete. To publish live: CLONE_LISTING_CONFIRM_LIVE=true npx tsx scripts/_clone-listing-tpp-to-tt.ts ${sourceItemId}`,
    );
    console.log(`[clone] Or: npx tsx scripts/_clone-listing-tpp-to-tt.ts --live ${sourceItemId}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
