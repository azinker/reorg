import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";
import { buildLiveUpcSummary } from "@/lib/upc-live";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const VALID_MODES = ["preview", "fill_blanks", "overwrite"] as const;
type ImportMode = (typeof VALID_MODES)[number];

const IMPORT_FIELD_HEADERS = [
  "sku",
  "upc",
  "upc_tpp_ebay",
  "upc_tt_ebay",
  "upc_shopify",
  "upc_bigcommerce",
  "weight",
  "supplier_cost",
  "supplier_shipping_cost",
  "notes",
] as const;

const IMPORT_UPC_PLATFORM_FIELDS = [
  {
    platform: Platform.TPP_EBAY,
    key: "upc_tpp_ebay",
    label: "TPP eBay UPC",
  },
  {
    platform: Platform.TT_EBAY,
    key: "upc_tt_ebay",
    label: "TT eBay UPC",
  },
  {
    platform: Platform.SHOPIFY,
    key: "upc_shopify",
    label: "Shopify UPC",
  },
  {
    platform: Platform.BIGCOMMERCE,
    key: "upc_bigcommerce",
    label: "BigCommerce UPC",
  },
] as const;

const SUPPORTED_UPC_PLATFORMS = new Set<Platform>(
  IMPORT_UPC_PLATFORM_FIELDS.map((field) => field.platform),
);

type SupportedUpcPlatform = (typeof IMPORT_UPC_PLATFORM_FIELDS)[number]["platform"];

type ImportDownloadRow = {
  sku: string;
  upc: string;
  upc_tpp_ebay: string;
  upc_tt_ebay: string;
  upc_shopify: string;
  upc_bigcommerce: string;
  weight: string;
  supplier_cost: string;
  supplier_shipping_cost: string;
  notes: string;
  error_reason?: string;
};

type ImportFailure = {
  row: number;
  sku: string;
  error: string;
  fields: ImportDownloadRow;
};

type ImportSuccess = {
  row: number;
  sku: string;
  outcome: "created" | "updated" | "no_changes";
  summary: string;
  changedFields: string[];
};

type ImportImpact = {
  row: number;
  sku: string;
  outcome: "created" | "updated" | "no_changes";
  summary: string;
  changedFields: string[];
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

type ExistingImportRow = {
  id: string;
  sku: string;
  title: string | null;
  upc: string | null;
  weight: string | null;
  weightOz: number | null;
  supplierCost: number | null;
  supplierShipping: number | null;
  notes: string | null;
  listings: Array<{
    id: string;
    rawData?: unknown;
    integration: {
      platform: Platform;
    };
  }>;
};

type ImportedUpcValues = {
  shared: string | null;
  byPlatform: Partial<Record<SupportedUpcPlatform, string>>;
};

type ImportedUpcTarget = {
  platform: SupportedUpcPlatform | null;
  label: string;
  desiredValue: string;
  liveValue: string | null;
  listingIds: string[];
};

function snapshotRowValues(row: ExistingImportRow) {
  return {
    title: row.title,
    weight: row.weight,
    weightOz: row.weightOz,
    supplierCost: row.supplierCost,
    supplierShipping: row.supplierShipping,
    notes: row.notes,
  };
}

const COLUMN_MAP: Record<string, string> = {
  sku: "sku",
  title: "title",
  weight: "weight",
  weightoz: "weightOz",
  "weight_oz": "weightOz",
  supplier_cost: "supplierCost",
  supplier_shipping_cost: "supplierShipping",
  supplier_shipping: "supplierShipping",
  notes: "notes",
  upc: "upc",
  upc_tpp: "upc_tpp_ebay",
  upc_tpp_ebay: "upc_tpp_ebay",
  tpp_upc: "upc_tpp_ebay",
  ebay_tpp_upc: "upc_tpp_ebay",
  upc_tt: "upc_tt_ebay",
  upc_tt_ebay: "upc_tt_ebay",
  tt_upc: "upc_tt_ebay",
  ebay_tt_upc: "upc_tt_ebay",
  upc_shopify: "upc_shopify",
  shopify_upc: "upc_shopify",
  upc_shpfy: "upc_shopify",
  upc_bigcommerce: "upc_bigcommerce",
  bigcommerce_upc: "upc_bigcommerce",
  bc_upc: "upc_bigcommerce",
  upc_bc: "upc_bigcommerce",
};

function normalizeHeader(h: string): string {
  return String(h ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_");
}

function parseRows(buffer: Buffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: true });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) return [];
  const sheet = workbook.Sheets[firstSheet];
  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  return json;
}

function mapRowToFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const normalized = normalizeHeader(key);
    const field = COLUMN_MAP[normalized] ?? normalized;
    if (value === "" || value == null) continue;
    if (field === "weightOz" || field === "supplierCost" || field === "supplierShipping") {
      const n = Number(value);
      out[field] = Number.isFinite(n) ? n : value;
    } else {
      out[field] = String(value).trim();
    }
  }
  return out;
}

function validateRow(
  row: Record<string, unknown>,
  index: number
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const sku = row.sku;
  if (sku === undefined || sku === null || String(sku).trim() === "") {
    errors.push("SKU is required");
  }
  if (String(sku).length > 255) {
    errors.push("SKU too long");
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

function markDuplicateSkuErrors(
  rows: Array<{ index: number; fields: Record<string, unknown>; valid: boolean; errors: string[] }>
) {
  const firstSeenRowBySku = new Map<string, number>();

  for (const row of rows) {
    if (!row.valid) continue;

    const sku = String(row.fields.sku ?? "").trim();
    if (!sku) continue;

    const normalizedSku = sku.toLowerCase();
    const firstSeenRow = firstSeenRowBySku.get(normalizedSku);
    if (firstSeenRow != null) {
      row.valid = false;
      row.errors.push(`Duplicate SKU in import file. First seen on row ${firstSeenRow}.`);
      continue;
    }

    firstSeenRowBySku.set(normalizedSku, row.index);
  }
}

function buildDownloadRow(fields: Record<string, unknown>, errorReason?: string): ImportDownloadRow {
  const row: ImportDownloadRow = {
    sku: "",
    upc: "",
    upc_tpp_ebay: "",
    upc_tt_ebay: "",
    upc_shopify: "",
    upc_bigcommerce: "",
    weight: "",
    supplier_cost: "",
    supplier_shipping_cost: "",
    notes: "",
  };

  row.sku = String(fields.sku ?? "").trim();
  row.upc = String(fields.upc ?? "").trim();
  row.upc_tpp_ebay = String(fields.upc_tpp_ebay ?? "").trim();
  row.upc_tt_ebay = String(fields.upc_tt_ebay ?? "").trim();
  row.upc_shopify = String(fields.upc_shopify ?? "").trim();
  row.upc_bigcommerce = String(fields.upc_bigcommerce ?? "").trim();
  row.weight = String(fields.weight ?? "").trim();
  row.supplier_cost =
    fields.supplierCost == null || String(fields.supplierCost).trim() === ""
      ? ""
      : String(fields.supplierCost);
  row.supplier_shipping_cost =
    fields.supplierShipping == null || String(fields.supplierShipping).trim() === ""
      ? ""
      : String(fields.supplierShipping);
  row.notes = String(fields.notes ?? "").trim();

  if (errorReason) {
    row.error_reason = errorReason;
  }

  return row;
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

function normalizeTrimmedString(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function collectImportedUpcValues(fields: Record<string, unknown>): ImportedUpcValues {
  const byPlatform = {} as Partial<Record<SupportedUpcPlatform, string>>;

  for (const field of IMPORT_UPC_PLATFORM_FIELDS) {
    const value = normalizeTrimmedString(fields[field.key]);
    if (value) {
      byPlatform[field.platform] = value;
    }
  }

  return {
    shared: normalizeTrimmedString(fields.upc),
    byPlatform,
  };
}

function buildLiveUpcMap(row: ExistingImportRow | null): Map<SupportedUpcPlatform, string | null> {
  if (!row) {
    return new Map();
  }

  const listingsWithRawData = row.listings.filter((l) => l.rawData != null);
  if (listingsWithRawData.length === 0) {
    return new Map();
  }

  const summary = buildLiveUpcSummary(
    listingsWithRawData.map((listing) => ({
      rawData: listing.rawData,
      integration: listing.integration,
    })),
    row.upc,
  );

  return new Map(
    summary.choices.map((choice) => [choice.platform as SupportedUpcPlatform, choice.value ?? null]),
  );
}

function buildImportedUpcTargets(args: {
  existing: ExistingImportRow | null;
  importedUpcs: ImportedUpcValues;
}): ImportedUpcTarget[] {
  const targets: ImportedUpcTarget[] = [];
  const liveUpcMap = buildLiveUpcMap(args.existing);

  if (!args.existing) {
    if (args.importedUpcs.shared) {
      targets.push({
        platform: null,
        label: "UPC",
        desiredValue: args.importedUpcs.shared,
        liveValue: null,
        listingIds: [],
      });
    }
    return targets;
  }

  for (const field of IMPORT_UPC_PLATFORM_FIELDS) {
    const listingIds = args.existing.listings
      .filter((listing) => listing.integration.platform === field.platform)
      .map((listing) => listing.id);
    if (listingIds.length === 0) {
      continue;
    }

    const desiredValue = args.importedUpcs.byPlatform[field.platform] ?? args.importedUpcs.shared;
    if (!desiredValue) {
      continue;
    }

    targets.push({
      platform: field.platform,
      label: field.label,
      desiredValue,
      liveValue: liveUpcMap.get(field.platform) ?? null,
      listingIds,
    });
  }

  if (targets.length === 0 && args.importedUpcs.shared) {
    targets.push({
      platform: null,
      label: "UPC",
      desiredValue: args.importedUpcs.shared,
      liveValue: args.existing.upc?.trim() || null,
      listingIds: [],
    });
  }

  return targets;
}

async function replaceTargetedImportedUpcStages(args: {
  masterRowId: string;
  changedById: string;
  targets: ImportedUpcTarget[];
  mode: Exclude<ImportMode, "preview">;
}) {
  const stagedLabels = new Set<string>();
  const txOps: ReturnType<typeof db.stagedChange.updateMany | typeof db.stagedChange.createMany | typeof db.stagedChange.create>[] = [];

  for (const target of args.targets) {
    const shouldStage =
      args.mode === "overwrite"
        ? target.liveValue !== target.desiredValue
        : !target.liveValue;

    if (target.listingIds.length > 0) {
      if (args.mode === "overwrite" || shouldStage) {
        txOps.push(
          db.stagedChange.updateMany({
            where: {
              masterRowId: args.masterRowId,
              field: "upc",
              status: "STAGED",
              marketplaceListingId: { in: target.listingIds },
            },
            data: { status: "CANCELLED" },
          }),
        );
      }

      if (shouldStage) {
        txOps.push(
          db.stagedChange.createMany({
            data: target.listingIds.map((listingId) => ({
              masterRowId: args.masterRowId,
              marketplaceListingId: listingId,
              field: "upc",
              stagedValue: target.desiredValue,
              liveValue: target.liveValue,
              changedById: args.changedById,
            })),
          }),
        );
        stagedLabels.add(target.label);
      }

      continue;
    }

    if (args.mode === "overwrite" || shouldStage) {
      txOps.push(
        db.stagedChange.updateMany({
          where: {
            masterRowId: args.masterRowId,
            field: "upc",
            status: "STAGED",
            marketplaceListingId: null,
          },
          data: { status: "CANCELLED" },
        }),
      );
    }

    if (shouldStage) {
      txOps.push(
        db.stagedChange.create({
          data: {
            masterRowId: args.masterRowId,
            field: "upc",
            stagedValue: target.desiredValue,
            liveValue: target.liveValue,
            changedById: args.changedById,
          },
        }),
      );
      stagedLabels.add(target.label);
    }
  }

  if (txOps.length > 0) {
    await db.$transaction(txOps);
  }

  return [...stagedLabels];
}

function collectImportedData(fields: Record<string, unknown>) {
  const data: {
    title?: string;
    weight?: string;
    weightOz?: number;
    supplierCost?: number;
    supplierShipping?: number;
    notes?: string;
  } = {};

  if (fields.title != null && String(fields.title).trim() !== "") data.title = String(fields.title).trim();
  if (fields.weight != null && String(fields.weight).trim() !== "") data.weight = String(fields.weight).trim();
  if (typeof fields.weightOz === "number" && Number.isFinite(fields.weightOz)) data.weightOz = fields.weightOz;
  if (typeof fields.supplierCost === "number" && Number.isFinite(fields.supplierCost)) data.supplierCost = fields.supplierCost;
  if (typeof fields.supplierShipping === "number" && Number.isFinite(fields.supplierShipping)) data.supplierShipping = fields.supplierShipping;
  if (fields.notes != null && String(fields.notes).trim() !== "") data.notes = String(fields.notes).trim();

  return data;
}

function fieldLabel(field: string): string {
  switch (field) {
    case "title":
      return "Title";
    case "weight":
      return "Weight";
    case "weightOz":
      return "Weight Oz";
    case "supplierCost":
      return "Supplier Cost";
    case "supplierShipping":
      return "Supplier Shipping";
    case "notes":
      return "Notes";
    case "upc":
      return "UPC";
    case "upc_tpp_ebay":
      return "TPP eBay UPC";
    case "upc_tt_ebay":
      return "TT eBay UPC";
    case "upc_shopify":
      return "Shopify UPC";
    case "upc_bigcommerce":
      return "BigCommerce UPC";
    default:
      return field;
  }
}

function summarizeSuccess(args: {
  created: boolean;
  changedFields: string[];
  stagedUpcLabels: string[];
}): ImportSuccess["summary"] {
  const parts: string[] = [];

  if (args.created) {
    parts.push("Created row");
  }
  if (args.changedFields.length > 0) {
    parts.push(`Updated ${args.changedFields.join(", ")}`);
  }
  if (args.stagedUpcLabels.length > 0) {
    parts.push(`Staged ${args.stagedUpcLabels.join(", ")} for review`);
  }

  return parts.length > 0 ? parts.join(". ") : "No changes needed";
}

function computeImportImpact(args: {
  existing: ExistingImportRow | null;
  data: ReturnType<typeof collectImportedData>;
  importedUpcs: ImportedUpcValues;
  mode: Exclude<ImportMode, "preview">;
}) {
  const changedFields: string[] = [];
  let rowCreated = false;
  let stagedUpcLabels: string[] = [];

  if (args.existing) {
    if (args.mode === "overwrite") {
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined || value === null || value === "") continue;
        const current = args.existing[key as keyof ExistingImportRow];
        if (current !== value) {
          changedFields.push(fieldLabel(key));
        }
      }

      stagedUpcLabels = buildImportedUpcTargets({
        existing: args.existing,
        importedUpcs: args.importedUpcs,
      })
        .filter((target) => target.liveValue !== target.desiredValue)
        .map((target) => target.label);
    } else {
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined || value === null || value === "") continue;
        const current = args.existing[key as keyof ExistingImportRow];
        const isEmpty =
          current === null ||
          current === undefined ||
          (typeof current === "string" && current.trim() === "");
        if (isEmpty) {
          changedFields.push(fieldLabel(key));
        }
      }

      stagedUpcLabels = buildImportedUpcTargets({
        existing: args.existing,
        importedUpcs: args.importedUpcs,
      })
        .filter((target) => !target.liveValue)
        .map((target) => target.label);
    }
  } else {
    rowCreated = true;
    changedFields.push(...Object.keys(args.data).map(fieldLabel));
    if (args.importedUpcs.shared) {
      stagedUpcLabels = ["UPC"];
    }
  }

  stagedUpcLabels = [...new Set(stagedUpcLabels)];

  return {
    rowCreated,
    stagedUpcLabels,
    changedFields,
    outcome: rowCreated
      ? ("created" as const)
      : changedFields.length > 0 || stagedUpcLabels.length > 0
        ? ("updated" as const)
        : ("no_changes" as const),
    summary: summarizeSuccess({
      created: rowCreated,
      changedFields,
      stagedUpcLabels,
    }),
  };
}

