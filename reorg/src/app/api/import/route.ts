import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { Platform } from "@prisma/client";

const VALID_MODES = ["preview", "fill_blanks", "overwrite"] as const;
type ImportMode = (typeof VALID_MODES)[number];

const IMPORT_FIELD_HEADERS = [
  "sku",
  "upc",
  "weight",
  "supplier_cost",
  "supplier_shipping_cost",
  "notes",
] as const;

type ImportDownloadRow = {
  sku: string;
  upc: string;
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
    integration: {
      platform: Platform;
    };
  }>;
};

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
    weight: "",
    supplier_cost: "",
    supplier_shipping_cost: "",
    notes: "",
  };

  row.sku = String(fields.sku ?? "").trim();
  row.upc = String(fields.upc ?? "").trim();
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

async function stageImportedUpc(args: {
  masterRowId: string;
  importedUpc: string;
  changedById: string;
  listingIds: string[];
}) {
  await db.stagedChange.updateMany({
    where: {
      masterRowId: args.masterRowId,
      field: "upc",
      status: "STAGED",
    },
    data: { status: "CANCELLED" },
  });

  if (args.listingIds.length === 0) {
    await db.stagedChange.create({
      data: {
        masterRowId: args.masterRowId,
        field: "upc",
        stagedValue: args.importedUpc,
        liveValue: null,
        changedById: args.changedById,
      },
    });
    return;
  }

  await db.stagedChange.createMany({
    data: args.listingIds.map((listingId) => ({
      masterRowId: args.masterRowId,
      marketplaceListingId: listingId,
      field: "upc",
      stagedValue: args.importedUpc,
      liveValue: null,
      changedById: args.changedById,
    })),
  });
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
    default:
      return field;
  }
}

function summarizeSuccess(args: {
  created: boolean;
  changedFields: string[];
  upcStaged: boolean;
}): ImportSuccess["summary"] {
  const parts: string[] = [];

  if (args.created) {
    parts.push("Created row");
  }
  if (args.changedFields.length > 0) {
    parts.push(`Updated ${args.changedFields.join(", ")}`);
  }
  if (args.upcStaged) {
    parts.push("Staged UPC for review");
  }

  return parts.length > 0 ? parts.join(". ") : "No changes needed";
}

