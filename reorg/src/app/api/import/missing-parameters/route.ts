import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";

type MissingParameterRow = {
  sku: string;
  upc: string;
  upc_tpp_ebay: string;
  upc_tt_ebay: string;
  upc_shopify: string;
  upc_bigcommerce: string;
  weight: string;
  supplier_cost: string;
  supplier_shipping_cost: string;
};

function asCellValue(value: string | number | null | undefined) {
  if (value == null) return "";
  return String(value);
}

export async function GET() {
  const rows = await db.masterRow.findMany({
    where: {
      isActive: true,
      OR: [
        { upc: null },
        { upc: "" },
        { weight: null },
        { weight: "" },
        { supplierCost: null },
        { supplierShipping: null },
      ],
    },
    select: {
      sku: true,
      upc: true,
      weight: true,
      supplierCost: true,
      supplierShipping: true,
    },
    orderBy: { sku: "asc" },
  });

  const workbook = XLSX.utils.book_new();
  const worksheetRows: MissingParameterRow[] = rows.map((row) => ({
    sku: row.sku,
    upc: asCellValue(row.upc),
    upc_tpp_ebay: "",
    upc_tt_ebay: "",
    upc_shopify: "",
    upc_bigcommerce: "",
    weight: asCellValue(row.weight),
    supplier_cost: asCellValue(row.supplierCost),
    supplier_shipping_cost: asCellValue(row.supplierShipping),
  }));

  const worksheet = XLSX.utils.json_to_sheet(worksheetRows, {
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
    ],
  });
  worksheet["!cols"] = [
    { wch: 26 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 20 },
    { wch: 14 },
    { wch: 16 },
    { wch: 22 },
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, "missing-parameters");

  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["reorG Missing Parameters Export"],
    [""],
    ["Purpose", "Fill in the blanks and reimport this workbook on the Import page."],
    ["Included rows", "Only active SKUs missing UPC, weight, supplier cost, or supplier shipping cost."],
    ["Compatible import columns", "sku, upc, upc_tpp_ebay, upc_tt_ebay, upc_shopify, upc_bigcommerce, weight, supplier_cost, supplier_shipping_cost"],
    ["Shared UPC behavior", "Filled upc values stage linked marketplace UPC updates for review. They do not auto-push live."],
    ["Marketplace UPC overrides", "Leave the marketplace-specific UPC columns blank unless that store needs a different UPC than the shared row UPC."],
    ["Weight format", "Use 1-16 for ounces or 2LBS-10LBS for pounds."],
    ["Tip", "Leave cells blank if you do not want to change them on reimport."],
  ]);
  instructionsSheet["!cols"] = [{ wch: 24 }, { wch: 96 }];
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
      "Content-Disposition": 'attachment; filename="reorg-missing-parameters.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