async function loadExistingRowsBySku(skus: string[]) {
  if (skus.length === 0) {
    return new Map<string, ExistingImportRow>();
  }

  const rows = await db.masterRow.findMany({
    where: {
      sku: { in: skus },
    },
    select: {
      id: true,
      sku: true,
      title: true,
      upc: true,
      weight: true,
      weightOz: true,
      supplierCost: true,
      supplierShipping: true,
      notes: true,
      listings: {
        select: {
          id: true,
          integration: {
            select: {
              platform: true,
            },
          },
        },
      },
    },
  });

  return new Map(rows.map((row) => [row.sku, row]));
}

async function loadExistingStagedUpcChanges(masterRowIds: string[]) {
  if (masterRowIds.length === 0) {
    return new Map<string, StagedUpcSnapshot[]>();
  }

  const stagedChanges = await db.stagedChange.findMany({
    where: {
      masterRowId: { in: masterRowIds },
      field: "upc",
      status: "STAGED",
    },
    select: {
      masterRowId: true,
      marketplaceListingId: true,
      stagedValue: true,
      liveValue: true,
    },
    orderBy: [{ masterRowId: "asc" }, { createdAt: "asc" }],
  });

  const byMasterRowId = new Map<string, StagedUpcSnapshot[]>();
  for (const change of stagedChanges) {
    const bucket = byMasterRowId.get(change.masterRowId) ?? [];
    bucket.push({
      marketplaceListingId: change.marketplaceListingId,
      stagedValue: change.stagedValue,
      liveValue: change.liveValue,
    });
    byMasterRowId.set(change.masterRowId, bucket);
  }

  return byMasterRowId;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const mode = (formData.get("mode") as string) || "preview";
    const analysisMode = (formData.get("analysisMode") as string) || "fill_blanks";

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    const validTypes = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "application/vnd.ms-excel",
      "application/csv",
    ];
    if (!validTypes.includes(file.type) && !file.name.match(/\.(xlsx|xls|csv)$/i)) {
      return NextResponse.json(
        { error: "Invalid file type. Upload XLSX or CSV." },
        { status: 400 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const rawRows = parseRows(buf);
    const rows: { index: number; fields: Record<string, unknown>; valid: boolean; errors: string[] }[] = [];

    for (let i = 0; i < rawRows.length; i++) {
      const fields = mapRowToFields(rawRows[i] as Record<string, unknown>);
      const { valid, errors } = validateRow(fields, i + 1);
      rows.push({ index: i + 1, fields, valid, errors });
    }

    markDuplicateSkuErrors(rows);

    const validRows = rows.filter((r) => r.valid);
    const errorRows = rows.filter((r) => !r.valid);

    const resolvedMode: ImportMode = VALID_MODES.includes(mode as ImportMode)
      ? (mode as ImportMode)
      : "preview";
    const resolvedAnalysisMode: Exclude<ImportMode, "preview"> =
      analysisMode === "overwrite" ? "overwrite" : "fill_blanks";
    const existingRowsBySku = await loadExistingRowsBySku(
      [...new Set(validRows.map((row) => String(row.fields.sku ?? "").trim()).filter(Boolean))],
    );
    const existingStagedUpcChangesByMasterRowId = await loadExistingStagedUpcChanges(
      [...new Set([...existingRowsBySku.values()].map((row) => row.id))],
    );

    if (resolvedMode === "preview") {
      const impacts: ImportImpact[] = validRows.slice(0, 50).map((row) => {
        const sku = String(row.fields.sku ?? "").trim();
        const data = collectImportedData(row.fields);
        const importedUpcs = collectImportedUpcValues(row.fields);
        const impact = computeImportImpact({
          existing: existingRowsBySku.get(sku) ?? null,
          data,
          importedUpcs,
          mode: resolvedAnalysisMode,
        });

        return {
          row: row.index,
          sku,
          outcome: impact.outcome,
          summary: impact.summary,
          changedFields: [
            ...impact.changedFields,
            ...impact.stagedUpcLabels,
          ],
        };
      });

      const impactCounts = validRows.reduce(
        (counts, row) => {
          const sku = String(row.fields.sku ?? "").trim();
          const data = collectImportedData(row.fields);
          const importedUpcs = collectImportedUpcValues(row.fields);
          const impact = computeImportImpact({
            existing: existingRowsBySku.get(sku) ?? null,
            data,
            importedUpcs,
            mode: resolvedAnalysisMode,
          });

          counts[impact.outcome] += 1;
          return counts;
        },
        { created: 0, updated: 0, no_changes: 0 },
      );

      return NextResponse.json({
        data: {
          fileName: file.name,
          size: file.size,
          mode: "preview",
          status: "preview",
          analysisMode: resolvedAnalysisMode,
          validRows: validRows.length,
          errorRows: errorRows.length,
          preview: validRows.slice(0, 20).map((r) => ({ row: r.index, ...r.fields })),
          impacts,
          impactCounts,
          errors: errorRows.slice(0, 50).map((r) => ({ row: r.index, errors: r.errors })),
        },
      });
    }

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    const applyErrors: { row: number; error: string }[] = [];
    const successes: ImportSuccess[] = [];
    const undoOperations: ImportUndoOperation[] = [];
    const failures: ImportFailure[] = errorRows.map((row) => ({
      row: row.index,
      sku: String(row.fields.sku ?? "").trim(),
      error: row.errors.join("; "),
      fields: buildDownloadRow(row.fields, row.errors.join("; ")),
    }));
    const systemUser = await getSystemUser();

    const APPLY_CHUNK = 10;
    for (let ci = 0; ci < validRows.length; ci += APPLY_CHUNK) {
      const chunk = validRows.slice(ci, ci + APPLY_CHUNK);
      await Promise.all(chunk.map(async ({ index, fields }) => {
        const sku = String(fields.sku ?? "").trim();
        if (!sku) return;
        try {
          let existing = existingRowsBySku.get(sku) ?? null;
          const previousValues = existing ? snapshotRowValues(existing) : null;
          const previousStagedUpcChanges = existing
            ? (existingStagedUpcChangesByMasterRowId.get(existing.id) ?? []).map((entry) => ({ ...entry }))
            : [];
          const data = collectImportedData(fields);
          const importedUpcs = collectImportedUpcValues(fields);
          const impact = computeImportImpact({
            existing,
            data,
            importedUpcs,
            mode: resolvedMode,
          });
          let rowCreated = impact.rowCreated;
          let stagedUpcLabels: string[] = [];
          const changedFields: string[] = [];

          if (resolvedMode === "overwrite") {
            let masterRow;
            if (existing) {
              const patch: Record<string, string | number> = {};
              for (const [key, value] of Object.entries(data)) {
                if (value === undefined || value === null || value === "") continue;
                const current = existing[key as keyof typeof existing];
                if (current !== value) {
                  patch[key] = value as string | number;
                  changedFields.push(fieldLabel(key));
                }
              }

              masterRow = Object.keys(patch).length > 0
                ? await db.masterRow.update({
                    where: { sku },
                    data: patch,
                    include: {
                      listings: {
                        select: {
                          id: true,
                          integration: { select: { platform: true } },
                        },
                      },
                    },
                  })
                : existing;
              existingRowsBySku.set(sku, masterRow);
            } else {
              rowCreated = true;
              changedFields.push(...Object.keys(data).map(fieldLabel));
              masterRow = await db.masterRow.create({
                data: { sku, ...data },
                include: {
                  listings: {
                    select: {
                      id: true,
                      integration: { select: { platform: true } },
                    },
                  },
                },
              });
              existingRowsBySku.set(sku, masterRow);
            }

            stagedUpcLabels = await replaceTargetedImportedUpcStages({
              masterRowId: masterRow.id,
              changedById: systemUser.id,
              targets: buildImportedUpcTargets({
                existing: masterRow,
                importedUpcs,
              }),
              mode: resolvedMode,
            });

            if (
              existing &&
              (rowCreated || changedFields.length > 0 || stagedUpcLabels.length > 0 || previousStagedUpcChanges.length > 0)
            ) {
              undoOperations.push({
                kind: "restore_existing",
                masterRowId: existing.id,
                sku,
                previousValues: previousValues!,
                previousStagedUpcChanges,
              });
            }

            if (rowCreated) {
              created++;
              undoOperations.push({
                kind: "delete_created",
                masterRowId: masterRow.id,
                sku,
              });
            } else if (changedFields.length > 0 || stagedUpcLabels.length > 0) {
              updated++;
            } else {
              unchanged++;
            }
          } else {
            if (existing) {
              const patch: Record<string, string | number | null> = {};
              for (const [key, value] of Object.entries(data)) {
                if (value === undefined || value === null || value === "") continue;
                const current = existing[key as keyof typeof existing];
                const isEmpty =
                  current === null ||
                  current === undefined ||
                  (typeof current === "string" && current.trim() === "");
                if (isEmpty) {
                  patch[key] = value as string | number | null;
                  changedFields.push(fieldLabel(key));
                }
              }
              if (Object.keys(patch).length > 0) {
                existing = await db.masterRow.update({
                  where: { sku },
                  data: patch,
                  select: {
                    id: true,
                    sku: true,
                    title: true,
                    upc: true,
                    weight: true,
                    weightOz: true,
                    supplierCost: true,
                    supplierShipping: true,
                    notes: true,
                    listings: {
                      select: {
                        id: true,
                        integration: { select: { platform: true } },
                      },
                    },
                  },
                });
                existingRowsBySku.set(sku, existing);
              }

              stagedUpcLabels = await replaceTargetedImportedUpcStages({
                masterRowId: existing.id,
                changedById: systemUser.id,
                targets: buildImportedUpcTargets({
                  existing,
                  importedUpcs,
                }),
                mode: resolvedMode,
              });

              if (changedFields.length > 0 || stagedUpcLabels.length > 0 || previousStagedUpcChanges.length > 0) {
                undoOperations.push({
                  kind: "restore_existing",
                  masterRowId: existing.id,
                  sku,
                  previousValues: previousValues!,
                  previousStagedUpcChanges,
                });
              }

              if (changedFields.length > 0 || stagedUpcLabels.length > 0) {
                updated++;
              } else {
                unchanged++;
              }
            } else {
              const masterRow = await db.masterRow.create({ data: { sku, ...data } });
              rowCreated = true;
              changedFields.push(...Object.keys(data).map(fieldLabel));
              stagedUpcLabels = await replaceTargetedImportedUpcStages({
                masterRowId: masterRow.id,
                changedById: systemUser.id,
                targets: buildImportedUpcTargets({
                  existing: null,
                  importedUpcs,
                }),
                mode: resolvedMode,
              });
              existingRowsBySku.set(sku, {
                id: masterRow.id,
                sku: masterRow.sku,
                title: masterRow.title,
                upc: masterRow.upc,
                weight: masterRow.weight,
                weightOz: masterRow.weightOz,
                supplierCost: masterRow.supplierCost,
                supplierShipping: masterRow.supplierShipping,
                notes: masterRow.notes,
                listings: [],
              });
              created++;
              undoOperations.push({
                kind: "delete_created",
                masterRowId: masterRow.id,
                sku,
              });
            }
          }

          successes.push({
            row: index,
            sku,
            outcome: rowCreated ? "created" : changedFields.length > 0 || stagedUpcLabels.length > 0 ? "updated" : "no_changes",
            summary: summarizeSuccess({
              created: rowCreated,
              changedFields,
              stagedUpcLabels,
            }),
            changedFields: [
              ...changedFields,
              ...stagedUpcLabels,
            ],
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          applyErrors.push({
            row: index,
            error: message,
          });
          failures.push({
            row: index,
            sku,
            error: message,
            fields: buildDownloadRow(fields, message),
          });
        }
      }));
    }

    const importAuditLog = await db.auditLog.create({
      data: {
        userId: systemUser.id,
        action: "import_completed",
        entityType: "import",
        entityId: file.name,
        details: {
          fileName: file.name,
          mode: resolvedMode,
          validRows: validRows.length,
          invalidRows: errorRows.length,
          created,
          updated,
          unchanged,
          failed: failures.length,
          duplicateSkuFailures: failures.filter((failure) =>
            failure.error.toLowerCase().includes("duplicate sku"),
          ).length,
          undoAvailable: undoOperations.length > 0,
          undoAppliedAt: null,
          undoOperations,
          successPreview: successes.slice(0, 20),
          failurePreview: failures.slice(0, 20).map((failure) => ({
            row: failure.row,
            sku: failure.sku,
            error: failure.error,
          })),
        } as const,
      },
    });

    return NextResponse.json({
      data: {
        fileName: file.name,
        mode: resolvedMode,
        status: "completed",
        validRows: validRows.length,
        errorRows: errorRows.length,
        created,
        updated,
        unchanged,
        undoAuditLogId: undoOperations.length > 0 ? importAuditLog.id : null,
        applyErrors: applyErrors.slice(0, 100),
        successes,
        failures,
      },
    });
  } catch (error) {
    console.error("[import] Failed to process import", error);
    await db.auditLog.create({
      data: {
        action: "import_failed",
        entityType: "import",
        details: {
          error: error instanceof Error ? error.message : "Failed to process import",
        },
      },
    }).catch(() => undefined);
    return NextResponse.json(
      { error: "Failed to process import" },
      { status: 500 }
    );
  }
}