function computeImportImpact(args: {
  existing: ExistingImportRow | null;
  data: ReturnType<typeof collectImportedData>;
  importedUpc: string | null;
  mode: Exclude<ImportMode, "preview">;
}) {
  const changedFields: string[] = [];
  let rowCreated = false;
  let upcStaged = false;

  if (args.existing) {
    if (args.mode === "overwrite") {
      for (const [key, value] of Object.entries(args.data)) {
        if (value === undefined || value === null || value === "") continue;
        const current = args.existing[key as keyof ExistingImportRow];
        if (current !== value) {
          changedFields.push(fieldLabel(key));
        }
      }

      const liveUpc = args.existing.upc?.trim() || null;
      if (args.importedUpc && liveUpc !== args.importedUpc) {
        upcStaged = true;
      }
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

      const liveUpc = args.existing.upc?.trim() || null;
      if (args.importedUpc && !liveUpc) {
        upcStaged = true;
      }
    }
  } else {
    rowCreated = true;
    changedFields.push(...Object.keys(args.data).map(fieldLabel));
    if (args.importedUpc) {
      upcStaged = true;
    }
  }

  return {
    rowCreated,
    upcStaged,
    changedFields,
    outcome: rowCreated
      ? ("created" as const)
      : changedFields.length > 0 || upcStaged
        ? ("updated" as const)
        : ("no_changes" as const),
    summary: summarizeSuccess({
      created: rowCreated,
      changedFields,
      upcStaged,
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

    if (resolvedMode === "preview") {
      const impacts: ImportImpact[] = validRows.slice(0, 50).map((row) => {
        const sku = String(row.fields.sku ?? "").trim();
        const data = collectImportedData(row.fields);
        const importedUpc =
          row.fields.upc != null && String(row.fields.upc).trim() !== ""
            ? String(row.fields.upc).trim()
            : null;
        const impact = computeImportImpact({
          existing: existingRowsBySku.get(sku) ?? null,
          data,
          importedUpc,
          mode: resolvedAnalysisMode,
        });

        return {
          row: row.index,
          sku,
          outcome: impact.outcome,
          summary: impact.summary,
          changedFields: [
            ...impact.changedFields,
            ...(impact.upcStaged ? ["UPC"] : []),
          ],
        };
      });

      const impactCounts = validRows.reduce(
        (counts, row) => {
          const sku = String(row.fields.sku ?? "").trim();
          const data = collectImportedData(row.fields);
          const importedUpc =
            row.fields.upc != null && String(row.fields.upc).trim() !== ""
              ? String(row.fields.upc).trim()
              : null;
          const impact = computeImportImpact({
            existing: existingRowsBySku.get(sku) ?? null,
            data,
            importedUpc,
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
    const failures: ImportFailure[] = errorRows.map((row) => ({
      row: row.index,
      sku: String(row.fields.sku ?? "").trim(),
      error: row.errors.join("; "),
      fields: buildDownloadRow(row.fields, row.errors.join("; ")),
    }));
    const systemUser = await getSystemUser();

    for (const { index, fields } of validRows) {
      const sku = String(fields.sku ?? "").trim();
      if (!sku) continue;
      try {
        let existing = existingRowsBySku.get(sku) ?? null;
        const data = collectImportedData(fields);
        const importedUpc =
          fields.upc != null && String(fields.upc).trim() !== ""
            ? String(fields.upc).trim()
            : null;
        const impact = computeImportImpact({
          existing,
          data,
          importedUpc,
          mode: resolvedMode,
        });
        let rowCreated = impact.rowCreated;
        let upcStaged = false;
        const changedFields = [...impact.changedFields];

        const supportedPlatforms = new Set<Platform>([
          Platform.TPP_EBAY,
          Platform.TT_EBAY,
          Platform.BIGCOMMERCE,
          Platform.SHOPIFY,
        ]);

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

          if (importedUpc) {
            const liveUpc = masterRow.upc?.trim() || null;
            if (liveUpc !== importedUpc) {
              const supportedListingIds = masterRow.listings
                .filter((listing) => supportedPlatforms.has(listing.integration.platform))
                .map((listing) => listing.id);
              await stageImportedUpc({
                masterRowId: masterRow.id,
                importedUpc,
                changedById: systemUser.id,
                listingIds: supportedListingIds,
              });
              upcStaged = true;
            } else {
              await db.stagedChange.updateMany({
                where: {
                  masterRowId: masterRow.id,
                  field: "upc",
                  status: "STAGED",
                },
              data: { status: "CANCELLED" },
              });
            }
          }

          if (rowCreated) {
            created++;
          } else if (changedFields.length > 0 || upcStaged) {
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

            if (importedUpc) {
              const liveUpc = existing.upc?.trim() || null;
              if (!liveUpc) {
                const supportedListingIds = existing.listings
                  .filter((listing) => supportedPlatforms.has(listing.integration.platform))
                  .map((listing) => listing.id);
                await stageImportedUpc({
                  masterRowId: existing.id,
                  importedUpc,
                  changedById: systemUser.id,
                  listingIds: supportedListingIds,
                });
                upcStaged = true;
              }
            }

            if (changedFields.length > 0 || upcStaged) {
              updated++;
            } else {
              unchanged++;
            }
          } else {
            const masterRow = await db.masterRow.create({ data: { sku, ...data } });
            rowCreated = true;
            changedFields.push(...Object.keys(data).map(fieldLabel));
            if (importedUpc) {
              await stageImportedUpc({
                masterRowId: masterRow.id,
                importedUpc,
                changedById: systemUser.id,
                listingIds: [],
              });
              upcStaged = true;
            }
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
          }
        }

        successes.push({
          row: index,
          sku,
          outcome: rowCreated ? "created" : changedFields.length > 0 || upcStaged ? "updated" : "no_changes",
          summary: summarizeSuccess({
            created: rowCreated,
            changedFields,
            upcStaged,
          }),
          changedFields: [
            ...changedFields,
            ...(upcStaged ? ["UPC"] : []),
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
    }

    await db.auditLog.create({
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
