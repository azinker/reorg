import { NextResponse, type NextRequest } from "next/server";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";

const VALID_MODES = ["preview", "fill_blanks", "overwrite"] as const;
type ImportMode = (typeof VALID_MODES)[number];

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

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const mode = (formData.get("mode") as string) || "preview";

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

    const validRows = rows.filter((r) => r.valid);
    const errorRows = rows.filter((r) => !r.valid);

    const resolvedMode: ImportMode = VALID_MODES.includes(mode as ImportMode)
      ? (mode as ImportMode)
      : "preview";

    if (resolvedMode === "preview") {
      return NextResponse.json({
        data: {
          fileName: file.name,
          size: file.size,
          mode: "preview",
          status: "preview",
          validRows: validRows.length,
          errorRows: errorRows.length,
          preview: validRows.slice(0, 20).map((r) => ({ row: r.index, ...r.fields })),
          errors: errorRows.slice(0, 50).map((r) => ({ row: r.index, errors: r.errors })),
        },
      });
    }

    let created = 0;
    let updated = 0;
    const applyErrors: { row: number; error: string }[] = [];

    for (const { index, fields } of validRows) {
      const sku = String(fields.sku ?? "").trim();
      if (!sku) continue;
      try {
        const existing = await db.masterRow.findUnique({
          where: { sku },
        });

        const data: {
          title?: string;
          weight?: string;
          weightOz?: number;
          supplierCost?: number;
          supplierShipping?: number;
          notes?: string;
          upc?: string;
        } = {};

        if (fields.title != null && String(fields.title).trim() !== "") data.title = String(fields.title).trim();
        if (fields.weight != null && String(fields.weight).trim() !== "") data.weight = String(fields.weight).trim();
        if (typeof fields.weightOz === "number" && Number.isFinite(fields.weightOz)) data.weightOz = fields.weightOz;
        if (typeof fields.supplierCost === "number" && Number.isFinite(fields.supplierCost)) data.supplierCost = fields.supplierCost;
        if (typeof fields.supplierShipping === "number" && Number.isFinite(fields.supplierShipping)) data.supplierShipping = fields.supplierShipping;
        if (fields.notes != null && String(fields.notes).trim() !== "") data.notes = String(fields.notes).trim();
        if (fields.upc != null && String(fields.upc).trim() !== "") data.upc = String(fields.upc).trim();

        if (resolvedMode === "overwrite") {
          await db.masterRow.upsert({
            where: { sku },
            create: { sku, ...data },
            update: data,
          });
          if (existing) updated++; else created++;
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
              if (isEmpty) patch[key] = value as string | number | null;
            }
            if (Object.keys(patch).length > 0) {
              await db.masterRow.update({ where: { sku }, data: patch });
              updated++;
            }
          } else {
            await db.masterRow.create({ data: { sku, ...data } });
            created++;
          }
        }
      } catch (err) {
        applyErrors.push({
          row: index,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    return NextResponse.json({
      data: {
        fileName: file.name,
        mode: resolvedMode,
        status: "completed",
        validRows: validRows.length,
        errorRows: errorRows.length,
        created,
        updated,
        applyErrors: applyErrors.slice(0, 100),
      },
    });
  } catch (error) {
    console.error("[import] Failed to process import", error);
    return NextResponse.json(
      { error: "Failed to process import" },
      { status: 500 }
    );
  }
}
