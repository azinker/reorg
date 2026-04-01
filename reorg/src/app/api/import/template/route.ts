import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";

const TEMPLATE_ROWS = [
  {
    sku: "EXAMPLE-SKU-001",
    upc: "850027678160",
    upc_tpp_ebay: "",
    upc_tt_ebay: "",
    upc_shopify: "",
    upc_bigcommerce: "",
    weight: "5",
    supplier_cost: 12.5,
    supplier_shipping_cost: 3.25,
    notes: "Internal notes only. This does not push to marketplaces.",
  },
  {
    sku: "EXAMPLE-SKU-002",
    upc: "",
    upc_tpp_ebay: "850027678160",
    upc_tt_ebay: "",
    upc_shopify: "850027678199",
    upc_bigcommerce: "",
    weight: "2LBS",
    supplier_cost: 28,
    supplier_shipping_cost: 7.5,
    notes: "Blank optional cells are ignored. Marketplace-specific UPC columns override the shared UPC only for that store.",
  },
];

export async function GET() {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(TEMPLATE_ROWS, {
    header: [
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
    ],
  });
  XLSX.utils.book_append_sheet(workbook, worksheet, "import-template");

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["reorG Import Template"],
    [""],
    ["Required column", "sku"],
    ["Supported columns", "upc, upc_tpp_ebay, upc_tt_ebay, upc_shopify, upc_bigcommerce, weight, supplier_cost, supplier_shipping_cost, notes"],
    ["Shared UPC behavior", "Filled upc values are staged for connected marketplaces on the row for review. They do not auto-push live."],
    ["Marketplace UPC overrides", "Use the marketplace-specific UPC columns only when a store needs a different UPC than the shared row UPC."],
    ["Weight format", "1-16 for ounces, 2LBS-10LBS for pounds"],
    ["Notes field", "Internal free-text notes stored on the master row inside reorG."],
    ["Recommended mode", "Fill blanks only for safe first-time imports"],
  ]);
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "instructions");

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  });

  queueCurrentRequestBinaryResponseSample({
    bytesEstimate: buffer.length,
    metadata: {
      rowCount: TEMPLATE_ROWS.length,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
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
