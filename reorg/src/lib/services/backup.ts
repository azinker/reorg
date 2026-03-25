import { gunzipSync, gzipSync } from "node:zlib";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { BackupType, type Platform } from "@prisma/client";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import {
  deleteR2Object,
  getR2BucketName,
  getR2Client,
  isR2Configured,
} from "@/lib/r2";
import {
  fetchFullEbayBackupDetails,
  type EbayBackupDetailRecord,
} from "@/lib/services/ebay-full-backup";

const BACKUP_RETENTION_DAYS = 30;

interface CreateBackupOptions {
  type?: BackupType;
  triggeredById?: string | null;
  includeFullEbayDetails?: boolean;
}

type SnapshotRow = Record<string, unknown>;

interface BackupSnapshot {
  meta: {
    backupId: string;
    type: BackupType;
    createdAt: string;
    expiresAt: string;
    retentionDays: number;
    appEnv: string;
    counts: Record<string, number>;
  };
  data: {
    masterRows: SnapshotRow[];
    marketplaceListings: SnapshotRow[];
    stagedChanges: SnapshotRow[];
    integrations: SnapshotRow[];
    unmatchedListings: SnapshotRow[];
    shippingRates: SnapshotRow[];
    appSettings: SnapshotRow[];
    ebayFullItemDetails?: SnapshotRow[];
    backupWarnings?: SnapshotRow[];
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function buildStorageKey(createdAt: Date, backupId: string): string {
  const yyyy = createdAt.getUTCFullYear();
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(createdAt.getUTCDate()).padStart(2, "0");
  return `backups/${yyyy}/${mm}/${dd}/${backupId}.json.gz`;
}

function buildFileName(createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/[:.]/g, "-");
  return `reorg-backup-${stamp}.json.gz`;
}

function getBackupStores(platforms: Platform[]): string[] {
  return platforms.map((platform) => platform.replace(/_/g, " "));
}

function buildListingUrl(platform: string, listingId: string): string {
  if (platform === "TPP_EBAY" || platform === "TT_EBAY") {
    return `https://www.ebay.com/itm/${listingId}`;
  }
  if (platform === "BIGCOMMERCE") {
    const storeHash =
      process.env.BIGCOMMERCE_STORE_HASH ??
      process.env.NEXT_PUBLIC_BIGCOMMERCE_STORE_HASH;
    if (!storeHash) return "";
    return `https://store-${storeHash}.mybigcommerce.com/manage/products/edit/${listingId.replace(/^BC-/, "")}`;
  }
  if (platform === "SHOPIFY") {
    return `https://admin.shopify.com/store/fd7279/products/${listingId.replace(/^SH-/, "")}`;
  }
  return "";
}

function toIso(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  return "";
}

function toJsonString(value: unknown): string {
  if (value == null) return "";
  return JSON.stringify(value);
}

function toSpreadsheetText(value: unknown, maxLength = 30000): string {
  const text = typeof value === "string" ? value : toJsonString(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… [truncated for Excel]`;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function getNumber(value: unknown): number | "" {
  return typeof value === "number" ? value : "";
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function readNameValueList(value: unknown): Record<string, string> {
  const specifics = getRecord(value);
  const list = Array.isArray(specifics?.NameValueList)
    ? specifics.NameValueList
    : specifics?.NameValueList
      ? [specifics.NameValueList]
      : [];
  const output: Record<string, string> = {};

  for (const item of list) {
    const row = getRecord(item);
    if (!row) continue;
    const name = getString(row.Name);
    const rawValue = row.Value;
    const valueText = Array.isArray(rawValue)
      ? firstString(rawValue)
      : getString(rawValue);
    if (name && valueText) output[name] = valueText;
  }

  return output;
}

function readPictureUrls(value: unknown): string[] {
  const pictureDetails = getRecord(value);
  if (!pictureDetails) return [];
  const urls = Array.isArray(pictureDetails.PictureURL)
    ? pictureDetails.PictureURL
    : pictureDetails.PictureURL
      ? [pictureDetails.PictureURL]
      : [];
  return urls.filter((url): url is string => typeof url === "string" && !!url);
}

function asArray(value: unknown): SnapshotRow[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is SnapshotRow =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
    : [];
}

function createWorkbook(snapshot: BackupSnapshot): Buffer {
  const workbook = XLSX.utils.book_new();

  const masterRows = asArray(snapshot.data.masterRows);
  const marketplaceListings = asArray(snapshot.data.marketplaceListings);
  const stagedChanges = asArray(snapshot.data.stagedChanges);
  const integrations = asArray(snapshot.data.integrations);
  const unmatchedListings = asArray(snapshot.data.unmatchedListings);
  const shippingRates = asArray(snapshot.data.shippingRates);
  const appSettings = asArray(snapshot.data.appSettings);
  const ebayFullItemDetails = asArray(snapshot.data.ebayFullItemDetails);
  const backupWarnings = asArray(snapshot.data.backupWarnings);

  const mastersById = new Map(
    masterRows
      .map((row) => {
        const id = typeof row.id === "string" ? row.id : null;
        return id ? [id, row] : null;
      })
      .filter((entry): entry is [string, SnapshotRow] => entry !== null)
  );

  const integrationsById = new Map(
    integrations
      .map((row) => {
        const id = typeof row.id === "string" ? row.id : null;
        return id ? [id, row] : null;
      })
      .filter((entry): entry is [string, SnapshotRow] => entry !== null)
  );

  const stagedByListing = new Map<string, SnapshotRow[]>();
  for (const staged of stagedChanges) {
    const listingId =
      typeof staged.marketplaceListingId === "string"
        ? staged.marketplaceListingId
        : null;
    if (!listingId) continue;
    const existing = stagedByListing.get(listingId) ?? [];
    existing.push(staged);
    stagedByListing.set(listingId, existing);
  }

  const readmeRows = [
    ["reorG Backup Export", ""],
    ["Backup ID", snapshot.meta.backupId],
    ["Created At", snapshot.meta.createdAt],
    ["Backup Type", snapshot.meta.type],
    ["Formats", "JSON = raw structured backup, XLSX = manual repair workbook"],
    ["Manual Repair Sheet", "Listing Repair"],
    ["What Listing Repair contains", "One row per marketplace listing with SKU, item ID, title, price, ad rate, inventory, URLs, staged values, and internal cost/shipping context"],
    ["Other Sheets", "Master Rows, Staged Changes, Integrations, Unmatched Listings, Shipping Rates, App Settings"],
    ["Full eBay backup mode", "When selected at backup time, the workbook also includes Full eBay Items with richer GetItem payloads from eBay."],
    ["Excel raw JSON fields", "Large JSON payloads are trimmed in the workbook so the file stays openable. The full raw snapshot is still available in the JSON export."],
    ["Important", "v1 backups are for export and manual recovery only. They do not auto-restore marketplace data."],
  ];
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(readmeRows),
    "README"
  );

  const listingRepairRows = marketplaceListings.map((listing) => {
    const master =
      typeof listing.masterRowId === "string"
        ? mastersById.get(listing.masterRowId)
        : undefined;
    const integration =
      typeof listing.integrationId === "string"
        ? integrationsById.get(listing.integrationId)
        : undefined;
    const listingStaged =
      typeof listing.id === "string" ? stagedByListing.get(listing.id) ?? [] : [];
    const stagedSalePrice = listingStaged.find(
      (change) => change.field === "salePrice" && change.status === "STAGED"
    );
    const stagedAdRate = listingStaged.find(
      (change) => change.field === "adRate" && change.status === "STAGED"
    );
    const platform =
      typeof integration?.platform === "string" ? integration.platform : "";
    const listingId =
      typeof listing.platformItemId === "string" ? listing.platformItemId : "";

    return {
      platform,
      storeLabel:
        typeof integration?.label === "string" ? integration.label : platform,
      masterSku: typeof master?.sku === "string" ? master.sku : "",
      masterTitle: typeof master?.title === "string" ? master.title : "",
      masterUpc: typeof master?.upc === "string" ? master.upc : "",
      masterWeight: typeof master?.weight === "string" ? master.weight : "",
      masterWeightOz:
        typeof master?.weightOz === "number" ? master.weightOz : "",
      supplierCost:
        typeof master?.supplierCost === "number" ? master.supplierCost : "",
      supplierShipping:
        typeof master?.supplierShipping === "number"
          ? master.supplierShipping
          : "",
      shippingCostOverride:
        typeof master?.shippingCostOverride === "number"
          ? master.shippingCostOverride
          : "",
      platformFeeRate:
        typeof master?.platformFeeRate === "number"
          ? master.platformFeeRate
          : "",
      internalNotes: typeof master?.notes === "string" ? master.notes : "",
      listingSku: typeof listing.sku === "string" ? listing.sku : "",
      listingTitle: typeof listing.title === "string" ? listing.title : "",
      platformItemId: listingId,
      platformVariantId:
        typeof listing.platformVariantId === "string"
          ? listing.platformVariantId
          : "",
      listingUrl: buildListingUrl(platform, listingId),
      salePrice:
        typeof listing.salePrice === "number" ? listing.salePrice : "",
      stagedSalePrice:
        typeof stagedSalePrice?.stagedValue === "string"
          ? stagedSalePrice.stagedValue
          : "",
      adRate: typeof listing.adRate === "number" ? listing.adRate : "",
      stagedAdRate:
        typeof stagedAdRate?.stagedValue === "string"
          ? stagedAdRate.stagedValue
          : "",
      inventory:
        typeof listing.inventory === "number" ? listing.inventory : "",
      status: typeof listing.status === "string" ? listing.status : "",
      isVariation:
        typeof listing.isVariation === "boolean" ? listing.isVariation : "",
      parentListingId:
        typeof listing.parentListingId === "string"
          ? listing.parentListingId
          : "",
      imageUrl:
        typeof listing.imageUrl === "string" ? listing.imageUrl : "",
      lastSyncedAt: toIso(listing.lastSyncedAt),
      createdAt: toIso(listing.createdAt),
      updatedAt: toIso(listing.updatedAt),
      rawDataJson: toSpreadsheetText(listing.rawData),
    };
  });
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(listingRepairRows),
    "Listing Repair"
  );

  const ebayParentRawByKey = new Map<string, Record<string, unknown>>();
  for (const listing of marketplaceListings) {
    const integration =
      typeof listing.integrationId === "string"
        ? integrationsById.get(listing.integrationId)
        : undefined;
    const platform =
      typeof integration?.platform === "string" ? integration.platform : "";
    if (
      (platform === "TPP_EBAY" || platform === "TT_EBAY") &&
      typeof listing.platformItemId === "string" &&
      !listing.platformVariantId
    ) {
      const raw = getRecord(listing.rawData);
      if (raw) ebayParentRawByKey.set(`${platform}:${listing.platformItemId}`, raw);
    }
  }

  const ebayFullDetailsByKey = new Map<string, Record<string, unknown>>();
  for (const detail of ebayFullItemDetails) {
    const platform =
      typeof detail.platform === "string" ? detail.platform : null;
    const itemId =
      typeof detail.platformItemId === "string" ? detail.platformItemId : null;
    const detailRaw = getRecord(detail.detailRaw);
    if (platform && itemId && detailRaw) {
      ebayFullDetailsByKey.set(`${platform}:${itemId}`, detailRaw);
    }
  }

  const ebayListingRows = marketplaceListings
    .filter((listing) => {
      const integration =
        typeof listing.integrationId === "string"
          ? integrationsById.get(listing.integrationId)
          : undefined;
      return (
        integration?.platform === "TPP_EBAY" || integration?.platform === "TT_EBAY"
      );
    })
    .map((listing) => {
      const master =
        typeof listing.masterRowId === "string"
          ? mastersById.get(listing.masterRowId)
          : undefined;
      const integration =
        typeof listing.integrationId === "string"
          ? integrationsById.get(listing.integrationId)
          : undefined;
      const platform =
        typeof integration?.platform === "string" ? integration.platform : "";
      const raw = getRecord(listing.rawData) ?? {};
      const topLevelKey =
        `${platform}:${typeof listing.platformItemId === "string" ? listing.platformItemId : ""}`;
      const fullDetailRaw = ebayFullDetailsByKey.get(topLevelKey);
      const parentRaw =
        fullDetailRaw ??
        ebayParentRawByKey.get(
          `${platform}:${typeof listing.platformItemId === "string" ? listing.platformItemId : ""}`
        ) ?? raw;
      const itemSpecifics = readNameValueList(parentRaw.ItemSpecifics);
      const variationSpecifics = readNameValueList(raw.VariationSpecifics);
      const pictureUrls = readPictureUrls(parentRaw.PictureDetails);
      const sellingStatus = getRecord(raw.SellingStatus) ?? getRecord(parentRaw.SellingStatus);
      const primaryCategory = getRecord(parentRaw.PrimaryCategory);
      const returnPolicy = getRecord(parentRaw.ReturnPolicy);
      const shippingDetails = getRecord(parentRaw.ShippingDetails);
      const listingDetails = getRecord(parentRaw.ListingDetails);
      const productListingDetails = getRecord(parentRaw.ProductListingDetails);
      const sellerProfiles = getRecord(parentRaw.SellerProfiles);

      return {
        platform,
        storeLabel:
          typeof integration?.label === "string" ? integration.label : platform,
        masterSku: typeof master?.sku === "string" ? master.sku : "",
        listingSku: typeof listing.sku === "string" ? listing.sku : "",
        itemId:
          typeof listing.platformItemId === "string" ? listing.platformItemId : "",
        variantId:
          typeof listing.platformVariantId === "string"
            ? listing.platformVariantId
            : "",
        title: firstString([
          raw.Title,
          parentRaw.Title,
          listing.title,
          master?.title,
        ]),
        subtitle: firstString([raw.SubTitle, raw.Subtitle, parentRaw.SubTitle, parentRaw.Subtitle]),
        fullHtmlDescription: toSpreadsheetText(
          firstString([raw.Description, parentRaw.Description]),
          30000
        ),
        conditionId: firstString([raw.ConditionID, parentRaw.ConditionID]),
        conditionName: firstString([raw.ConditionDisplayName, parentRaw.ConditionDisplayName]),
        listingType: firstString([raw.ListingType, parentRaw.ListingType]),
        categoryId: getString(primaryCategory?.CategoryID),
        categoryName: getString(primaryCategory?.CategoryName),
        salePrice:
          typeof listing.salePrice === "number"
            ? listing.salePrice
            : getNumber(sellingStatus?.CurrentPrice),
        quantity: firstString([raw.Quantity, parentRaw.Quantity]),
        quantitySold: getNumber(sellingStatus?.QuantitySold),
        inventory:
          typeof listing.inventory === "number" ? listing.inventory : "",
        listingUrl: buildListingUrl(
          platform,
          typeof listing.platformItemId === "string" ? listing.platformItemId : ""
        ),
        imageUrls: toSpreadsheetText(pictureUrls.join("\n")),
        imageUrl:
          typeof listing.imageUrl === "string" ? listing.imageUrl : pictureUrls[0] ?? "",
        upc: firstString([
          getString(productListingDetails?.UPC),
          getString(master?.upc),
        ]),
        ean: getString(productListingDetails?.EAN),
        brand: itemSpecifics.Brand ?? "",
        mpn: itemSpecifics.MPN ?? "",
        itemSpecificsJson: toSpreadsheetText(itemSpecifics),
        variationSpecificsJson: toSpreadsheetText(variationSpecifics),
        shippingDetailsJson: toSpreadsheetText(shippingDetails),
        returnPolicyJson: toSpreadsheetText(returnPolicy),
        listingDetailsJson: toSpreadsheetText(listingDetails),
        sellerProfilesJson: toSpreadsheetText(sellerProfiles),
        productListingDetailsJson: toSpreadsheetText(productListingDetails),
        rawDataJson: toSpreadsheetText(raw),
        fullDetailJson: toSpreadsheetText(fullDetailRaw),
        lastSyncedAt: toIso(listing.lastSyncedAt),
        updatedAt: toIso(listing.updatedAt),
      };
    });

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(ebayListingRows),
    "eBay Repair"
  );

  if (ebayFullItemDetails.length > 0) {
    const ebayFullSheet = ebayFullItemDetails.map((detail) => {
      const raw = getRecord(detail.detailRaw) ?? {};
      const itemSpecifics = readNameValueList(raw.ItemSpecifics);
      const pictureUrls = readPictureUrls(raw.PictureDetails);

      return {
        platform: detail.platform ?? "",
        platformItemId: detail.platformItemId ?? "",
        sku: detail.sku ?? "",
        fetchedAt: detail.fetchedAt ?? "",
        title: getString(raw.Title),
        subtitle: firstString([raw.SubTitle, raw.Subtitle]),
        conditionId: firstString([raw.ConditionID]),
        conditionName: firstString([raw.ConditionDisplayName]),
        categoryId: getString(getRecord(raw.PrimaryCategory)?.CategoryID),
        categoryName: getString(getRecord(raw.PrimaryCategory)?.CategoryName),
        listingType: getString(raw.ListingType),
        imageUrls: toSpreadsheetText(pictureUrls.join("\n")),
        descriptionHtml: toSpreadsheetText(raw.Description, 30000),
        itemSpecificsJson: toSpreadsheetText(itemSpecifics),
        shippingDetailsJson: toSpreadsheetText(raw.ShippingDetails),
        returnPolicyJson: toSpreadsheetText(raw.ReturnPolicy),
        listingDetailsJson: toSpreadsheetText(raw.ListingDetails),
        sellerProfilesJson: toSpreadsheetText(raw.SellerProfiles),
        productListingDetailsJson: toSpreadsheetText(raw.ProductListingDetails),
        variationsJson: toSpreadsheetText(raw.Variations),
        rawDetailJson: toSpreadsheetText(raw),
      };
    });

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(ebayFullSheet),
      "Full eBay Items"
    );
  }

  const masterRowSheet = masterRows.map((row) => ({
    id: row.id ?? "",
    sku: row.sku ?? "",
    title: row.title ?? "",
    upc: row.upc ?? "",
    weight: row.weight ?? "",
    weightDisplay: row.weightDisplay ?? "",
    weightOz: row.weightOz ?? "",
    supplierCost: row.supplierCost ?? "",
    supplierShipping: row.supplierShipping ?? "",
    shippingCostOverride: row.shippingCostOverride ?? "",
    platformFeeRate: row.platformFeeRate ?? "",
    notes: row.notes ?? "",
    imageUrl: row.imageUrl ?? "",
    alternateTitlesJson: toSpreadsheetText(row.alternateTitles),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(masterRowSheet),
    "Master Rows"
  );

  const stagedSheet = stagedChanges.map((row) => ({
    id: row.id ?? "",
    masterRowId: row.masterRowId ?? "",
    marketplaceListingId: row.marketplaceListingId ?? "",
    field: row.field ?? "",
    stagedValue: row.stagedValue ?? "",
    liveValue: row.liveValue ?? "",
    status: row.status ?? "",
    changedById: row.changedById ?? "",
    pushedAt: toIso(row.pushedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(stagedSheet),
    "Staged Changes"
  );

  const integrationsSheet = integrations.map((row) => ({
    id: row.id ?? "",
    platform: row.platform ?? "",
    label: row.label ?? "",
    enabled: row.enabled ?? "",
    isMaster: row.isMaster ?? "",
    writeLocked: row.writeLocked ?? "",
    lastSyncAt: toIso(row.lastSyncAt),
    configJson: toSpreadsheetText(row.config),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(integrationsSheet),
    "Integrations"
  );

  const unmatchedSheet = unmatchedListings.map((row) => ({
    id: row.id ?? "",
    integrationId: row.integrationId ?? "",
    platformItemId: row.platformItemId ?? "",
    sku: row.sku ?? "",
    title: row.title ?? "",
    lastSyncedAt: toIso(row.lastSyncedAt),
    rawDataJson: toSpreadsheetText(row.rawData),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(unmatchedSheet),
    "Unmatched"
  );

  const shippingSheet = shippingRates.map((row) => ({
    id: row.id ?? "",
    weightKey: row.weightKey ?? "",
    weightOz: row.weightOz ?? "",
    cost: row.cost ?? "",
    sortOrder: row.sortOrder ?? "",
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(shippingSheet),
    "Shipping Rates"
  );

  const settingsSheet = appSettings.map((row) => ({
    key: row.key ?? "",
    valueJson: toSpreadsheetText(row.value),
    updatedBy: row.updatedBy ?? "",
    updatedAt: toIso(row.updatedAt),
  }));
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(settingsSheet),
    "App Settings"
  );

  if (backupWarnings.length > 0) {
    const warningsSheet = backupWarnings.map((row) => ({
      type: row.type ?? "",
      platform: row.platform ?? "",
      platformItemId: row.platformItemId ?? "",
      message: row.message ?? "",
    }));
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(warningsSheet),
      "Backup Warnings"
    );
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function parseBackupSnapshot(compressed: Uint8Array): BackupSnapshot {
  const json = gunzipSync(Buffer.from(compressed)).toString("utf8");
  return JSON.parse(json) as BackupSnapshot;
}

export function createBackupJsonBuffer(snapshot: BackupSnapshot): Buffer {
  return Buffer.from(JSON.stringify(snapshot, null, 2));
}

export function createBackupWorkbookBuffer(snapshot: BackupSnapshot): Buffer {
  return createWorkbook(snapshot);
}

export async function createBackup({
  type = BackupType.MANUAL,
  triggeredById,
  includeFullEbayDetails = false,
}: CreateBackupOptions = {}) {
  if (!isR2Configured()) {
    throw new Error(
      "Cloudflare R2 is not configured. Add the R2 environment variables before running backups."
    );
  }

  const createdAt = new Date();
  const fileName = buildFileName(createdAt);
  const expiresAt = addDays(createdAt, BACKUP_RETENTION_DAYS);

  const backup = await db.backup.create({
    data: {
      type,
      storageKey: `pending/${crypto.randomUUID()}`,
      fileName,
      status: "IN_PROGRESS",
      expiresAt,
      notes: "Creating snapshot",
    },
  });

  try {
    const [
      masterRows,
      marketplaceListings,
      stagedChanges,
      integrations,
      unmatchedListings,
      shippingRates,
      appSettings,
      ebayDetailFetch,
    ] = await Promise.all([
      db.masterRow.findMany({ orderBy: { sku: "asc" } }),
      db.marketplaceListing.findMany({
        select: {
          id: true,
          masterRowId: true,
          integrationId: true,
          platformItemId: true,
          platformVariantId: true,
          parentListingId: true,
          sku: true,
          title: true,
          imageUrl: true,
          salePrice: true,
          adRate: true,
          inventory: true,
          status: true,
          isVariation: true,
          lastSyncedAt: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ sku: "asc" }, { platformItemId: "asc" }],
      }),
      db.stagedChange.findMany({
        orderBy: [{ createdAt: "desc" }],
      }),
      db.integration.findMany({ orderBy: { platform: "asc" } }),
      db.unmatchedListing.findMany({
        orderBy: [{ createdAt: "desc" }],
      }),
      db.shippingRate.findMany({
        orderBy: [{ sortOrder: "asc" }, { weightOz: "asc" }],
      }),
      db.appSetting.findMany({ orderBy: { key: "asc" } }),
      includeFullEbayDetails
        ? fetchFullEbayBackupDetails()
        : Promise.resolve({ records: [], errors: [] }),
    ]);

    const backupWarnings = ebayDetailFetch.errors.map((error) => ({
      type: "ebay_full_detail_fetch",
      platform: error.platform,
      platformItemId: error.platformItemId,
      message: error.message,
    }));

    const snapshot: BackupSnapshot = {
      meta: {
        backupId: backup.id,
        type,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        retentionDays: BACKUP_RETENTION_DAYS,
        appEnv: process.env.NEXT_PUBLIC_APP_ENV ?? "local",
        counts: {
          masterRows: masterRows.length,
          marketplaceListings: marketplaceListings.length,
          stagedChanges: stagedChanges.length,
          integrations: integrations.length,
          unmatchedListings: unmatchedListings.length,
          shippingRates: shippingRates.length,
          appSettings: appSettings.length,
          ebayFullItemDetails: ebayDetailFetch.records.length,
          backupWarnings: backupWarnings.length,
        },
      },
      data: {
        masterRows,
        marketplaceListings,
        stagedChanges,
        integrations,
        unmatchedListings,
        shippingRates,
        appSettings,
        ebayFullItemDetails:
          ebayDetailFetch.records as unknown as SnapshotRow[],
        backupWarnings,
      },
    };

    const payload = Buffer.from(JSON.stringify(snapshot));
    const compressed = gzipSync(payload);
    const storageKey = buildStorageKey(createdAt, backup.id);
    const stores = getBackupStores(
      integrations.map((integration) => integration.platform)
    );

    await getR2Client().send(
      new PutObjectCommand({
        Bucket: getR2BucketName(),
        Key: storageKey,
        Body: compressed,
        ContentType: "application/gzip",
        Metadata: {
          backupId: backup.id,
          backupType: type,
          createdAt: createdAt.toISOString(),
        },
      })
    );

    const completedBackup = await db.backup.update({
      where: { id: backup.id },
      data: {
        storageKey,
        size: compressed.byteLength,
        stores,
        status: "COMPLETED",
        notes: `Snapshot includes ${masterRows.length} master rows and ${marketplaceListings.length} marketplace listings.`,
      },
    });

    await db.auditLog.create({
      data: {
        userId: triggeredById ?? undefined,
        action: "backup_created",
        entityType: "backup",
        entityId: backup.id,
        details: {
          type,
          fileName,
          size: compressed.byteLength,
          stores,
          counts: snapshot.meta.counts,
          includeFullEbayDetails,
          backupWarnings: backupWarnings.length,
        },
      },
    });

    return completedBackup;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown backup error";

    await db.backup.update({
      where: { id: backup.id },
      data: {
        status: "FAILED",
        notes: message,
      },
    });

    await db.auditLog.create({
      data: {
        userId: triggeredById ?? undefined,
        action: "backup_failed",
        entityType: "backup",
        entityId: backup.id,
        details: {
          type,
          fileName,
          error: message,
        },
      },
    });

    throw error;
  }
}

const MAX_BACKUP_DELETE_BATCH = 50;

export interface DeleteBackupsResult {
  deletedIds: string[];
  failed: Array<{ id: string; message: string }>;
}

/**
 * Permanently removes backup rows and their objects from R2 when configured.
 * Does not touch marketplace data — only backup artifacts.
 */
export async function deleteBackupsByIds(
  backupIds: string[],
  triggeredById: string | null,
): Promise<DeleteBackupsResult> {
  const unique = [...new Set(backupIds.map((id) => id.trim()).filter(Boolean))].slice(
    0,
    MAX_BACKUP_DELETE_BATCH,
  );

  const deletedIds: string[] = [];
  const failed: Array<{ id: string; message: string }> = [];

  for (const id of unique) {
    const backup = await db.backup.findUnique({ where: { id } });
    if (!backup) {
      failed.push({ id, message: "Backup not found" });
      continue;
    }

    if (isR2Configured() && backup.storageKey?.trim()) {
      try {
        await deleteR2Object(backup.storageKey.trim());
      } catch (r2Err) {
        const msg =
          r2Err instanceof Error ? r2Err.message : "Cloudflare R2 delete failed";
        failed.push({ id, message: msg });
        continue;
      }
    }

    try {
      await db.backup.delete({ where: { id } });
      deletedIds.push(id);
    } catch (e) {
      failed.push({
        id,
        message: e instanceof Error ? e.message : "Database delete failed",
      });
    }
  }

  if (deletedIds.length > 0) {
    await db.auditLog.create({
      data: {
        userId: triggeredById ?? undefined,
        action: "backup_deleted",
        entityType: "backup",
        entityId: deletedIds[0] ?? undefined,
        details: {
          deletedCount: deletedIds.length,
          deletedIds,
          failedCount: failed.length,
        },
      },
    });
  }

  return { deletedIds, failed };
}
