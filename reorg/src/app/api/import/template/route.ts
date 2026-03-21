import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

const TEMPLATE_ROWS = [
  {
    sku: "EXAMPLE-SKU-001",
    upc: "850027678160",
    weight: "5",
    supplier_cost: 12.5,
    supplier_shipping_cost: 3.25,
    notes: "Internal notes only. This does not push to marketplaces.",
  },
  {
    sku: "EXAMPLE-SKU-002",
    upc: "",
    weight: "2LBS",
    supplier_cost: 28,
    supplier_shipping_cost: 7.5,
    notes: "Blank optional cells are ignored. They do not delete existing values.",
  },
];

export async function GET() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(TEMPLATE_ROWS, {
    header: ["sku", "upc", "weight", "supplier_cost", "supplier_shipping_cost", "notes"],
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, "import-template");

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["reorG Import Template"],
    [""],
    ["Required column", "sku"],
    ["Supported columns", "upc, weight, supplier_cost, supplier_shipping_cost, notes"],
    ["UPC behavior", "Blank UPC cells are ignored. Filled UPC values are staged for review, not pushed live automatically."],
    ["Weight format", "1-16 for ounces, 2LBS-10LBS for pounds"],
    ["Notes field", "Internal free-text notes stored on the master row inside reorG."],
    ["Recommended mode", "Fill blanks only for safe first-time imports"],
  ]);
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "instructions");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  });

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="reorg-import-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
