import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { getCatalogHealthData } from "@/lib/services/ops-insights";
import { queueCurrentRequestBinaryResponseSample } from "@/lib/services/network-transfer-samples";

type ImportTemplateRow = {
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

type CatalogIssueSummaryRow = {
  sku: string;
  title: string;
  issues: string;
  priority_score: number;
  linked_listings: number;
};

function asCellValue(value: string | number | null | undefined) {
  if (value == null) return "";
  return String(value);
}

function buildImportWorksheet(rows: ImportTemplateRow[]) {
  const worksheet = XLSX.utils.json_to_sheet(rows, {
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
  return worksheet;
}

function buildInstructionsSheet(lines: string[][]) {
  const instructionsSheet = XLSX.utils.aoa_to_sheet(lines);
  instructionsSheet["!cols"] = [{ wch: 28 }, { wch: 110 }];
  return instructionsSheet;
}

export async function GET(request: NextRequest) {
  const scope = request.nextUrl.searchParams.get("scope") === "catalog-health"
    ? "catalog-health"
    : "missing-parameters";

  let importRows: ImportTemplateRow[] = [];
  const workbook = XLSX.utils.book_new();
  let fileName = "reorg-missing-parameters.xlsx";
  let telemetryRowCount = 0;

  if (scope === "catalog-health") {
    const data = await getCatalogHealthData();
    importRows = data.attentionRows.map((row) => ({
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
    telemetryRowCount = importRows.length;
    fileName = "reorg-catalog-health-import.xlsx";

    XLSX.utils.book_append_sheet(
      workbook,
      buildImportWorksheet(importRows),
      "catalog-health-import",
    );

    const issueRows: CatalogIssueSummaryRow[] = data.attentionRows.map((row) => ({
      sku: row.sku,
      title: row.title,
      issues: row.issueLabels.join(", "),
      priority_score: row.issueScore,
      linked_listings: row.platformCount,
    }));
    const issueSheet = XLSX.utils.json_to_sheet(issueRows, {
      header: ["sku", "title", "issues", "priority_score", "linked_listings"],
    });
    issueSheet["!cols"] = [
      { wch: 26 },
      { wch: 52 },
      { wch: 54 },
      { wch: 16 },
      { wch: 16 },
    ];
    XLSX.utils.book_append_sheet(workbook, issueSheet, "issue-summary");

    XLSX.utils.book_append_sheet(
      workbook,
      buildInstructionsSheet([
        ["reorG Catalog Health Export"],
        [""],
        ["Purpose", "Fill in the blanks on the catalog-health-import sheet and reimport it on the Import page."],
        ["Included rows", "Every SKU currently flagged on the Catalog Health page, not just the highest-priority rows."],
        ["Import-ready sheet", "Use only the catalog-health-import sheet for manual updates and re-imports."],
        ["Issue summary sheet", "The issue-summary sheet is for reference only so you can see why each SKU was included."],
        ["Compatible import columns", "sku, upc, upc_tpp_ebay, upc_tt_ebay, upc_shopify, upc_bigcommerce, weight, supplier_cost, supplier_shipping_cost"],
        ["Shared UPC behavior", "Filled upc values stage linked marketplace UPC updates for review. They do not auto-push live."],
        ["Marketplace UPC overrides", "Leave the marketplace-specific UPC columns blank unless that store needs a different UPC than the shared row UPC."],
        ["Weight format", "Use 1-16 for ounces or 2LBS-10LBS for pounds."],
        ["Important", "Missing images, title mismatches, and shipping-rate-table gaps may still need work outside the Import page even though the SKU appears here."],
      ]),
      "instructions",
    );
  } else {
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

    importRows = rows.map((row) => ({
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
    telemetryRowCount = importRows.length;

    XLSX.utils.book_append_sheet(
      workbook,
      buildImportWorksheet(importRows),
      "missing-parameters",
    );

    XLSX.utils.book_append_sheet(
      workbook,
      buildInstructionsSheet([
        ["reorG Missing Parameters Export"],
        [""],
        ["Purpose", "Fill in the blanks and reimport this workbook on the Import page."],
        ["Included rows", "Only active SKUs missing UPC, weight, supplier cost, or supplier shipping cost."],
        ["Compatible import columns", "sku, upc, upc_tpp_ebay, upc_tt_ebay, upc_shopify, upc_bigcommerce, weight, supplier_cost, supplier_shipping_cost"],
        ["Shared UPC behavior", "Filled upc values stage linked marketplace UPC updates for review. They do not auto-push live."],
        ["Marketplace UPC overrides", "Leave the marketplace-specific UPC columns blank unless that store needs a different UPC than the shared row UPC."],
        ["Weight format", "Use 1-16 for ounces or 2LBS-10LBS for pounds."],
        ["Tip", "Leave cells blank if you do not want to change them on reimport."],
      ]),
      "instructions",
    );
  }

  const buffer = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  });

  queueCurrentRequestBinaryResponseSample({
    bytesEstimate: buffer.length,
    metadata: {
      rowCount: telemetryRowCount,
      scope,
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  });

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
