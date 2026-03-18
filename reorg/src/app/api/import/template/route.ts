import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

const TEMPLATE_ROWS = [
  {
    sku: "EXAMPLE-SKU-001",
    weight: "5",
    supplier_cost: 12.5,
    supplier_shipping_cost: 3.25,
    notes: "Use 1-16 for ounces or 2LBS-10LBS for pounds.",
  },
  {
    sku: "EXAMPLE-SKU-002",
    weight: "2LBS",
    supplier_cost: 28,
    supplier_shipping_cost: 7.5,
    notes: "Leave cells blank if you only want to fill missing values.",
  },
];

export async function GET() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(TEMPLATE_ROWS, {
    header: ["sku", "weight", "supplier_cost", "supplier_shipping_cost", "notes"],
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, "import-template");

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["reorG Import Template"],
    [""],
    ["Required column", "sku"],
    ["Supported columns", "weight, supplier_cost, supplier_shipping_cost, notes"],
    ["Weight format", "1-16 for ounces, 2LBS-10LBS for pounds"],
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
